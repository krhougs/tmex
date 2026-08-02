import { encodePaneModes } from '@tmex/shared';
import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import { config } from '../config';
import { decryptWithContext } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { resolveSshAgentSocket, resolveSshUsername } from '../tmux/ssh-auth';
import {
  PANE_HISTORY_CAPTURE_INFO_FORMAT,
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneHistoryCaptureInfo,
  parsePaneMeta,
  parsePaneScreenInfo,
} from './capture-history';
import { joinShellArgs, quoteShellArg } from './command-builder';
import type { TmuxConnectionOptions } from './connection-types';
import {
  type AtomicPaneCapture,
  ControlModeCommandQueue,
  capturePaneFrameAtControlBarrier,
} from './control-mode-capture';
import {
  type ControlModeSubscription,
  SOURCE_METADATA_SUBSCRIPTION_COMMANDS,
  createControlModeSubscription,
} from './control-mode-subscription';
import { buildEnsureGhosttyTerminfoScript } from './ghostty-terminfo';
import { encodeBytesToHexChunks, encodeInputToHexChunks } from './input-encoder';
import { ConnectionLifecycleEmitter } from './lifecycle-emitter';
import type { PaneStreamNotification } from './pane-stream-parser';
import { ensureStableServerEpoch } from './server-epoch';
import {
  PANE_SNAPSHOT_FORMAT,
  SNAPSHOT_FIELD_SEPARATOR,
  WINDOW_SNAPSHOT_FORMAT,
  formatSnapshotRowForLog,
  isTmuxPaneId,
  isTmuxSessionId,
  isTmuxWindowId,
  parsePaneSnapshotRow,
  parseSnapshotInteger,
  parseWindowSnapshotRow,
  splitSnapshotFields,
} from './snapshot-format';
import { SnapshotRefreshCoordinator } from './snapshot-refresh-coordinator';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';
import { resolveSshConnectConfig } from './ssh-connect-config';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { createThemeSubscriptionTracker } from './theme-subscriptions';
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
  write: (data: string) => void;
}

function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
}

const BELL_DEDUP_WINDOW_MS = 200;
const COMMAND_SENTINEL = '\x1eTMEX_END ';
const CONTROL_MAX_RESTARTS = 3;
const CONTROL_RESTART_DELAY_MS = 500;
const CONTROL_STABLE_RESET_MS = 10_000;
const CONTROL_STDERR_TAIL_LIMIT = 2048;
const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const PARKING_WINDOW_NAME = 'tmex-park';

export class SshExternalTmuxConnection {
  private readonly deviceId: string;
  private readonly callbacks: TmuxConnectionOptions;
  private readonly deps: SshExternalTmuxConnectionDeps;
  private device: Device | null = null;
  private sessionName = 'tmex';
  private connected = false;
  private manualDisconnect = false;
  private closeNotified = false;
  private readonly lifecycle: ConnectionLifecycleEmitter;
  private cleanupPromise: Promise<void> | null = null;
  private activeWindowId: string | null = null;
  private activePaneId: string | null = null;
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private bellDedup = new Map<string, number>();
  private controlChannel: ControlChannelHandle | null = null;
  private controlSubscription: ControlModeSubscription | null = null;
  private controlCommands = new ControlModeCommandQueue();
  private controlStartedAt = 0;
  private controlRestartCount = 0;
  private controlStderrTail = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPending = false;
  private themeSubscriptions = createThemeSubscriptionTracker();
  private themeSubscriptionsRestored = false;
  private sshClient: Client | null = null;
  private commandStream: ClientChannel | null = null;
  private commandStdoutBuffer = '';
  private pendingCommand: PendingShellCommand | null = null;
  private tmuxBin = 'tmux';
  private remoteHomeDir = '.';
  private commandQueue: Promise<void> = Promise.resolve();
  private stackedLayoutTransition: Promise<void> = Promise.resolve();
  private readonly snapshotRefreshCoordinator = new SnapshotRefreshCoordinator(() =>
    this.performSnapshot()
  );

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
    this.lifecycle = new ConnectionLifecycleEmitter({
      getDevice: () => this.device ?? this.deps.getDevice(this.deviceId),
      getSessionName: () => this.sessionName,
      isEmittable: () => this.connected && !this.manualDisconnect,
      getSnapshotWindows: () => this.snapshotWindows,
      notifyEvent: options.notifyEvent,
      resolveCustomName: options.resolveCustomName,
    });
  }

  isSessionClosedEmitted(): boolean {
    return this.lifecycle.sessionClosedEmitted;
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.closeNotified = false;
    this.lifecycle.reset();
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
    const { created } = await this.ensureSession();
    const serverEpoch = await ensureStableServerEpoch((argv) => this.runTmuxAllowFailure(argv));
    this.callbacks.onSourceReady?.(serverEpoch);
    await this.configureSessionOptions();
    await this.startControlClient();

    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
      lastErrorType: null,
    });
    if (created) {
      this.lifecycle.notifySessionCreated();
    }
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
    this.sendInputBytes(paneId, new TextEncoder().encode(data));
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    if (!this.connected) {
      return;
    }

    // 输入优先走 tmux 控制通道 stdin：每次按键起一个 SSH exec 往返开销大，且并发
    // exec 之间没有顺序保证；控制通道队列天然按 stdin 写入顺序执行。不可用时退回。
    for (const chunk of encodeBytesToHexChunks(data)) {
      const control = this.controlChannel;
      if (control) {
        void this.controlCommands
          .execute(
            (command) => control.write(command),
            ['send-keys', '-H', '-t', paneId, ...chunk].join(' '),
            { transform: () => undefined, timeoutMs: 30_000 }
          )
          .catch((error) => {
            this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
          });
      } else {
        void this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]).catch((error) => {
          this.callbacks.onError(error);
        });
      }
    }
  }

  // 主题变化通知（mode 2031）：仅对输出流中声明过 CSI ?2031h 的 pane 注入
  // CSI ?997;{1|2}n（1=dark 2=light）。守卫与时序要求同 local 版本。
  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    if (!this.connected || !config.themeNotify2031Enabled) {
      return;
    }
    if (!this.themeSubscriptions.has(paneId)) {
      return;
    }
    this.sendInput(paneId, `\x1b[?997;${theme === 'dark' ? '1' : '2'}n`);
  }

  private noteThemeSubscription(paneId: string, subscribed: boolean): void {
    this.themeSubscriptions.note(paneId, subscribed);
    void this.runTmuxAllowFailure([
      'set-option',
      '-p',
      '-t',
      paneId,
      '@tmex_2031',
      subscribed ? 'on' : 'off',
    ]).catch(() => {});
  }

  private clearThemeSubscription(paneId: string): void {
    if (!this.themeSubscriptions.has(paneId)) {
      return;
    }
    this.themeSubscriptions.clear(paneId);
    void this.runTmuxAllowFailure(['set-option', '-p', '-t', paneId, '@tmex_2031', 'off']).catch(
      () => {}
    );
  }

  private restoreThemeSubscriptionsOnce(): void {
    if (this.themeSubscriptionsRestored) {
      return;
    }
    this.themeSubscriptionsRestored = true;
    void this.runTmuxAllowFailure([
      'list-panes',
      '-a',
      '-F',
      // 用 | 分隔：LANG=C 环境下 tmux 会把 -F 里的 tab 渲染成 "_"
      '#{pane_id}|#{@tmex_2031}',
    ])
      .then((result) => {
        if (!result || result.exitCode !== 0) {
          return;
        }
        const restored: string[] = [];
        for (const line of result.stdout.split('\n')) {
          const [paneId, flag] = line.trim().split('|');
          if (paneId && flag === 'on') {
            restored.push(paneId);
          }
        }
        this.themeSubscriptions.restore(restored);
      })
      .catch(() => {});
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

    void this.runAndRefresh(['select-window', '-t', windowId], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  async createWindow(name?: string, cwd?: string): Promise<string | null> {
    if (!this.connected) {
      return null;
    }

    const argv = [
      'new-window',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      this.sessionName,
      '-c',
      cwd ?? this.resolveDefaultWorkingDir(),
    ];
    if (name) {
      argv.push('-n', name);
    }
    try {
      const windowId = (await this.runTmux(argv)).stdout.trim();
      await this.requestSnapshotInternal();
      return /^@\d+$/.test(windowId) ? windowId : null;
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
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

  splitPane(paneId: string, direction: 'h' | 'v', cwd?: string): void {
    if (!this.connected) {
      return;
    }

    void this.splitPaneInternal(paneId, direction, cwd).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  resizePaneById(paneId: string, size: { cols?: number; rows?: number }): void {
    if (!this.connected) {
      return;
    }

    void this.resizePaneByIdInternal(paneId, size).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  resizeWindow(windowId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    void this.resizeWindowInternal(windowId, cols, rows).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  selectLayout(windowId: string, preset: 'even-horizontal'): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['select-layout', '-t', windowId, preset], true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  applyStackedLayout(windowId: string, cols: number, rows: number): void {
    if (!this.connected) {
      return;
    }

    const next = this.stackedLayoutTransition
      .catch(() => undefined)
      .then(async () => {
        if (!this.connected) {
          return;
        }
        await this.resizeWindowInternal(windowId, cols, rows, false);
        if (!this.connected) {
          return;
        }
        await this.runAndRefresh(['select-layout', '-t', windowId, 'even-horizontal'], true);
      });
    this.stackedLayoutTransition = next;
    void next.catch((error) => {
      this.callbacks.onError(error);
    });
  }

  focusPane(windowId: string, paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.focusPaneInternal(windowId, paneId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  // 拖拽重排：把 src pane 移到 dst pane 的某一侧。
  // move-pane -h 产生左右排列、-v 上下排列，-b 放在目标之前（左/上）
  movePane(
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    if (!this.connected) {
      return;
    }

    const argv = ['move-pane'];
    argv.push(position === 'left' || position === 'right' ? '-h' : '-v');
    if (position === 'left' || position === 'top') {
      argv.push('-b');
    }
    argv.push('-s', srcPaneId, '-t', dstPaneId);
    void this.runAndRefresh(argv, true).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  breakPane(paneId: string): void {
    if (!this.connected) {
      return;
    }

    void this.breakPaneInternal(paneId).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  // 把 pane 拆出为独立窗口。必须显式 -t 回本 session：无 attached client 时
  // break-pane 的默认目标是"最近使用的 session"，会把 pane 丢进用户的其他 session。
  // -P 回传新窗口信息并发 pane-active，驱动前端跟随导航（同 splitPane）
  private async breakPaneInternal(paneId: string): Promise<void> {
    const result = await this.runTmux(
      [
        'break-pane',
        '-s',
        paneId,
        '-t',
        `${this.sessionName}:`,
        '-P',
        '-F',
        `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
      ],
      true
    );
    const [windowId, newPaneId] = result.stdout.trim().split(SNAPSHOT_FIELD_SEPARATOR);
    if (isTmuxWindowId(windowId) && isTmuxPaneId(newPaneId)) {
      this.activeWindowId = windowId;
      this.activePaneId = newPaneId;
      this.callbacks.onEvent({
        type: 'pane-active',
        data: { windowId, paneId: newPaneId },
      });
    }
    await this.requestSnapshotInternal();
  }

  async requestPaneHistory(paneId: string): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.capturePaneHistory(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    if (!this.connected) {
      return;
    }

    void this.runAndRefresh(['rename-window', '-t', windowId, name]).catch((error) => {
      this.callbacks.onError(error);
    });
  }

  updateDefaultWorkingDir(dir: string | undefined): void {
    if (this.device) {
      this.device = { ...this.device, defaultWorkingDir: dir };
    }
    if (this.connected) {
      void this.runTmuxAllowFailure([
        'set-option',
        '-t',
        this.sessionName,
        'default-path',
        this.resolveDefaultWorkingDir(),
      ]);
    }
  }

  async setWindowStyle(style: string): Promise<void> {
    if (!this.connected) {
      return;
    }
    if (!resolveTmuxWindowStyle(config.tmuxWindowStyle)) {
      return;
    }

    // 错误内部上报后 resolve，不 reject（调用方 await 只关心"已尽力落地"）
    await this.configureWindowStyle(style).catch((error) => {
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

  async getPaneHistoryCaptureInfo(paneId: string) {
    if (!this.connected) throw new Error(`tmux connection not available: ${this.deviceId}`);
    const { stdout } = await this.runTmuxIsolated(
      ['display-message', '-p', '-t', paneId, PANE_HISTORY_CAPTURE_INFO_FORMAT],
      4096,
      30_000
    );
    return parsePaneHistoryCaptureInfo(stdout);
  }

  async capturePaneHistoryRange(
    paneId: string,
    startLine: number,
    endLine: number,
    maxOutputBytes: number
  ): Promise<string> {
    if (!this.connected) throw new Error(`tmux connection not available: ${this.deviceId}`);
    if (!isTmuxPaneId(paneId) || !Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error('invalid tmux history range');
    }
    const { stdout } = await this.runTmuxIsolated(
      [
        'capture-pane',
        '-t',
        paneId,
        '-p',
        '-e',
        '-N',
        '-S',
        String(startLine),
        '-E',
        String(endLine),
      ],
      maxOutputBytes,
      30_000
    );
    return stdout;
  }

  capturePaneFrameAtBarrier(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture> {
    const control = this.controlChannel;
    if (!this.connected || !control) {
      return Promise.reject(new Error(`tmux control connection not available: ${this.deviceId}`));
    }
    return capturePaneFrameAtControlBarrier(
      this.controlCommands,
      (command) => control.write(command),
      paneId,
      historyLines,
      onBarrier,
      30_000
    );
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

  private resolveDefaultWorkingDir(): string {
    return this.device?.defaultWorkingDir?.trim() || this.remoteHomeDir;
  }

  private async ensureSession(): Promise<{ created: boolean }> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return { created: false };
    }

    await this.runTmux([
      'new-session',
      '-d',
      '-c',
      this.resolveDefaultWorkingDir(),
      '-s',
      this.sessionName,
    ]);
    return { created: true };
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
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-g',
      'extended-keys',
      'on',
    ]);
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
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-g',
      'focus-events',
      'off',
    ]);
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

    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      'default-path',
      this.resolveDefaultWorkingDir(),
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
    const startedAt = config.isDev ? Date.now() : 0;
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
      if (config.isDev) {
        console.debug(
          `[ssh] configureWindowStyle deviceId=${this.deviceId} elapsed=${Date.now() - startedAt}ms (list-windows failed)`
        );
      }
      return;
    }
    const windowIds: string[] = [];
    for (const line of windows.stdout.split('\n')) {
      const windowId = line.trim();
      if (!windowId) {
        continue;
      }
      windowIds.push(windowId);
    }
    // 合并所有 window 的 set-option 成一条 shell 命令，减少 SSH round-trip（N 次 → 1 次）。
    if (windowIds.length > 0) {
      const setOptions = windowIds
        .map(
          (id) =>
            `${quoteShellArg(this.tmuxBin)} set-option -w -t ${quoteShellArg(id)} window-style ${quoteShellArg(windowStyle)}`
        )
        .join(' && ');
      await this.runShellAllowFailure(setOptions);
    }
    if (config.isDev) {
      console.debug(
        `[ssh] configureWindowStyle deviceId=${this.deviceId} windows=${windowIds.length} elapsed=${Date.now() - startedAt}ms`
      );
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
    // 先清除旧的心跳定时器，防止重连期间旧 timeout 回调看到新 controlChannel 后误杀。
    this.stopHeartbeat();

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

    for (const command of SOURCE_METADATA_SUBSCRIPTION_COMMANDS) {
      void this.controlCommands
        .execute((value) => handle.write(value), command, { transform: () => undefined })
        .catch((error) => this.callbacks.onError(error));
    }

    this.startHeartbeat();
  }

  private async openControlChannel(onAttachReady: () => void): Promise<ControlChannelHandle> {
    this.controlCommands.dispose('tmux control connection replaced');
    const handle: ControlChannelHandle = { stop: () => {}, write: () => {} };
    const controlCommands = new ControlModeCommandQueue(() => handle.stop());
    this.controlCommands = controlCommands;
    const subscription = createControlModeSubscription({
      onTerminalOutput: (paneId, data) => {
        this.callbacks.onTerminalOutput(paneId, data);
      },
      onTitle: (paneId, title) => {
        this.callbacks.onSourceMetadata?.({ type: 'pane-title', paneId, title });
      },
      onSourceMetadata: (event) => {
        this.callbacks.onSourceMetadata?.(event);
      },
      onBell: (paneId) => {
        this.recordBell(paneId);
      },
      onNotification: (paneId, notification) => {
        this.emitNotification(paneId, notification);
      },
      onPromptMarker: (paneId, marker) => {
        // 提示符出现 = 前台回到 shell，订阅方 TUI 已不在前台（挂起/异常退出兜底清位）
        if (marker.kind === 'A') {
          this.clearThemeSubscription(paneId);
        }
        this.callbacks.onPromptMarker?.(paneId, marker);
      },
      onClipboardWrite: (paneId, text) => {
        this.callbacks.onClipboardWrite?.(paneId, text);
      },
      onThemeSubscription: (paneId, subscribed) => {
        this.noteThemeSubscription(paneId, subscribed);
      },
      onStructureChanged: () => {
        this.requestSnapshot();
      },
      onExit: () => {},
      onPause: (paneId) => {
        if (this.controlChannel === handle) {
          void controlCommands
            .execute((value) => handle.write(value), `refresh-client -A ${paneId}:continue`, {
              transform: () => undefined,
            })
            .catch((error) => this.callbacks.onError(error));
        }
      },
      onBlockBegin: () => controlCommands.nextBlockIsLiteral(),
      onBlockEnd: (block) => {
        if (controlCommands.handleBlock(block)) return;
        onAttachReady();
      },
    });

    this.controlChannel = handle;
    this.controlSubscription = subscription;
    this.controlStartedAt = Date.now();
    this.controlStderrTail = '';

    const reader = await this.openReaderChannel(
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
    handle.stop = reader.stop;
    handle.write = reader.write;
    return handle;
  }

  private stopControlClient(): void {
    this.stopHeartbeat();
    const handle = this.controlChannel;
    this.controlChannel = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    this.controlCommands.dispose();
    handle?.stop();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatPending = false;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatPending = false;
  }

  private sendHeartbeat(): void {
    if (!this.controlChannel || this.heartbeatPending || !this.connected || this.manualDisconnect) {
      return;
    }
    this.heartbeatPending = true;
    const control = this.controlChannel;
    const settle = () => this.onHeartbeatResponse(control);
    void this.controlCommands
      .execute((value) => control.write(value), 'display-message -p "tmex-hb"', {
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        transform: (block) => {
          if (block.lines.length !== 1 || block.lines[0] !== 'tmex-hb') {
            throw new Error('invalid tmux heartbeat response');
          }
        },
      })
      .then(settle, settle);
  }

  private onHeartbeatResponse(control: ControlChannelHandle): void {
    if (this.controlChannel !== control) return;
    this.heartbeatPending = false;
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
      this.lifecycle.notifySessionClosed(message);
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
      await this.runTmux([
        'new-window',
        '-d',
        '-t',
        this.sessionName,
        '-c',
        this.resolveDefaultWorkingDir(),
      ]);
    }

    await this.runAndRefresh(['kill-window', '-t', windowId], true);
  }

  private async resizePaneInternal(paneId: string, cols: number, rows: number): Promise<void> {
    const windowId =
      this.findPaneWindowId(paneId) ??
      (
        await this.runTmux(['display-message', '-p', '-t', paneId, '#{window_id}'], true)
      ).stdout.trim();
    if (!windowId) {
      return;
    }

    await this.resizeWindowInternal(windowId, cols, rows);
  }

  private async resizeWindowInternal(
    windowId: string,
    cols: number,
    rows: number,
    refresh = true
  ): Promise<void> {
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(2, Math.floor(rows));
    await this.runTmux(
      ['resize-window', '-t', windowId, '-x', String(safeCols), '-y', String(safeRows)],
      true
    );
    if (refresh) {
      await this.requestSnapshotInternal();
    }
  }

  private async resizePaneByIdInternal(
    paneId: string,
    size: { cols?: number; rows?: number }
  ): Promise<void> {
    const argv = ['resize-pane', '-t', paneId];
    if (size.cols !== undefined) {
      argv.push('-x', String(Math.max(2, Math.floor(size.cols))));
    }
    if (size.rows !== undefined) {
      argv.push('-y', String(Math.max(2, Math.floor(size.rows))));
    }
    if (argv.length === 3) {
      return;
    }
    await this.runTmux(argv, true);
    await this.requestSnapshotInternal();
  }

  private async splitPaneInternal(
    paneId: string,
    direction: 'h' | 'v',
    cwd?: string
  ): Promise<void> {
    const result = await this.runTmux(
      [
        'split-window',
        direction === 'h' ? '-h' : '-v',
        '-t',
        paneId,
        '-c',
        cwd ?? this.resolveDefaultWorkingDir(),
        '-P',
        '-F',
        `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
      ],
      true
    );
    const [windowId, newPaneId] = result.stdout.trim().split(SNAPSHOT_FIELD_SEPARATOR);
    if (isTmuxWindowId(windowId) && isTmuxPaneId(newPaneId)) {
      this.activeWindowId = windowId;
      this.activePaneId = newPaneId;
      this.callbacks.onEvent({
        type: 'pane-active',
        data: { windowId, paneId: newPaneId },
      });
    }
    await this.requestSnapshotInternal();
  }

  private async focusPaneInternal(windowId: string, paneId: string): Promise<void> {
    this.activeWindowId = windowId;
    this.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);

    this.callbacks.onEvent({
      type: 'pane-active',
      data: { windowId, paneId },
    });
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

  async fetchPaneHistory(
    paneId: string
  ): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
    const screenInfo = parsePaneScreenInfo(
      (await this.runTmux(['display-message', '-p', '-t', paneId, PANE_SCREEN_INFO_FORMAT], true))
        .stdout
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

    if (!history) {
      return null;
    }
    return {
      data: appendCursorRestore(history, screenInfo),
      alternateScreen,
      modes: encodePaneModes(screenInfo.modes),
    };
  }

  private async capturePaneHistory(paneId: string): Promise<void> {
    const captured = await this.fetchPaneHistory(paneId);
    if (captured) {
      this.callbacks.onTerminalHistory(
        paneId,
        captured.data,
        captured.alternateScreen,
        captured.modes
      );
    }
  }

  private async requestSnapshotInternal(): Promise<void> {
    return this.snapshotRefreshCoordinator.request();
  }

  private async performSnapshot(): Promise<void> {
    if (!this.connected) {
      return;
    }

    const baseRevision = this.callbacks.beginMetadataReconcile?.();

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
        WINDOW_SNAPSHOT_FORMAT,
      ]),
      this.runTmuxAllowFailure([
        'list-panes',
        '-s',
        '-t',
        this.sessionName,
        '-F',
        PANE_SNAPSHOT_FORMAT,
      ]),
    ]);

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      const stderrBlob = `${sessionRes.stderr}\n${windowsRes.stderr}\n${panesRes.stderr}`;
      if (this.connected && !this.manualDisconnect && this.isTmuxServerGoneMessage(stderrBlob)) {
        const message =
          stderrBlob
            .trim()
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim() ?? 'tmux server gone';
        console.warn(`[ssh] tmux server gone during snapshot on ${this.deviceId}: ${message}`);
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: message,
        });
        this.lifecycle.notifySessionClosed(message);
        void this.shutdownInternal(true);
        return;
      }
      this.callbacks.onSnapshot({ deviceId: this.deviceId, session: null });
      return;
    }

    const prevWindows = new Map(this.snapshotWindows);
    this.parseSnapshotSession(sessionRes.stdout.split(/\r?\n/));
    this.parseSnapshotWindows(windowsRes.stdout.split(/\r?\n/));
    this.parseSnapshotPanes(panesRes.stdout.split(/\r?\n/));
    this.discardInvalidSnapshot();
    const expectedPaneIds = new Set(this.getExpectedPaneIds());
    this.controlSubscription?.prunePanes(expectedPaneIds);
    this.themeSubscriptions.prune(expectedPaneIds);
    this.restoreThemeSubscriptionsOnce();
    this.emitSnapshot(baseRevision);
    this.lifecycle.emitSnapshotClosures(prevWindows);
  }

  private parseSnapshotSession(lines: string[]): void {
    this.snapshotSession = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const [id, name] = splitSnapshotFields(line, 2);
      if (isTmuxSessionId(id)) {
        this.snapshotSession = { id, name: name ?? '' };
      } else {
        console.warn(`[ssh] ignoring invalid tmux session id on ${this.deviceId}: ${id ?? ''}`);
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
      const row = parseWindowSnapshotRow(line);
      if (!row) {
        console.warn(
          `[ssh] ignoring invalid tmux window snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      if (row.active) {
        this.activeWindowId = row.id;
      }
      this.snapshotWindows.set(row.id, {
        id: row.id,
        index: row.index,
        name: row.name,
        active: row.active,
        layout: row.layout,
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
      const row = parsePaneSnapshotRow(line);
      if (!row) {
        console.warn(
          `[ssh] ignoring invalid tmux pane snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      const pane: TmuxPane = {
        id: row.id,
        windowId: row.windowId,
        index: row.index,
        title: row.title ?? '',
        currentCommand: row.currentCommand,
        currentPath: row.currentPath,
        // pane_active 是窗口内 active；list-panes -s 下每个窗口都有一个
        active: row.active,
        width: row.width,
        height: row.height,
        left: row.left,
        top: row.top,
      };

      if (pane.active && row.windowActive) {
        this.activePaneId = row.id;
        this.activeWindowId = row.windowId;
      }

      const window = this.snapshotWindows.get(row.windowId);
      if (!window) {
        continue;
      }
      window.panes.push(pane);
    }

    for (const window of this.snapshotWindows.values()) {
      window.panes.sort((left, right) => left.index - right.index);
    }
  }

  private isSnapshotFlag(value: string | undefined): value is '0' | '1' {
    return value === '0' || value === '1';
  }

  private discardInvalidSnapshot(): void {
    if (!this.snapshotSession) {
      this.snapshotWindows.clear();
      this.activeWindowId = null;
      this.activePaneId = null;
      return;
    }

    if (this.snapshotWindows.size === 0) {
      console.warn(`[ssh] ignoring tmux snapshot with no valid windows on ${this.deviceId}`);
      this.snapshotSession = null;
      this.activeWindowId = null;
      this.activePaneId = null;
    }
  }

  private emitSnapshot(baseRevision?: bigint): void {
    const session = this.snapshotSession
      ? {
          id: this.snapshotSession.id,
          name: this.snapshotSession.name,
          windows: Array.from(this.snapshotWindows.values()).sort(
            (left, right) => left.index - right.index
          ),
        }
      : null;

    this.callbacks.onSnapshot(
      {
        deviceId: this.deviceId,
        session,
      },
      baseRevision
    );
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

    console.warn(
      `[ssh] tmux command failed deviceId=${this.deviceId} sessionName=${this.sessionName} argv=${argv.join(' ')} exitCode=${result.exitCode}: ${message}`
    );
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });

    if (this.connected && !this.manualDisconnect && this.isTmuxServerGoneMessage(message)) {
      console.warn(`[ssh] tmux server gone on ${this.deviceId}: ${message}`);
      this.lifecycle.notifySessionClosed(message);
      void this.shutdownInternal(true);
    }
    throw new Error(message);
  }

  private async runTmuxIsolated(
    argv: string[],
    maxOutputBytes: number,
    timeoutMs: number
  ): Promise<CommandResult> {
    const command = `${quoteShellArg(this.tmuxBin)} ${joinShellArgs(argv)}`;
    const result = await this.executeIsolatedShellCommand(command, maxOutputBytes, timeoutMs);
    if (result.exitCode === 0) return result;
    const message = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tmux command failed: ${argv.join(' ')}`
    ).trim();
    if (isTargetMissingMessage(message)) throw new TmuxTargetMissingError(message);
    throw new Error(message);
  }

  private executeIsolatedShellCommand(
    command: string,
    maxOutputBytes: number,
    timeoutMs: number
  ): Promise<CommandResult> {
    const sshClient = this.requireSshClient();
    const outputLimit = Math.max(1, Math.floor(maxOutputBytes));
    return new Promise<CommandResult>((resolve, reject) => {
      let settled = false;
      let exitCode = 0;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stream: ClientChannel | null = null;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          stream?.close();
          stream?.destroy();
        } catch {}
        reject(error);
      };
      const timer = setTimeout(
        () => finishReject(new Error(`isolated SSH command timed out: ${command.slice(0, 80)}`)),
        timeoutMs
      );

      sshClient.exec(command, { pty: false }, (error, channel) => {
        if (error) {
          finishReject(error);
          return;
        }
        stream = channel;
        channel.on('data', (chunk: Buffer) => {
          if (settled) return;
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > outputLimit) {
            finishReject(new Error('tmux history capture exceeded bounded output'));
            return;
          }
          stdout.push(Buffer.from(chunk));
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          if (settled) return;
          stderrBytes += chunk.byteLength;
          if (stderrBytes > 8192) {
            finishReject(new Error('isolated SSH command stderr exceeded bounded output'));
            return;
          }
          stderr.push(Buffer.from(chunk));
        });
        channel.on('exit', (code: number | undefined) => {
          exitCode = code ?? 1;
        });
        channel.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode,
            stdout: Buffer.concat(stdout, stdoutBytes).toString(),
            stderr: Buffer.concat(stderr, stderrBytes).toString(),
          });
        });
      });
    });
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
  ): Promise<{ stop: () => void; write: (data: string) => void }> {
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

    return {
      stop: () => {
        stream.end();
        stream.close();
        stream.destroy();
      },
      write: (data: string) => {
        try {
          stream.write(data);
        } catch {}
      },
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
