import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import type { Subprocess, Terminal as BunTerminal } from 'bun';
import { Client } from 'ssh2';
import { decrypt } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { TmuxControlParser, type TmuxEvent, type TmuxOutputBlock } from './parser';

export interface TmuxConnectionOptions {
  deviceId: string;
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onSnapshot: (payload: StateSnapshotPayload) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export class TmuxConnection {
  private deviceId: string;
  private device: Device | null = null;
  private subprocess: Subprocess | null = null;
  private terminal: BunTerminal | null = null;
  private sshClient: Client | null = null;
  private sshStream: unknown | null = null;
  private parser: TmuxControlParser;
  private onEvent: (event: TmuxEvent) => void;
  private onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  private onSnapshot: (payload: StateSnapshotPayload) => void;
  private onError: (error: Error) => void;
  private onClose: () => void;
  private activePaneId: string | null = null;
  private connected = false;

  private ready = false;
  private readyFailed = false;
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private startupNonControlOutput: string[] = [];

  private lastExitReason: string | null = null;

  private pendingCommandKinds: Array<'snapshot-session' | 'snapshot-windows' | 'snapshot-panes'> = [];
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private snapshotPanesReady = false;

  constructor(options: TmuxConnectionOptions) {
    this.deviceId = options.deviceId;
    this.onEvent = options.onEvent;
    this.onTerminalOutput = options.onTerminalOutput;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError;
    this.onClose = options.onClose;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.parser = new TmuxControlParser({
      onEvent: (event) => this.handleTmuxEvent(event),
      onTerminalOutput: (paneId, data) => this.onTerminalOutput(paneId, data),
      onOutputBlock: (block) => this.handleOutputBlock(block),
      onNonControlOutput: (line) => this.handleNonControlOutput(line),
      onReady: () => this.markReady(),
      onExit: (reason) => {
        this.lastExitReason = reason;
        if (!this.ready) {
          this.failReady(new Error(reason ? `tmux exited: ${reason}` : 'tmux exited'));
        }
      },
    });
  }

  private markReady(): void {
    if (this.ready || this.readyFailed) return;
    this.ready = true;
    this.resolveReady?.();
    this.resolveReady = null;
    this.rejectReady = null;
    this.startupNonControlOutput = [];
  }

  private failReady(error: Error): void {
    if (this.ready || this.readyFailed) return;
    this.readyFailed = true;

    const detail = this.startupNonControlOutput.filter(Boolean).join('\n');
    const nextError = detail ? new Error(`${error.message}\n${detail}`) : error;

    this.rejectReady?.(nextError);
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private waitForReady(timeoutMs = 5000): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = this.startupNonControlOutput.filter(Boolean).join('\n');
        reject(
          new Error(detail ? `tmux control mode not ready: ${detail}` : 'tmux control mode not ready')
        );
      }, timeoutMs);

      this.readyPromise
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async connect(): Promise<void> {
    this.device = getDeviceById(this.deviceId);
    if (!this.device) {
      throw new Error(`Device not found: ${this.deviceId}`);
    }

    if (this.device.type === 'local') {
      await this.connectLocal();
    } else {
      await this.connectSSH();
    }
  }

  private async connectLocal(): Promise<void> {
    const sessionName = this.device?.session ?? 'tmex';
    
    // 使用 Bun.spawn 启动本地 tmux -CC，分配伪终端
    this.subprocess = Bun.spawn(['tmux', '-CC', 'new-session', '-A', '-s', sessionName], {
      terminal: {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        data: (_term, data) => {
          this.parser.processData(data);
        },
        exit: () => {
          if (!this.ready) {
            this.failReady(new Error('tmux terminal closed before ready'));
          }
          if (this.lastExitReason) {
            this.onError(new Error(`tmux exited: ${this.lastExitReason}`));
          }
          this.cleanup();
          this.onClose();
        },
      },
    });

    this.terminal = this.subprocess.terminal ?? null;
    this.connected = true;

    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
    });

    try {
      await this.waitForReady();
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  private async connectSSH(): Promise<void> {
    if (!this.device) return;

    const conn = new Client();
    this.sshClient = conn;

    const host = this.device.host;
    const port = this.device.port ?? 22;
    const username = this.device.username;
    const sessionName = this.device.session ?? 'tmex';

    if (!host) {
      throw new Error('SSH device missing host');
    }

    // 准备认证配置
    const authConfig: {
      host: string;
      port: number;
      username: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      agent?: string;
    } = {
      host,
      port,
      username: username ?? 'root',
    };

    // 根据 authMode 准备认证
    switch (this.device.authMode) {
      case 'password': {
        if (this.device.passwordEnc) {
          authConfig.password = await decrypt(this.device.passwordEnc);
        }
        break;
      }
      case 'key': {
        if (this.device.privateKeyEnc) {
          authConfig.privateKey = await decrypt(this.device.privateKeyEnc);
          if (this.device.privateKeyPassphraseEnc) {
            authConfig.passphrase = await decrypt(this.device.privateKeyPassphraseEnc);
          }
        }
        break;
      }
      case 'agent': {
        const agentSocket = process.env.SSH_AUTH_SOCK;
        if (agentSocket) {
          authConfig.agent = agentSocket;
        }
        break;
      }
      case 'configRef': {
        // 使用 ssh config 中的配置，这里不额外设置
        break;
      }
      case 'auto': {
        // 尝试多种方式
        if (this.device.privateKeyEnc) {
          authConfig.privateKey = await decrypt(this.device.privateKeyEnc);
        } else if (this.device.passwordEnc) {
          authConfig.password = await decrypt(this.device.passwordEnc);
        }
        break;
      }
    }

    return new Promise((resolve, reject) => {
      conn.on('ready', () => {
        console.log(`[ssh] connected to ${host}`);

        conn.exec(
          `tmux -CC new-session -A -s ${sessionName}`,
          {
            pty: {
              term: 'xterm-256color',
              cols: 80,
              rows: 30,
            },
          },
          (err, stream) => {
            if (err) {
              reject(err);
              return;
            }

            this.sshStream = stream;

            stream.on('close', () => {
              console.log('[ssh] stream closed');
              if (!this.ready) {
                this.failReady(new Error('SSH stream closed before tmux became ready'));
              }
              if (this.lastExitReason) {
                this.onError(new Error(`tmux exited: ${this.lastExitReason}`));
              }
              this.cleanup();
              this.onClose();
            });

            stream.on('data', (data: Buffer) => {
              this.parser.processData(data);
            });

            stream.stderr.on('data', (data: Buffer) => {
              console.error('[ssh] stderr:', data.toString());
            });

            this.connected = true;
            updateDeviceRuntimeStatus(this.deviceId, {
              lastSeenAt: new Date().toISOString(),
              tmuxAvailable: true,
              lastError: null,
            });

            this.waitForReady()
              .then(() => resolve())
              .catch((err) => {
                this.cleanup();
                reject(err);
              });
          }
        );
      });

      conn.on('error', (err) => {
        console.error('[ssh] error:', err);
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: err.message,
        });
        reject(err);
      });

      conn.on('close', () => {
        console.log('[ssh] connection closed');
        if (!this.ready) {
          this.failReady(new Error('SSH connection closed before tmux became ready'));
        }
        this.cleanup();
        this.onClose();
      });

      conn.connect(authConfig);
    });
  }

  private handleTmuxEvent(event: TmuxEvent): void {
    // 可以在这里添加统一的事件处理逻辑
    this.onEvent(event);
  }

  /**
   * 发送输入到指定 pane
   */
  sendInput(paneId: string, data: string): void {
    if (!this.connected) return;

    this.sendUtf8Bytes(paneId, new TextEncoder().encode(data));
  }

  private sendUtf8Bytes(paneId: string, data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }

    const chunkSize = 256;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.slice(offset, offset + chunkSize);
      const hex: string[] = [];
      for (const byte of chunk) {
        hex.push(byte.toString(16).padStart(2, '0'));
      }
      this.sendCommand(`send-keys -H -t ${paneId} ${hex.join(' ')}\n`);
    }
  }

  /**
   * 发送特殊键（如 Enter, Ctrl+C 等）
   */
  sendKey(paneId: string, key: string): void {
    if (!this.connected) return;

    const cmd = `send-keys -t ${paneId} ${key}\n`;
    this.sendCommand(cmd);
  }

  /**
   * 选择窗口和 pane
   */
  selectPane(windowId: string, paneId: string): void {
    if (!this.connected) return;

    this.activePaneId = paneId;
    this.sendCommand(`select-window -t ${windowId}\n`);
    this.sendCommand(`select-pane -t ${paneId}\n`);
  }

  /**
   * 调整 pane 大小
   */
  resizePane(paneId: string, cols: number, rows: number): void {
    if (!this.connected) return;

    this.sendCommand(`resize-pane -t ${paneId} -x ${cols} -y ${rows}\n`);
  }

  /**
   * 创建新窗口
   */
  createWindow(name?: string): void {
    if (!this.connected) return;

    if (name) {
      this.sendCommand(`new-window -n "${name}"\n`);
    } else {
      this.sendCommand('new-window\n');
    }
  }

  /**
   * 关闭窗口
   */
  closeWindow(windowId: string): void {
    if (!this.connected) return;

    this.sendCommand(`kill-window -t ${windowId}\n`);
  }

  /**
   * 关闭 pane
   */
  closePane(paneId: string): void {
    if (!this.connected) return;

    this.sendCommand(`kill-pane -t ${paneId}\n`);
  }

  /**
   * 重命名窗口
   */
  renameWindow(windowId: string, name: string): void {
    if (!this.connected) return;

    this.sendCommand(`rename-window -t ${windowId} "${name}"\n`);
  }

  /**
   * 请求状态快照
   */
  requestSnapshot(): void {
    if (!this.connected) return;

    this.pendingCommandKinds.push('snapshot-session');
    this.sendCommand('display-message -p "#{session_id}\t#{session_name}"\n');
    this.pendingCommandKinds.push('snapshot-windows');
    this.sendCommand(
      'list-windows -F "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}"\n'
    );
    this.pendingCommandKinds.push('snapshot-panes');
    this.sendCommand(
      'list-panes -F "#{pane_id}\t#{window_id}\t#{pane_index}\t#{pane_active}\t#{pane_width}\t#{pane_height}"\n'
    );
  }

  private handleOutputBlock(block: TmuxOutputBlock): void {
    this.markReady();
    const kind = this.pendingCommandKinds.shift();
    if (!kind) {
      return;
    }

    if (block.isError) {
      const message = block.lines.join('\n').trim();
      if (message) {
        this.onError(new Error(message));
      }
      return;
    }

    switch (kind) {
      case 'snapshot-session':
        this.parseSnapshotSession(block.lines);
        break;
      case 'snapshot-windows':
        this.parseSnapshotWindows(block.lines);
        break;
      case 'snapshot-panes':
        this.parseSnapshotPanes(block.lines);
        break;
    }

    this.emitSnapshotIfReady();
  }

  private parseSnapshotSession(lines: string[]): void {
    for (const line of lines) {
      if (!line.trim()) continue;
      const [id, name] = line.split('\t');
      if (!id) continue;
      this.snapshotSession = { id, name: name ?? '' };
      return;
    }
  }

  private parseSnapshotWindows(lines: string[]): void {
    this.snapshotWindows.clear();
    this.snapshotPanesReady = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const [id, indexRaw, name, activeRaw] = line.split('\t');
      if (!id) continue;
      const index = Number.parseInt(indexRaw ?? '', 10);
      const active = activeRaw === '1';
      this.snapshotWindows.set(id, {
        id,
        name: name ?? '',
        index: Number.isNaN(index) ? 0 : index,
        active,
        panes: [],
      });
    }
  }

  private parseSnapshotPanes(lines: string[]): void {
    for (const window of this.snapshotWindows.values()) {
      window.panes = [];
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      const [paneId, windowId, indexRaw, activeRaw, widthRaw, heightRaw] = line.split('\t');
      if (!paneId || !windowId) continue;
      const index = Number.parseInt(indexRaw ?? '', 10);
      const width = Number.parseInt(widthRaw ?? '', 10);
      const height = Number.parseInt(heightRaw ?? '', 10);
      const pane: TmuxPane = {
        id: paneId,
        windowId,
        index: Number.isNaN(index) ? 0 : index,
        active: activeRaw === '1',
        width: Number.isNaN(width) ? 0 : width,
        height: Number.isNaN(height) ? 0 : height,
      };

      const win = this.snapshotWindows.get(windowId);
      if (!win) continue;
      win.panes.push(pane);
    }

    for (const win of this.snapshotWindows.values()) {
      win.panes.sort((a, b) => a.index - b.index);
    }

    this.snapshotPanesReady = true;
  }

  private emitSnapshotIfReady(): void {
    if (!this.snapshotSession) return;
    if (this.snapshotWindows.size === 0) return;
    if (!this.snapshotPanesReady) return;

    const windows = Array.from(this.snapshotWindows.values()).sort((a, b) => a.index - b.index);
    const session: TmuxSession = {
      id: this.snapshotSession.id,
      name: this.snapshotSession.name,
      windows,
    };

    this.onSnapshot({
      deviceId: this.deviceId,
      session,
    });
  }

  private sendCommand(cmd: string): void {
    if (this.terminal) {
      this.terminal.write(cmd);
    } else if (this.sshStream) {
      (this.sshStream as { write: (data: string) => void }).write(cmd);
    }
  }

  private handleNonControlOutput(line: string): void {
    if (this.ready) {
      return;
    }
    if (this.startupNonControlOutput.length >= 20) {
      return;
    }
    this.startupNonControlOutput.push(line);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.connected = false;
    this.parser.flush();

    this.pendingCommandKinds = [];
    this.snapshotSession = null;
    this.snapshotWindows.clear();
    this.snapshotPanesReady = false;
    this.lastExitReason = null;

    if (this.terminal) {
      this.terminal.close();
      this.terminal = null;
    }

    this.subprocess = null;

    if (this.sshStream) {
      (this.sshStream as { close: () => void }).close();
      this.sshStream = null;
    }

    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }

    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
    });
  }

  isConnected(): boolean {
    return this.connected;
  }
}
