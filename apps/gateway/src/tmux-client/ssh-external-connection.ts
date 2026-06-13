import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import { config } from '../config';
import { decryptWithContext } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { resolveSshAgentSocket, resolveSshUsername } from '../tmux/ssh-auth';
import {
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneMeta,
  parsePaneScreenInfo,
} from './capture-history';
import { joinShellArgs, quoteShellArg } from './command-builder';
import type { TmuxConnectionOptions } from './connection-types';
import {
  type ControlModeSubscription,
  createControlModeSubscription,
} from './control-mode-subscription';
import { buildEnsureGhosttyTerminfoScript } from './ghostty-terminfo';
import { encodeInputToHexChunks } from './input-encoder';
import type { PaneStreamNotification } from './pane-stream-parser';
import { resolveSshConnectConfig } from './ssh-connect-config';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { isControlModeSupported, parseTmuxVersion } from './tmux-version';
import { resolveTmuxWindowStyle } from './window-style';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PendingShellCommand {
  id: string;
  stderr: string;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SshExternalTmuxConnectionDeps {
  getDevice: (deviceId: string) => Device | null;
  decrypt: typeof decryptWithContext;
  createClient: () => Client;
}

interface ControlChannelHandle {
  stop: () => void;
}

function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
}

const BELL_DEDUP_WINDOW_MS = 200;
const COMMAND_SENTINEL = '\x1eTMEX_END ';
const SNAPSHOT_FIELD_SEPARATOR = '|';
const CONTROL_MAX_RESTARTS = 3;
const CONTROL_RESTART_DELAY_MS = 500;
const CONTROL_STABLE_RESET_MS = 10_000;
const CONTROL_STDERR_TAIL_LIMIT = 2048;
const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
const PARKING_WINDOW_NAME = 'tmex-park';

function splitSnapshotFields(line: string, fieldCount: number): string[] {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length <= fieldCount) {
    return parts;
  }

  if (fieldCount === 2) {
    return [parts[0] ?? '', parts.slice(1).join(SNAPSHOT_FIELD_SEPARATOR)];
  }

  if (fieldCount === 4) {
    return [parts[0] ?? '', parts[1] ?? '', parts.slice(2, -1).join(SNAPSHOT_FIELD_SEPARATOR), parts.at(-1) ?? ''];
  }

  if (fieldCount === 8) {
    return [
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts.slice(3, -4).join(SNAPSHOT_FIELD_SEPARATOR),
      parts.at(-4) ?? '',
      parts.at(-3) ?? '',
      parts.at(-2) ?? '',
      parts.at(-1) ?? '',
    ];
  }

  return parts;
}

export class SshExternalTmuxConnection {
  private readonly deviceId: string;
  private readonly callbacks: TmuxConnectionOptions;
  private readonly deps: SshExternalTmuxConnectionDeps;
  private device: Device | null = null;
  private sessionName = 'tmex';
  private connected = false;
  private manualDisconnect = false;
  private closeNotified = false;
  private cleanupPromise: Promise<void> | null = null;
  private activeWindowId: string | null = null;
  private activePaneId: string | null = null;
  private pendingPaneTitles = new Map<string, string>();
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private bellDedup = new Map<string, number>();
  private controlChannel: ControlChannelHandle | null = null;
  private controlSubscription: ControlModeSubscription | null = null;
  private controlStartedAt = 0;
  private controlRestartCount = 0;
  private controlStderrTail = '';
  private sshClient: Client | null = null;
  private commandStream: ClientChannel | null = null;
  private commandStdoutBuffer = '';
  private pendingCommand: PendingShellCommand | null = null;
  private tmuxBin = 'tmux';
  private remoteHomeDir = '.';
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<SshExternalTmuxConnectionDeps> = {}
  ) {
    this.deviceId = options.deviceId;
    this.callbacks = options;
    this.deps = {
      getDevice: inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId)),
      decrypt: inputDeps.decrypt ?? decryptWithContext,
      createClient: inputDeps.createClient ?? (() => new Client()),
    };
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.closeNotified = false;
    this.device = this.deps.getDevice(this.deviceId);
    if (!this.device) {
      throw new Error(`Device not found: ${this.deviceId}`);
    }
    if (this.device.type !== 'ssh') {
      throw new Error(`SshExternalTmuxConnection only supports ssh device: ${this.deviceId}`);
    }

    this.sessionName = this.device.session?.trim() || 'tmex';

    await this.connectSshClient();
    await this.openCommandChannel();
    await this.ensureSession();
    await this.configureSessionOptions();
    await this.startControlClient();

    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
      lastErrorType: null,
    });
    await this.requestSnapshotInternal();
  }

  disconnect(): void {
    if (this.manualDisconnect) {
      return;
    }
    this.manualDisconnect = true;
    void this.shutdownInternal(false);
  }

  requestSnapshot(): void {
    void this.requestSnapshotInternal();
  }

  sendInput(paneId: string, data: string): void {
    if (!this.connected) {
      return;
    }

    for (const chunk of encodeInputToHexChunks(data)) {
      void this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]).catch((error) => {
        this.callbacks.onError(error);
      });
    }
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.resizePaneInternal(paneId, cols, rows).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectPane(windowId: string, paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.selectPaneInternal(windowId, paneId, null).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.selectPaneInternal(windowId, paneId, { cols, rows }).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectWindow(windowId: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['select-window', '-t', windowId]).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  createWindow(name?: string): void {
    if (!this.connected) {
      return;
    }

    const argv = name
      ? ['new-window', '-t', this.sessionName, '-n', name]
      : ['new-window', '-t', this.sessionName];
    void this.runAndRefresh(argv).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  closeWindow(windowId: string): void {
    if (!this.connected) {
      return;
    }

    void this.closeWindowInternal(windowId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  closePane(paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['kill-pane', '-t', paneId], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  renameWindow(windowId: string, name: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['rename-window', '-t', windowId, name]).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  // 同 local 版本：TMEX_TMUX_WINDOW_STYLE=off 时尊重配置，跳过动态更新。
  setWindowStyle(style: string): void {
    if (!this.connected) {
      return;
    }
    if (!resolveTmuxWindowStyle(config.tmuxWindowStyle)) {
      return;
    }

    void this.configureWindowStyle(style).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  // 同 local 版本：按需读取 pane 可见屏幕纯文本，historyLines > 0 时附带历史。
  // pane 缺失抛 TmuxTargetMissingError（静默形态，不污染设备运行状态）。
  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }

    const argv = ['capture-pane', '-t', paneId, '-p', '-J'];
    const historyLines = Math.floor(opts?.historyLines ?? 0);
    if (Number.isFinite(historyLines) && historyLines > 0) {
      argv.push('-S', `-${historyLines}`);
    }
    return (await this.runTmux(argv, 'silent', 30000)).stdout;
  }

  // 同 local 版本：按需读取 pane 实时元信息（尺寸/光标/alternate/前台命令）。
  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }
    const { stdout } = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_META_FORMAT],
      'silent',
      30000
    );
    return parsePaneMeta(stdout);
  }

  private async connectSshClient(): Promise<void> {
    if (!this.device) {
      throw new Error('SSH device not loaded');
    }
    const authConfig = await resolveSshConnectConfig(this.device, this.deps.decrypt);

    const client = this.deps.createClient();
    this.sshClient = client;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      client.on('ready', () => {
        resolveOnce();
      });
      client.on('error', (error) => {
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: error.message,
        });
        if (!settled) {
          rejectOnce(error);
          return;
        }
        if (!this.manualDisconnect) {
          this.callbacks.onError(error);
          void this.shutdownInternal(true);
        }
      });
      client.on('close', () => {
        if (!settled) {
          rejectOnce(new Error('SSH connection closed before ready'));
          return;
        }
        if (!this.manualDisconnect) {
          void this.shutdownInternal(true);
        }
      });

      client.connect(authConfig);
    });
  }

  private async openCommandChannel(): Promise<void> {
    const sshClient = this.requireSshClient();
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      sshClient.exec('/bin/sh -s', { pty: false }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    this.commandStdoutBuffer = '';
    this.pendingCommand = null;
    this.commandStream = stream;
    stream.on('data', (data: Buffer) => {
      this.commandStdoutBuffer += data.toString();
      this.flushCommandBuffer();
    });
    stream.stderr.on('data', (data: Buffer) => {
      if (this.pendingCommand) {
        this.pendingCommand.stderr += data.toString();
      }
    });
    stream.on('close', () => {
      this.rejectPendingCommand(new Error('SSH command channel closed'));
      this.commandStream = null;
      if (!this.manualDisconnect) {
        void this.shutdownInternal(true);
      }
    });

    const bootstrap = await this.runShell(buildSshBootstrapScript());
    const parsed = parseSshBootstrapOutput(bootstrap.stdout);
    if (!parsed.ok) {
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: parsed.reason,
      });
      throw new Error(`remote tmux unavailable: ${parsed.reason}`);
    }

    this.tmuxBin = parsed.tmuxBin;
    this.remoteHomeDir = parsed.homeDir;

    const version = parseTmuxVersion(parsed.tmuxVersion);
    if (!isControlModeSupported(version)) {
      const message = `remote tmux too old for tmex (control mode requires tmux >= 3.0, found ${parsed.tmuxVersion || 'unknown'})`;
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      throw new Error(message);
    }
  }

  private async ensureSession(): Promise<void> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return;
    }

    await this.runTmux(['new-session', '-d', '-c', this.remoteHomeDir, '-s', this.sessionName]);
  }

  private async configureSessionOptions(): Promise<void> {
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-s',
      'allow-passthrough',
      config.tmuxAllowPassthrough ? 'on' : 'off',
    ]);
    await this.runTmuxAllowFailure(['set-option', '-t', this.sessionName, '-g', 'extended-keys', 'on']);
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-s',
      'extended-keys-format',
      'csi-u',
    ]);
    // 同 local 版本：control client 自带 focused 标志，focus-events 必须关闭，
    // 且 control client detach 不能触发 destroy-unattached。
    await this.runTmuxAllowFailure(['set-option', '-t', this.sessionName, '-g', 'focus-events', 'off']);
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      'destroy-unattached',
      'off',
    ]);

    const termProgram = config.tmuxTermProgram.trim();
    if (termProgram && termProgram.toLowerCase() !== 'off') {
      await this.runTmuxAllowFailure([
        'set-environment',
        '-t',
        this.sessionName,
        'TERM_PROGRAM',
        termProgram,
      ]);
      if (termProgram === 'ghostty' && (await this.ensureGhosttyTerminfo())) {
        await this.runTmuxAllowFailure([
          'set-option',
          '-t',
          this.sessionName,
          'default-terminal',
          'xterm-ghostty',
        ]);
      }
    }

    // 同 local 版本：tmux 不传播 COLORTERM，显式声明真彩色支持。
    await this.runTmuxAllowFailure([
      'set-environment',
      '-t',
      this.sessionName,
      'COLORTERM',
      'truecolor',
    ]);

    await this.configureWindowStyle();
  }

  // 同 local 版本：window-style 让 tmux 能正确代答 pane 内 OSC 10/11 颜色查询
  //（控制模式 client 无法上报 tty 颜色，否则回复纯黑），需逐 window 设置并用
  // hook 覆盖后续新窗口。styleValue 可能来自客户端，resolveTmuxWindowStyle 的白名单
  // 防止穿透 set-hook 引号。
  private async configureWindowStyle(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    const windowStyle = resolveTmuxWindowStyle(styleValue);
    if (!windowStyle) {
      return;
    }
    await this.runTmuxAllowFailure([
      'set-hook',
      '-t',
      this.sessionName,
      'after-new-window',
      `set-option -w window-style '${windowStyle}'`,
    ]);
    const windows = await this.runTmuxAllowFailure([
      'list-windows',
      '-t',
      this.sessionName,
      '-F',
      '#{window_id}',
    ]);
    if (windows.exitCode !== 0) {
      return;
    }
    for (const line of windows.stdout.split('\n')) {
      const windowId = line.trim();
      if (!windowId) {
        continue;
      }
      await this.runTmuxAllowFailure([
        'set-option',
        '-w',
        '-t',
        windowId,
        'window-style',
        windowStyle,
      ]);
    }
  }

  private async ensureGhosttyTerminfo(): Promise<boolean> {
    try {
      const result = await this.runShellAllowFailure(buildEnsureGhosttyTerminfoScript(), 15000);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // 与 local 版本相同的 focus 规避（详见 local-external-connection.ts 与 plan-00）：
  // attach 前把 curw 切到一次性 parking 窗口，避免 ESC[I 落到 ?1004h 的 pane 上。
  private async createParkingWindow(): Promise<string | null> {
    const result = await this.runTmuxAllowFailure([
      'new-window',
      '-t',
      this.sessionName,
      '-n',
      PARKING_WINDOW_NAME,
      '-P',
      '-F',
      '#{window_id}',
      'sleep 30',
    ]);
    if (result.exitCode !== 0) {
      console.warn(
        `[ssh] failed to create parking window on ${this.deviceId}, attaching without focus shield`
      );
      return null;
    }
    return result.stdout.trim() || null;
  }

  private async removeParkingWindow(windowId: string | null): Promise<void> {
    if (!windowId) {
      return;
    }
    await this.runTmuxAllowFailure(['last-window', '-t', this.sessionName]);
    await this.runTmuxAllowFailure(['kill-window', '-t', windowId]);
  }

  private async startControlClient(): Promise<void> {
    let attachReadyResolve: (() => void) | null = null;
    const attachReady = new Promise<void>((resolve) => {
      attachReadyResolve = resolve;
    });

    const parkingWindowId = await this.createParkingWindow();
    let handle: ControlChannelHandle;
    try {
      handle = await this.openControlChannel(() => {
        attachReadyResolve?.();
        attachReadyResolve = null;
      });
      await Promise.race([
        attachReady,
        new Promise<void>((resolve) => setTimeout(resolve, CONTROL_ATTACH_READY_TIMEOUT_MS)),
      ]);
    } finally {
      await this.removeParkingWindow(parkingWindowId);
    }

    // connect 阶段（connected 尚为 false）通道瞬断不会走重连，这里显式失败。
    if (this.controlChannel !== handle) {
      throw new Error(
        this.controlStderrTail.trim() || 'tmux control client channel closed during attach'
      );
    }
  }

  private async openControlChannel(onAttachReady: () => void): Promise<ControlChannelHandle> {
    const subscription = createControlModeSubscription({
      onTerminalOutput: (paneId, data) => {
        this.callbacks.onTerminalOutput(paneId, data);
      },
      onTitle: (paneId, title) => {
        this.pendingPaneTitles.set(paneId, title);
        this.requestSnapshot();
      },
      onBell: (paneId) => {
        this.recordBell(paneId);
      },
      onNotification: (paneId, notification) => {
        this.emitNotification(paneId, notification);
      },
      onStructureChanged: () => {
        this.requestSnapshot();
      },
      onExit: () => {},
      onBlockEnd: () => {
        onAttachReady();
      },
    });

    const handle: ControlChannelHandle = { stop: () => {} };
    this.controlChannel = handle;
    this.controlSubscription = subscription;
    this.controlStartedAt = Date.now();
    this.controlStderrTail = '';

    const stopReader = await this.openReaderChannel(
      `exec ${quoteShellArg(this.tmuxBin)} -C attach-session -t ${quoteShellArg(this.sessionName)}`,
      {
        onData: (data) => {
          if (this.controlChannel === handle) {
            subscription.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          }
        },
        onStderr: (data) => {
          if (this.controlChannel === handle) {
            this.controlStderrTail = (this.controlStderrTail + data.toString()).slice(
              -CONTROL_STDERR_TAIL_LIMIT
            );
          }
        },
        onClose: () => {
          this.handleControlChannelClose(handle);
        },
      }
    );
    handle.stop = stopReader;
    return handle;
  }

  private stopControlClient(): void {
    const handle = this.controlChannel;
    this.controlChannel = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    handle?.stop();
  }

  private handleControlChannelClose(handle: ControlChannelHandle): void {
    if (this.controlChannel !== handle) {
      return;
    }
    this.controlChannel = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    if (!this.connected || this.manualDisconnect) {
      return;
    }
    void this.reconnectControlClient();
  }

  private async reconnectControlClient(): Promise<void> {
    if (Date.now() - this.controlStartedAt > CONTROL_STABLE_RESET_MS) {
      this.controlRestartCount = 0;
    }
    this.controlRestartCount += 1;
    const stderrMessage = this.controlStderrTail.trim();

    if (this.controlRestartCount > CONTROL_MAX_RESTARTS) {
      const message = stderrMessage || 'tmux control client channel closed repeatedly';
      console.warn(`[ssh] tmux control client gave up on ${this.deviceId}: ${message}`);
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      void this.shutdownInternal(true);
      return;
    }

    console.warn(
      `[ssh] tmux control client channel closed on ${this.deviceId}, reconnecting (attempt ${this.controlRestartCount})`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, CONTROL_RESTART_DELAY_MS * this.controlRestartCount)
    );
    if (!this.connected || this.manualDisconnect) {
      return;
    }

    const probe = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (probe.exitCode !== 0) {
      const message = probe.stderr.trim() || probe.stdout.trim() || 'tmux session gone';
      console.warn(`[ssh] tmux session gone on ${this.deviceId}: ${message}`);
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      void this.shutdownInternal(true);
      return;
    }
    if (!this.connected || this.manualDisconnect) {
      return;
    }

    try {
      await this.startControlClient();
    } catch (error) {
      // 瞬断会再次触发 close 处理并按重试计数走重连/放弃，这里仅记录
      console.warn(`[ssh] control client restart failed on ${this.deviceId}:`, error);
      return;
    }
    this.requestSnapshot();
    if (this.activePaneId) {
      void this.capturePaneHistory(this.activePaneId).catch(() => undefined);
    }
  }

  private async runAndRefresh(argv: string[], allowTargetMissing = false): Promise<void> {
    await this.runTmux(argv, allowTargetMissing);
    await this.requestSnapshotInternal();
  }

  private async closeWindowInternal(windowId: string): Promise<void> {
    const count = Number.parseInt(
      (
        await this.runTmux(['display-message', '-p', '-t', this.sessionName, '#{session_windows}'])
      ).stdout.trim() || '0',
      10
    );

    if (count <= 1) {
      await this.runTmux(['new-window', '-d', '-t', this.sessionName]);
    }

    await this.runAndRefresh(['kill-window', '-t', windowId], true);
  }

  private async resizePaneInternal(paneId: string, cols: number, rows: number): Promise<void> {
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(2, Math.floor(rows));
    const windowId =
      this.findPaneWindowId(paneId) ??
      (
        await this.runTmux(['display-message', '-p', '-t', paneId, '#{window_id}'], true)
      ).stdout.trim();
    if (!windowId) {
      return;
    }

    await this.runTmux(
      ['resize-window', '-t', windowId, '-x', String(safeCols), '-y', String(safeRows)],
      true
    );
    await this.requestSnapshotInternal();
  }

  private async selectPaneInternal(
    windowId: string,
    paneId: string,
    size: { cols: number; rows: number } | null
  ): Promise<void> {
    this.activeWindowId = windowId;
    this.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    if (size) {
      await this.resizePaneInternal(paneId, size.cols, size.rows);
    }

    this.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
    await this.capturePaneHistory(paneId);
    await this.requestSnapshotInternal();
  }

  private async capturePaneHistory(paneId: string): Promise<void> {
    const screenInfo = parsePaneScreenInfo(
      (
        await this.runTmux(['display-message', '-p', '-t', paneId, PANE_SCREEN_INFO_FORMAT], true)
      ).stdout
    );
    const alternateScreen = screenInfo.alternateScreen;
    const normal = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-S', '-', '-E', '-', '-e', '-J', '-N', '-p'],
        true,
        30000
      )
    ).stdout;
    const alternate = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-a', '-S', '-', '-E', '-', '-e', '-J', '-N', '-p', '-q'],
        true,
        30000
      )
    ).stdout;

    const history = alternateScreen
      ? hasRenderableTerminalContent(normal)
        ? normal
        : alternate
      : normal || alternate;

    if (history) {
      this.callbacks.onTerminalHistory(
        paneId,
        appendCursorRestore(history, screenInfo),
        alternateScreen
      );
    }
  }

  private async requestSnapshotInternal(): Promise<void> {
    if (!this.connected) {
      return;
    }

    const [sessionRes, windowsRes, panesRes] = await Promise.all([
      this.runTmuxAllowFailure([
        'display-message',
        '-p',
        '-t',
        this.sessionName,
        '#{session_id}|#{session_name}',
      ]),
      this.runTmuxAllowFailure([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        '#{window_id}|#{window_index}|#{window_name}|#{window_active}',
      ]),
      this.runTmuxAllowFailure([
        'list-panes',
        '-s',
        '-t',
        this.sessionName,
        '-F',
        '#{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{window_active}',
      ]),
    ]);

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      const stderrBlob = `${sessionRes.stderr}\n${windowsRes.stderr}\n${panesRes.stderr}`;
      if (
        this.connected &&
        !this.manualDisconnect &&
        this.isTmuxServerGoneMessage(stderrBlob)
      ) {
        const message = stderrBlob.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ??
          'tmux server gone';
        console.warn(`[ssh] tmux server gone during snapshot on ${this.deviceId}: ${message}`);
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: message,
        });
        void this.shutdownInternal(true);
        return;
      }
      this.callbacks.onSnapshot({ deviceId: this.deviceId, session: null });
      return;
    }

    this.parseSnapshotSession(sessionRes.stdout.split(/\r?\n/));
    this.parseSnapshotWindows(windowsRes.stdout.split(/\r?\n/));
    this.parseSnapshotPanes(panesRes.stdout.split(/\r?\n/));
    this.controlSubscription?.prunePanes(new Set(this.getExpectedPaneIds()));
    this.emitSnapshot();
  }

  private parseSnapshotSession(lines: string[]): void {
    this.snapshotSession = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const [id, name] = splitSnapshotFields(line, 2);
      if (id) {
        this.snapshotSession = { id, name: name ?? '' };
      }
      return;
    }
  }

  private parseSnapshotWindows(lines: string[]): void {
    this.snapshotWindows.clear();
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const [id, indexRaw, name, activeRaw] = splitSnapshotFields(line, 4);
      if (!id) {
        continue;
      }
      const index = Number.parseInt(indexRaw ?? '', 10);
      const active = activeRaw === '1';
      if (active) {
        this.activeWindowId = id;
      }
      this.snapshotWindows.set(id, {
        id,
        index: Number.isNaN(index) ? 0 : index,
        name: name ?? '',
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
      if (!line.trim()) {
        continue;
      }
      const [paneId, windowId, indexRaw, titleRaw, activeRaw, widthRaw, heightRaw, windowActiveRaw] =
        splitSnapshotFields(line, 8);
      if (!paneId || !windowId) {
        continue;
      }
      const index = Number.parseInt(indexRaw ?? '', 10);
      const width = Number.parseInt(widthRaw ?? '', 10);
      const height = Number.parseInt(heightRaw ?? '', 10);
      const pane: TmuxPane = {
        id: paneId,
        windowId,
        index: Number.isNaN(index) ? 0 : index,
        title: this.pendingPaneTitles.get(paneId) ?? (titleRaw?.trim() ? titleRaw : undefined),
        // pane_active 是窗口内 active；list-panes -s 下每个窗口都有一个
        active: activeRaw === '1',
        width: Number.isNaN(width) ? 0 : width,
        height: Number.isNaN(height) ? 0 : height,
      };

      if (pane.active && windowActiveRaw === '1') {
        this.activePaneId = paneId;
        this.activeWindowId = windowId;
      }

      const window = this.snapshotWindows.get(windowId);
      if (!window) {
        continue;
      }
      window.panes.push(pane);
      this.pendingPaneTitles.delete(paneId);
    }

    for (const window of this.snapshotWindows.values()) {
      window.panes.sort((left, right) => left.index - right.index);
    }
  }

  private emitSnapshot(): void {
    const session = this.snapshotSession
      ? {
          id: this.snapshotSession.id,
          name: this.snapshotSession.name,
          windows: Array.from(this.snapshotWindows.values()).sort(
            (left, right) => left.index - right.index
          ),
        }
      : null;

    this.callbacks.onSnapshot({
      deviceId: this.deviceId,
      session,
    });
  }

  private findPaneWindowId(paneId: string): string | null {
    for (const window of this.snapshotWindows.values()) {
      if (window.panes.some((pane) => pane.id === paneId)) {
        return window.id;
      }
    }
    return null;
  }

  private recordBell(paneId?: string, windowId?: string): void {
    const key = paneId || windowId || '-';
    const previous = this.bellDedup.get(key) ?? 0;
    const now = Date.now();
    if (now - previous < BELL_DEDUP_WINDOW_MS) {
      return;
    }
    this.bellDedup.set(key, now);
    this.callbacks.onEvent({
      type: 'bell',
      data: {
        windowId,
        paneId: paneId || this.activePaneId || undefined,
      },
    });
  }

  private emitNotification(paneId: string, notification: PaneStreamNotification): void {
    this.callbacks.onEvent({
      type: 'notification',
      data: {
        paneId,
        ...notification,
      },
    });
  }

  private getExpectedPaneIds(): string[] {
    return Array.from(this.snapshotWindows.values())
      .sort((left, right) => left.index - right.index)
      .flatMap((window) => window.panes.map((pane) => pane.id));
  }

  // allowTargetMissing 语义同 local 版本：
  // false=失败即写设备状态并抛错；true=target missing 静默恢复；
  // 'silent'=target missing 抛 TmuxTargetMissingError，不污染设备状态。
  private async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false,
    timeoutMs = 10000
  ): Promise<CommandResult> {
    const result = await this.runTmuxAllowFailure(argv, timeoutMs);
    if (result.exitCode === 0) {
      return result;
    }

    const message = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tmux command failed: ${argv.join(' ')}`
    ).trim();
    if (allowTargetMissing && isTargetMissingMessage(message)) {
      if (allowTargetMissing === 'silent') {
        throw new TmuxTargetMissingError(message);
      }
      this.recoverFromTargetMissingError(message);
      return result;
    }

    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });

    if (this.connected && !this.manualDisconnect && this.isTmuxServerGoneMessage(message)) {
      console.warn(`[ssh] tmux server gone on ${this.deviceId}: ${message}`);
      void this.shutdownInternal(true);
    }
    throw new Error(message);
  }

  private async runTmuxAllowFailure(argv: string[], timeoutMs = 10000): Promise<CommandResult> {
    return this.runShell(`${quoteShellArg(this.tmuxBin)} ${joinShellArgs(argv)}`, timeoutMs);
  }

  private async runShell(command: string, timeoutMs = 10000): Promise<CommandResult> {
    return this.enqueueShellCommand(command, timeoutMs);
  }

  private async runShellAllowFailure(command: string, timeoutMs = 10000): Promise<CommandResult> {
    try {
      return await this.enqueueShellCommand(command, timeoutMs);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private enqueueShellCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    const next = this.commandQueue
      .catch(() => undefined)
      .then(() => this.executeShellCommand(command, timeoutMs));
    this.commandQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private executeShellCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    const stream = this.commandStream;
    if (!stream) {
      return Promise.reject(new Error('SSH command channel not ready'));
    }

    const commandId = crypto.randomUUID();
    const wrappedCommand = `{ ${command}; } 2>&1\nprintf '\\036TMEX_END %s %d\\036\\n' ${quoteShellArg(
      commandId
    )} $?\n`;

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingCommand || this.pendingCommand.id !== commandId) {
          return;
        }
        this.pendingCommand = null;
        reject(new Error(`remote command timed out: ${command}`));
      }, timeoutMs);

      this.pendingCommand = {
        id: commandId,
        stderr: '',
        resolve,
        reject,
        timer,
      };
      stream.write(wrappedCommand);
    });
  }

  private flushCommandBuffer(): void {
    while (true) {
      const sentinelIndex = this.commandStdoutBuffer.indexOf(COMMAND_SENTINEL);
      if (sentinelIndex < 0) {
        return;
      }

      const sentinelEnd = this.commandStdoutBuffer.indexOf(
        '\x1e',
        sentinelIndex + COMMAND_SENTINEL.length
      );
      if (sentinelEnd < 0) {
        return;
      }

      const payload = this.commandStdoutBuffer
        .slice(sentinelIndex + COMMAND_SENTINEL.length, sentinelEnd)
        .trim();
      const [commandId = '', exitCodeRaw = '1'] = payload.split(/\s+/);
      const stdout = this.commandStdoutBuffer.slice(0, sentinelIndex);
      this.commandStdoutBuffer = this.commandStdoutBuffer
        .slice(sentinelEnd + 1)
        .replace(/^\r?\n/, '');

      const pending = this.pendingCommand;
      if (!pending || pending.id !== commandId) {
        continue;
      }

      this.pendingCommand = null;
      clearTimeout(pending.timer);
      pending.resolve({
        exitCode: Number.parseInt(exitCodeRaw, 10) || 0,
        stdout,
        stderr: pending.stderr,
      });
    }
  }

  private rejectPendingCommand(error: Error): void {
    const pending = this.pendingCommand;
    if (!pending) {
      return;
    }

    this.pendingCommand = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async openReaderChannel(
    command: string,
    options: {
      onData: (data: Buffer) => void;
      onStderr?: (data: Buffer) => void;
      onClose?: () => void;
    }
  ): Promise<() => void> {
    const sshClient = this.requireSshClient();
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      sshClient.exec('/bin/sh -s', { pty: false }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    stream.on('data', (data: Buffer) => {
      options.onData(data);
    });
    stream.stderr.on('data', (data: Buffer) => {
      if (options.onStderr) {
        options.onStderr(data);
        return;
      }
      if (!this.manualDisconnect) {
        this.callbacks.onError(new Error(data.toString().trim() || 'SSH reader stderr output'));
      }
    });
    stream.on('close', () => {
      options.onClose?.();
    });
    stream.write(`${command}\n`);

    return () => {
      stream.end();
      stream.close();
      stream.destroy();
    };
  }

  private isTmuxServerGoneMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('no server running on') ||
      normalized.includes('no sessions') ||
      normalized.includes('lost server') ||
      normalized.includes("can't find session") ||
      normalized.includes('session not found') ||
      normalized.includes('no such session')
    );
  }

  private recoverFromTargetMissingError(message: string): void {
    const normalized = message.toLowerCase();
    if (normalized.includes('window')) {
      this.activeWindowId = null;
    }
    if (normalized.includes('pane')) {
      this.activePaneId = null;
    }
    this.requestSnapshot();
  }

  private async shutdownInternal(notifyClose: boolean): Promise<void> {
    if (this.cleanupPromise) {
      await this.cleanupPromise;
      if (notifyClose && !this.closeNotified && !this.manualDisconnect) {
        this.closeNotified = true;
        this.callbacks.onClose();
      }
      return;
    }

    this.connected = false;
    this.cleanupPromise = (async () => {
      this.stopControlClient();
      this.rejectPendingCommand(new Error('SSH command channel closed'));
      this.commandStream?.end();
      this.commandStream?.close();
      this.commandStream?.destroy();
      this.commandStream = null;
      this.sshClient?.end();
      this.sshClient = null;
    })();

    await this.cleanupPromise;
    this.cleanupPromise = null;

    if (notifyClose && !this.closeNotified && !this.manualDisconnect) {
      this.closeNotified = true;
      this.callbacks.onClose();
    }
  }

  private requireSshClient(): Client {
    if (!this.sshClient) {
      throw new Error('SSH client not connected');
    }
    return this.sshClient;
  }
}
