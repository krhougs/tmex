import { spawn, type ChildProcess } from 'child_process';
import { Client } from 'ssh2';
import { TmuxControlParser, type TmuxEvent } from './parser';
import { decrypt } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import type { Device } from '@tmex/shared';

export interface TmuxConnectionOptions {
  deviceId: string;
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export class TmuxConnection {
  private deviceId: string;
  private device: Device | null = null;
  private process: ChildProcess | null = null;
  private sshClient: Client | null = null;
  private sshStream: unknown | null = null;
  private parser: TmuxControlParser;
  private onEvent: (event: TmuxEvent) => void;
  private onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  private onError: (error: Error) => void;
  private onClose: () => void;
  private activePaneId: string | null = null;
  private connected = false;
  
  constructor(options: TmuxConnectionOptions) {
    this.deviceId = options.deviceId;
    this.onEvent = options.onEvent;
    this.onTerminalOutput = options.onTerminalOutput;
    this.onError = options.onError;
    this.onClose = options.onClose;
    
    this.parser = new TmuxControlParser(
      (event) => this.handleTmuxEvent(event),
      (paneId, data) => this.onTerminalOutput(paneId, data)
    );
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
    // 启动本地 tmux -CC
    this.process = spawn('tmux', ['-CC', 'new-session', '-A', '-s', 'tmex'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    this.setupProcessHandlers(this.process);
    this.connected = true;
    
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
    });
  }
  
  private async connectSSH(): Promise<void> {
    if (!this.device) return;
    
    const conn = new Client();
    this.sshClient = conn;
    
    const host = this.device.host;
    const port = this.device.port ?? 22;
    const username = this.device.username;
    
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
        
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          
          this.sshStream = stream;
          
          stream.on('close', () => {
            console.log('[ssh] stream closed');
            this.cleanup();
            this.onClose();
          });
          
          stream.on('data', (data: Buffer) => {
            this.parser.processData(data);
          });
          
          stream.stderr.on('data', (data: Buffer) => {
            console.error('[ssh] stderr:', data.toString());
          });
          
          // 启动 tmux -CC
          stream.write('tmux -CC new-session -A -s tmex\n');
          
          this.connected = true;
          updateDeviceRuntimeStatus(this.deviceId, {
            lastSeenAt: new Date().toISOString(),
            tmuxAvailable: true,
            lastError: null,
          });
          
          resolve();
        });
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
        this.cleanup();
        this.onClose();
      });
      
      conn.connect(authConfig);
    });
  }
  
  private setupProcessHandlers(proc: ChildProcess): void {
    proc.stdout?.on('data', (data: Buffer) => {
      this.parser.processData(data);
    });
    
    proc.stderr?.on('data', (data: Buffer) => {
      console.error('[tmux] stderr:', data.toString());
    });
    
    proc.on('close', (code) => {
      console.log(`[tmux] process exited with code ${code}`);
      this.cleanup();
      this.onClose();
    });
    
    proc.on('error', (err) => {
      console.error('[tmux] process error:', err);
      this.onError(err);
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
    
    // 使用 tmux 命令发送键
    const cmd = `send-keys -t ${paneId} -l ${this.escapeForTmux(data)}\n`;
    this.sendCommand(cmd);
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
    
    // 列出所有窗口和 pane
    this.sendCommand('list-windows -F "#{window_id} #{window_name} #{window_active} #{window_layout}"\n');
    this.sendCommand('list-panes -F "#{pane_id} #{window_id} #{pane_active} #{pane_width} #{pane_height}"\n');
  }
  
  private sendCommand(cmd: string): void {
    if (this.process?.stdin) {
      this.process.stdin.write(cmd);
    } else if (this.sshStream) {
      (this.sshStream as { write: (data: string) => void }).write(cmd);
    }
  }
  
  private escapeForTmux(input: string): string {
    // 转义特殊字符，用于 send-keys -l
    return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
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
    
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    
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
