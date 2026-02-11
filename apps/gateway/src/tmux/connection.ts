import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import type { Subprocess, Terminal as BunTerminal } from 'bun';
import { Client } from 'ssh2';
import { decrypt } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { resolveSshAgentSocket, resolveSshUsername } from './ssh-auth';
import { TmuxControlParser, type TmuxEvent, type TmuxOutputBlock } from './parser';

export interface TmuxConnectionOptions {
  deviceId: string;
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory: (paneId: string, data: string) => void;
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
  private onTerminalHistory: (paneId: string, data: string) => void;
  private onSnapshot: (payload: StateSnapshotPayload) => void;
  private onError: (error: Error) => void;
  private onClose: () => void;
  private activePaneId: string | null = null;
  private activeWindowId: string | null = null;
  private connected = false;
  private manualDisconnect = false;

  private ready = false;
  private readyFailed = false;
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private startupNonControlOutput: string[] = [];

  private lastExitReason: string | null = null;

  private pendingCommandKinds: Array<
    | 'noop'
    | 'snapshot-session'
    | 'snapshot-windows'
    | 'snapshot-panes'
    | 'capture-pane'
    | 'capture-pane-mode'
  > = [];
  private pendingCapturePaneRequests: Array<{ paneId: string; mode: 'normal' | 'alternate' }> = [];
  private pendingCapturePaneModeRequests: string[] = [];
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private pendingPaneTitles = new Map<string, string>();
  private snapshotPanesReady = false;
  private historyCaptureStates = new Map<
    string,
    {
      normal: string | null;
      alternate: string | null;
      preferAlternate: boolean | null;
      timeout: ReturnType<typeof setTimeout> | null;
    }
  >();
  private resizeSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TmuxConnectionOptions) {
    this.deviceId = options.deviceId;
    this.onEvent = options.onEvent;
    this.onTerminalOutput = options.onTerminalOutput;
    this.onTerminalHistory = options.onTerminalHistory;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError;
    this.onClose = options.onClose;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.parser = new TmuxControlParser({
      onEvent: (event) => this.handleTmuxEvent(event),
      onTerminalOutput: (paneId, data) => this.emitTerminalOutput(paneId, data),
      onPaneTitle: (paneId, title) => this.handlePaneTitleUpdate(paneId, title),
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
    this.manualDisconnect = false;
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
          if (!this.manualDisconnect) {
            this.onClose();
          }
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
      this.configureWindowSizePolicy();
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
    const resolvedUsername = resolveSshUsername(username, this.device.authMode);

    const logStage = (stage: string, extra: Record<string, unknown> = {}): void => {
      console.log('[ssh]', {
        stage,
        deviceId: this.deviceId,
        host,
        port,
        username: resolvedUsername,
        authMode: this.device?.authMode,
        ...extra,
      });
    };

    logStage('connect_start', {
      hasHost: Boolean(host),
      hasSshConfigRef: Boolean(this.device.sshConfigRef),
      sessionName,
    });

    if (this.device.authMode === 'configRef' || (!host && this.device.sshConfigRef)) {
      throw new Error(
        'ssh_config_ref_not_supported: 当前版本暂不支持 SSH Config 引用，请改为填写 host + username，并选择 Agent/私钥/密码认证'
      );
    }

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
      username: resolvedUsername,
    };

    // 根据 authMode 准备认证
    switch (this.device.authMode) {
      case 'password': {
        if (!this.device.passwordEnc) {
          throw new Error('auth_password_missing: 密码认证未提供密码');
        }

        authConfig.password = await decrypt(this.device.passwordEnc);
        break;
      }
      case 'key': {
        if (!this.device.privateKeyEnc) {
          throw new Error('auth_key_missing: 私钥认证未提供私钥');
        }

        authConfig.privateKey = await decrypt(this.device.privateKeyEnc);
        if (this.device.privateKeyPassphraseEnc) {
          authConfig.passphrase = await decrypt(this.device.privateKeyPassphraseEnc);
        }
        break;
      }
      case 'agent': {
        authConfig.agent = resolveSshAgentSocket('agent');
        break;
      }
      case 'configRef': {
        // 使用 ssh config 中的配置，这里不额外设置
        break;
      }
      case 'auto': {
        // 尝试多种方式
        const agentSocket = resolveSshAgentSocket('auto');
        if (agentSocket) {
          authConfig.agent = agentSocket;
        }
        if (this.device.privateKeyEnc) {
          authConfig.privateKey = await decrypt(this.device.privateKeyEnc);
        } else if (this.device.passwordEnc) {
          authConfig.password = await decrypt(this.device.passwordEnc);
        }
        break;
      }
    }

    if (this.device.authMode === 'auto' && !authConfig.agent && !authConfig.privateKey && !authConfig.password) {
      throw new Error('auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）');
    }

    logStage('auth_config_resolved', {
      hasAgent: Boolean(authConfig.agent),
      hasPrivateKey: Boolean(authConfig.privateKey),
      hasPassphrase: Boolean(authConfig.passphrase),
      hasPassword: Boolean(authConfig.password),
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      let stderrTail = '';

      conn.on('ready', () => {
        logStage('ssh_ready');

        const tmuxCommand = `tmux -CC new-session -A -s ${sessionName}`;
        logStage('tmux_exec_start', { command: tmuxCommand });
        conn.exec(
          tmuxCommand,
          {
            pty: {
              term: 'xterm-256color',
              cols: 80,
              rows: 30,
            },
          },
          (err, stream) => {
            if (err) {
              logStage('tmux_exec_failed', { error: err.message });
              rejectOnce(new Error(`tmux_exec_failed: 启动远端 tmux 失败：${err.message}`));
              return;
            }

            this.sshStream = stream;

            stream.on('close', () => {
              logStage('ssh_stream_closed');
              if (!this.ready) {
                this.failReady(new Error('SSH stream closed before tmux became ready'));
              }
              if (this.lastExitReason) {
                this.onError(new Error(`tmux exited: ${this.lastExitReason}`));
              }
              this.cleanup();
              if (!this.manualDisconnect) {
                this.onClose();
              }
            });

            stream.on('data', (data: Buffer) => {
              this.parser.processData(data);
            });

            stream.stderr.on('data', (data: Buffer) => {
              const chunk = data.toString();
              stderrTail = `${stderrTail}${chunk}`.slice(-2000);
              console.error('[ssh] stderr:', chunk);
            });

            this.connected = true;
            updateDeviceRuntimeStatus(this.deviceId, {
              lastSeenAt: new Date().toISOString(),
              tmuxAvailable: true,
              lastError: null,
            });

            this.waitForReady()
              .then(() => {
                this.configureWindowSizePolicy();
                logStage('tmux_ready');
                resolveOnce();
              })
              .catch((err) => {
                const stderrText = stderrTail.trim();
                const nextError =
                  stderrText.length > 0
                    ? new Error(`${err instanceof Error ? err.message : String(err)}\nssh stderr: ${stderrText}`)
                    : err;
                logStage('tmux_ready_failed', {
                  error: nextError instanceof Error ? nextError.message : String(nextError),
                });
                this.cleanup();
                rejectOnce(nextError);
              });
          }
        );
      });

      conn.on('error', (err) => {
        logStage('connect_error', { error: err.message });
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: err.message,
        });
        rejectOnce(err);
      });

      conn.on('close', () => {
        logStage('connection_closed', { manualDisconnect: this.manualDisconnect });
        if (!this.ready) {
          this.failReady(new Error('SSH connection closed before tmux became ready'));
        }
        this.cleanup();
        if (!this.manualDisconnect) {
          this.onClose();
        }
      });

      logStage('connect_attempt');
      conn.connect(authConfig);
    });
  }

  private handleTmuxEvent(event: TmuxEvent): void {
    // 可以在这里添加统一的事件处理逻辑
    this.onEvent(event);
  }

  private emitBellEventIfNeeded(paneId: string, data: Uint8Array): void {
    for (const byte of data) {
      if (byte !== 0x07) {
        continue;
      }

      this.onEvent({
        type: 'bell',
        data: {
          paneId,
        },
      });
      break;
    }
  }

  private handlePaneTitleUpdate(paneId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    let found = false;
    let updated = false;

    for (const window of this.snapshotWindows.values()) {
      const pane = window.panes.find((item) => item.id === paneId);
      if (!pane) {
        continue;
      }
      found = true;
      if (pane.title !== nextTitle) {
        pane.title = nextTitle;
        updated = true;
      }
      this.pendingPaneTitles.delete(paneId);
      break;
    }

    if (found && !updated) {
      return;
    }

    if (!updated) {
      this.pendingPaneTitles.set(paneId, nextTitle);
      return;
    }

    this.emitSnapshotIfReady();
  }

  private configureWindowSizePolicy(): void {
    if (!this.connected) return;
    this.sendCommand('set-option -g -w window-size latest\n');
    this.sendCommand('set-option -g -w aggressive-resize off\n');
  }

  private scheduleSnapshotAfterResize(delayMs = 120): void {
    if (this.resizeSnapshotTimer) {
      clearTimeout(this.resizeSnapshotTimer);
    }

    this.resizeSnapshotTimer = setTimeout(() => {
      this.resizeSnapshotTimer = null;
      this.requestSnapshot();
    }, delayMs);
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
   * 仅选择窗口并刷新快照
   */
  selectWindow(windowId: string): void {
    if (!this.connected) {
      console.log('[tmux] cannot select window: not connected');
      return;
    }

    this.activeWindowId = windowId;
    this.sendCommand(`select-window -t ${windowId}\n`);
    this.requestSnapshot();
  }

  /**
   * 选择窗口和 pane
   */
  selectPane(windowId: string, paneId: string): void {
    if (!this.connected) {
      console.log('[tmux] cannot select pane: not connected');
      return;
    }

    console.log('[tmux] selecting pane', paneId, 'in window', windowId);
    this.activePaneId = paneId;
    this.activeWindowId = windowId;
    this.sendCommand(`select-window -t ${windowId}\n`);
    this.sendCommand(`select-pane -t ${paneId}\n`);
    // 捕获历史内容
    this.capturePaneHistory(paneId);
  }

  /**
   * 捕获 pane 历史内容
   */
  capturePaneHistory(paneId: string): void {
    if (!this.connected) {
      console.log('[tmux] cannot capture history: not connected');
      return;
    }

    console.log('[tmux] capturing history for pane', paneId);

    const existing = this.historyCaptureStates.get(paneId);
    if (existing?.timeout) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.emitCapturedHistory(paneId);
    }, 220);

    this.historyCaptureStates.set(paneId, {
      normal: null,
      alternate: null,
      preferAlternate: null,
      timeout,
    });

    this.pendingCapturePaneModeRequests.push(paneId);
    this.sendCommand(`display-message -p -t ${paneId} "#{alternate_on}"\n`, 'capture-pane-mode');

    this.pendingCapturePaneRequests.push({ paneId, mode: 'normal' });
    this.sendCommand(`capture-pane -t ${paneId} -S -1000 -e -p\n`, 'capture-pane');

    this.pendingCapturePaneRequests.push({ paneId, mode: 'alternate' });
    this.sendCommand(`capture-pane -t ${paneId} -a -S -1000 -e -p -q\n`, 'capture-pane');
  }

  /**
   * 调整 pane 大小
   */
  resizePane(_paneId: string, cols: number, rows: number): void {
    if (!this.connected) return;

    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(2, Math.floor(rows));
    this.sendCommand(`refresh-client -C ${safeCols}x${safeRows}\n`);

    const windowId = this.activeWindowId;
    if (windowId) {
      this.sendCommand(`resize-window -x ${safeCols} -y ${safeRows} -t ${windowId}\n`);
      this.sendCommand(`set-window-option -t ${windowId} window-size latest\n`);
    }

    this.scheduleSnapshotAfterResize();
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

    this.sendCommand("if-shell -F '#{==:#{session_windows},1}' 'new-window -d' ''\n");
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

    this.sendCommand('display-message -p "#{session_id}\t#{session_name}"\n', 'snapshot-session');
    this.sendCommand(
      'list-windows -F "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}"\n',
      'snapshot-windows'
    );
    this.sendCommand(
      'list-panes -F "#{pane_id}\t#{window_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{pane_width}\t#{pane_height}"\n',
      'snapshot-panes'
    );
  }

  private handleOutputBlock(block: TmuxOutputBlock): void {
    this.markReady();
    const kind = this.pendingCommandKinds.shift();
    console.log('[tmux] handleOutputBlock kind:', kind, 'lines:', block.lines.length);
    const resolvedKind = kind ?? 'noop';

    if (block.isError) {
      const message = block.lines.join('\n').trim();
      if (message) {
        this.onError(new Error(message));
      }
      return;
    }

    switch (resolvedKind) {
      case 'noop':
        break;
      case 'snapshot-session':
        this.parseSnapshotSession(block.lines);
        break;
      case 'snapshot-windows':
        this.parseSnapshotWindows(block.lines);
        break;
      case 'snapshot-panes':
        this.parseSnapshotPanes(block.lines);
        break;
      case 'capture-pane':
        this.handleCapturePaneOutput(block.lines);
        break;
      case 'capture-pane-mode':
        this.handleCapturePaneModeOutput(block.lines);
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
      const [paneId, windowId, indexRaw, titleRaw, activeRaw, widthRaw, heightRaw] = line.split('\t');
      if (!paneId || !windowId) continue;
      const index = Number.parseInt(indexRaw ?? '', 10);
      const width = Number.parseInt(widthRaw ?? '', 10);
      const height = Number.parseInt(heightRaw ?? '', 10);
      const title = titleRaw?.trim() ? titleRaw : undefined;
      const pane: TmuxPane = {
        id: paneId,
        windowId,
        index: Number.isNaN(index) ? 0 : index,
        title: this.pendingPaneTitles.get(paneId) ?? title,
        active: activeRaw === '1',
        width: Number.isNaN(width) ? 0 : width,
        height: Number.isNaN(height) ? 0 : height,
      };

      const win = this.snapshotWindows.get(windowId);
      if (!win) continue;
      win.panes.push(pane);
      this.pendingPaneTitles.delete(paneId);
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

  private sendCommand(
    cmd: string,
    kind:
      | 'noop'
      | 'snapshot-session'
      | 'snapshot-windows'
      | 'snapshot-panes'
      | 'capture-pane'
      | 'capture-pane-mode' = 'noop'
  ): void {
    this.pendingCommandKinds.push(kind);
    if (this.terminal) {
      this.terminal.write(cmd);
      return;
    }
    if (this.sshStream) {
      (this.sshStream as { write: (data: string) => void }).write(cmd);
    }
  }

  private emitTerminalOutput(paneId: string, data: Uint8Array): void {
    this.emitBellEventIfNeeded(paneId, data);
    this.onTerminalOutput(paneId, data);
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
    this.manualDisconnect = true;
    this.cleanup();
  }

  wasManuallyDisconnected(): boolean {
    return this.manualDisconnect;
  }

  private handleCapturePaneOutput(lines: string[]): void {
    console.log('[tmux] capture-pane output:', lines.length, 'lines');
    const request = this.pendingCapturePaneRequests.shift() ?? null;
    if (!request) {
      console.log('[tmux] no pending pane id for capture-pane output');
      return;
    }

    const data = lines.join('\n');

    const state = this.historyCaptureStates.get(request.paneId);
    if (!state) {
      return;
    }

    if (request.mode === 'normal') {
      state.normal = data;
    } else {
      state.alternate = data;
    }

    if (state.normal !== null && state.alternate !== null) {
      this.emitCapturedHistory(request.paneId);
    }
  }


  private handleCapturePaneModeOutput(lines: string[]): void {
    const paneId = this.pendingCapturePaneModeRequests.shift() ?? null;
    if (!paneId) {
      return;
    }

    const state = this.historyCaptureStates.get(paneId);
    if (!state) {
      return;
    }

    const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
    if (firstLine === '1') {
      state.preferAlternate = true;
    } else if (firstLine === '0') {
      state.preferAlternate = false;
    }

    if (state.normal !== null && state.alternate !== null) {
      this.emitCapturedHistory(paneId);
    }
  }

  private emitCapturedHistory(paneId: string): void {
    const state = this.historyCaptureStates.get(paneId);
    if (!state) return;

    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

    const normal = state.normal ?? '';
    const alternate = state.alternate ?? '';

    let selected = normal;
    if (state.preferAlternate === true) {
      selected = alternate || normal;
    } else if (state.preferAlternate === false) {
      selected = normal || alternate;
    } else if (alternate.length > normal.length) {
      selected = alternate;
    }

    if (selected) {
      console.log('[tmux] sending history for pane', paneId, 'data length:', selected.length);
      this.onTerminalHistory(paneId, selected);
    }

    this.historyCaptureStates.delete(paneId);
  }

  private cleanup(): void {
    this.connected = false;
    this.parser.flush();

    this.pendingCommandKinds = [];
    this.pendingCapturePaneRequests = [];
    this.pendingCapturePaneModeRequests = [];

    for (const state of this.historyCaptureStates.values()) {
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
    }
    this.historyCaptureStates.clear();

    this.snapshotSession = null;
    this.snapshotWindows.clear();
    this.pendingPaneTitles.clear();
    this.snapshotPanesReady = false;
    this.lastExitReason = null;
    this.activePaneId = null;
    this.activeWindowId = null;

    if (this.resizeSnapshotTimer) {
      clearTimeout(this.resizeSnapshotTimer);
      this.resizeSnapshotTimer = null;
    }

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
