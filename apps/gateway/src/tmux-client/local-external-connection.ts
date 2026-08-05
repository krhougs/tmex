import { homedir } from 'node:os';
import { encodePaneModes } from '@tmex/shared';
import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { config } from '../config';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { isManagedExternally } from '../system/managed';
import {
  buildLocalTmuxEnv,
  getLocalParkingCommand,
  getLocalShellPath,
} from '../tmux/local-shell-path';
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
import type { ControlStreamMetricsSnapshot } from './control-stream-metrics';
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
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { createThemeSubscriptionTracker } from './theme-subscriptions';
import {
  isControlModeSupported,
  parseTmuxVersion,
  tmuxClientMatchesServer,
  tmuxVersionIdentity,
} from './tmux-version';
import { resolveTmuxWindowStyle } from './window-style';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ControlClientProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
  write: (data: string) => void;
}

interface LocalExternalTmuxConnectionDeps {
  enableSubscription: boolean;
  platform: NodeJS.Platform;
  getDevice: (deviceId: string) => Device | null;
  run: (argv: string[]) => Promise<CommandResult>;
  ensureGhosttyTerminfo: () => Promise<boolean>;
  parkingCommand: () => string;
  spawnControlClient: (argv: string[]) => ControlClientProcess;
  controlStalledTimeoutMs?: number;
}

const CONTROL_MAX_RESTARTS = 3;
const CONTROL_RESTART_DELAY_MS = 500;
const CONTROL_STABLE_RESET_MS = 10_000;
const CONTROL_STDERR_TAIL_LIMIT = 2048;
const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const PARKING_WINDOW_NAME = 'tmex-park';

function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
}
const BELL_DEDUP_WINDOW_MS = 200;

export function shouldIgnoreReaderAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };

  return (
    maybeError.name === 'AbortError' &&
    maybeError.code === 'ERR_STREAM_RELEASE_LOCK' &&
    typeof maybeError.message === 'string' &&
    maybeError.message.includes('releaseLock')
  );
}

// 进程资源暂时耗尽（如本机进程数到 kern.maxprocperuid）时 Bun.spawn 会抛这些错误码。
// 区别于 tmux 命令本身的非零退出与「server gone」，这类失败是瞬时的，应退避重试而非
// 判定连接失效或抛 unhandledRejection。
const TRANSIENT_SPAWN_ERROR_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
const TMUX_SPAWN_UNAVAILABLE_EXIT = -2;

function isTransientSpawnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_SPAWN_ERROR_CODES.has(code)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    (message.includes('EAGAIN') ||
      message.includes('posix_spawn') ||
      message.includes('resource temporarily unavailable') ||
      message.includes('Too many open files'))
  );
}

// 单条 tmux CLI 调用的硬时限:CLI 卡死(如服务端主循环停滞)时 kill 子进程,
// 让调用方拿到失败结果走既有错误路径,而不是永久挂起。
const LOCAL_RUN_TIMEOUT_MS = 30_000;

export function defaultRun(argv: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const subprocess = Bun.spawn(argv, {
      env: buildLocalTmuxEnv(getLocalShellPath()),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const killTimer = setTimeout(() => {
      subprocess.kill();
    }, LOCAL_RUN_TIMEOUT_MS);

    Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        clearTimeout(killTimer);
        resolve({ stdout, stderr, exitCode });
      })
      .catch((error) => {
        clearTimeout(killTimer);
        reject(error);
      });
  });
}

export function defaultSpawnControlClient(argv: string[]): ControlClientProcess {
  const subprocess = Bun.spawn(argv, {
    env: buildLocalTmuxEnv(getLocalShellPath()),
    // stdin 保持打开（tmux -C 在 stdin EOF 时退出）。
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // 持有 stdin 引用直到 kill，避免 FileSink 被 GC 关闭导致 tmux 收到 EOF 而退出。
  const stdin = subprocess.stdin;
  return {
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited,
    kill: () => {
      try {
        stdin?.end();
      } catch {
        /* ignore */
      }
      subprocess.kill();
    },
    write: (data) => {
      try {
        stdin?.write(data);
      } catch {}
    },
  };
}

export function buildLocalTmuxArgv(
  argv: readonly string[],
  tmuxBin = config.tmuxBin,
  tmuxSocket = config.tmuxSocket
): string[] {
  return [tmuxBin, ...(tmuxSocket ? ['-L', tmuxSocket] : []), ...argv];
}

export class LocalExternalTmuxConnection {
  private readonly deviceId: string;
  private readonly deps: LocalExternalTmuxConnectionDeps;
  private readonly callbacks: TmuxConnectionOptions;
  private device: Device | null = null;
  private sessionName = 'tmex';
  private connected = false;
  private manualDisconnect = false;
  private activeWindowId: string | null = null;
  private activePaneId: string | null = null;
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private inputTransition: Promise<void> = Promise.resolve();
  private stackedLayoutTransition: Promise<void> = Promise.resolve();
  private bellDedup = new Map<string, number>();
  private closeNotified = false;
  private readonly lifecycle: ConnectionLifecycleEmitter;
  private readonly snapshotRefreshCoordinator = new SnapshotRefreshCoordinator(() =>
    this.performSnapshot()
  );
  private cleanupPromise: Promise<void> | null = null;
  private controlProcess: ControlClientProcess | null = null;
  private controlSubscription: ControlModeSubscription | null = null;
  private controlCommands = new ControlModeCommandQueue();
  private controlStartedAt = 0;
  private controlRestartCount = 0;
  private controlStderrTail = '';
  private spawnUnavailableNotified = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPending = false;
  private themeSubscriptions = createThemeSubscriptionTracker();
  private themeSubscriptionsRestored = false;

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<LocalExternalTmuxConnectionDeps> = {}
  ) {
    const platform = inputDeps.platform ?? process.platform;
    this.deviceId = options.deviceId;
    this.callbacks = options;
    this.deps = {
      enableSubscription: inputDeps.enableSubscription ?? true,
      platform,
      getDevice: inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId)),
      run: inputDeps.run ?? defaultRun,
      controlStalledTimeoutMs: inputDeps.controlStalledTimeoutMs,
      ensureGhosttyTerminfo:
        inputDeps.ensureGhosttyTerminfo ??
        (async () => {
          if (platform === 'win32') {
            return false;
          }
          const result = await this.deps.run(['/bin/sh', '-c', buildEnsureGhosttyTerminfoScript()]);
          return result.exitCode === 0;
        }),
      parkingCommand: inputDeps.parkingCommand ?? (() => getLocalParkingCommand(platform)),
      spawnControlClient: inputDeps.spawnControlClient ?? defaultSpawnControlClient,
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
    if (this.device.type !== 'local') {
      throw new Error(`LocalExternalTmuxConnection only supports local device: ${this.deviceId}`);
    }

    this.sessionName = this.device.session?.trim() || 'tmex';

    await this.assertTmuxCompatibility();
    const { created } = await this.ensureSession();
    const serverEpoch = await ensureStableServerEpoch((argv) => this.runTmuxAllowFailure(argv));
    this.callbacks.onSourceReady?.(serverEpoch);
    await this.configureSessionOptions();
    if (this.deps.enableSubscription) {
      await this.startControlClient();
    }
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
    if (!this.connected && this.manualDisconnect) {
      return;
    }

    this.manualDisconnect = true;
    this.connected = false;
    this.stopControlClient();
  }

  requestSnapshot(): void {
    void this.requestSnapshotInternal().catch((error) => {
      if (isTransientSpawnError(error)) {
        this.handleSpawnUnavailable(error instanceof Error ? error.message : String(error));
        return;
      }
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  sendInput(paneId: string, data: string): void {
    this.enqueueInputBytes(paneId, new TextEncoder().encode(data));
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    this.enqueueInputBytes(paneId, Uint8Array.from(data));
  }

  private enqueueInputBytes(paneId: string, data: Uint8Array): void {
    if (!this.connected) {
      return;
    }

    // 输入优先走 tmux 控制通道 stdin：每次按键 spawn 一个 tmux 子进程本身有毫秒级
    // 开销，且 exited 回调排在被输出扇出占满的事件循环尾部，连续输入时延迟线性累加。
    // 控制通道不可用时退回子进程路径。
    const task = async () => {
      for (const chunk of encodeBytesToHexChunks(data)) {
        const control = this.controlProcess;
        if (control) {
          await this.controlCommands.execute(
            (command) => control.write(command),
            ['send-keys', '-H', '-t', paneId, ...chunk].join(' '),
            { transform: () => undefined }
          );
        } else {
          await this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]);
        }
      }
    };

    const next = this.inputTransition.catch(() => undefined).then(task);
    this.inputTransition = next;
    void next.catch((error) => {
      this.callbacks.onError(error);
    });
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

  // 主题变化通知（mode 2031）：仅对输出流中声明过 CSI ?2031h 的 pane 注入
  // CSI ?997;{1|2}n（1=dark 2=light）。历史上无守卫广播注入曾污染空闲 shell
  // （readline 回显 "997;2n"），现靠订阅跟踪守卫；调用方须先更新 window-style
  // 再调本方法，否则 TUI 收通知后重查 OSC 11 会拿到旧色。
  signalThemeChange(paneId: string, theme: 'dark' | 'light'): void {
    if (!this.connected || !config.themeNotify2031Enabled) {
      return;
    }
    if (!this.themeSubscriptions.has(paneId)) {
      return;
    }
    this.sendInput(paneId, `\x1b[?997;${theme === 'dark' ? '1' : '2'}n`);
  }

  // 订阅状态除内存外落到 tmux pane 用户选项 @tmex_2031：与 pane 同生共死，
  // gateway 重启后靠 list-panes 一次性恢复（写失败不阻塞，仅日志）。
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

  // 按需读取 pane 当前可见屏幕的纯文本（无 ANSI 转义）；historyLines > 0 时
  // 额外包含可见区上方 N 行历史。供 Agent / Watch 等主动采样场景使用。
  // pane 缺失抛 TmuxTargetMissingError（静默形态，不触发连接告警/不污染设备状态）。
  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }

    const argv = ['capture-pane', '-t', paneId, '-p', '-J'];
    const historyLines = Math.floor(opts?.historyLines ?? 0);
    if (Number.isFinite(historyLines) && historyLines > 0) {
      argv.push('-S', `-${historyLines}`);
    }
    return (await this.runTmux(argv, 'silent')).stdout;
  }

  // 按需读取 pane 实时元信息（尺寸/光标/alternate/前台命令），供 Agent 理解 TUI。
  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    if (!this.connected) {
      throw new Error(`tmux connection not available: ${this.deviceId}`);
    }
    const { stdout } = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_META_FORMAT],
      'silent'
    );
    return parsePaneMeta(stdout);
  }

  async getPaneHistoryCaptureInfo(paneId: string) {
    if (!this.connected) throw new Error(`tmux connection not available: ${this.deviceId}`);
    const { stdout } = await this.runTmux(
      ['display-message', '-p', '-t', paneId, PANE_HISTORY_CAPTURE_INFO_FORMAT],
      'silent'
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
    const { stdout } = await this.runTmux(
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
      'silent'
    );
    if (new TextEncoder().encode(stdout).byteLength > maxOutputBytes) {
      throw new Error('tmux history capture exceeded bounded output');
    }
    return stdout;
  }

  capturePaneFrameAtBarrier(
    paneId: string,
    historyLines: number,
    onBarrier: () => void
  ): Promise<AtomicPaneCapture> {
    const control = this.controlProcess;
    if (!this.connected || !control) {
      return Promise.reject(new Error(`tmux control connection not available: ${this.deviceId}`));
    }
    return capturePaneFrameAtControlBarrier(
      this.controlCommands,
      (command) => control.write(command),
      paneId,
      historyLines,
      onBarrier
    );
  }

  private resolveDefaultWorkingDir(): string {
    return this.device?.defaultWorkingDir?.trim() || homedir();
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
    // control client 自带 attached+focused 标志，focus-events on 会把 ESC[I 投递给
    // ?1004h 的 pane（如 Claude Code），使其永久判定"用户在场"、通知静默，必须关闭。
    await this.runTmuxAllowFailure([
      'set-option',
      '-t',
      this.sessionName,
      '-g',
      'focus-events',
      'off',
    ]);
    // control client detach 不能触发 destroy-unattached 销毁会话。
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
      if (
        termProgram === 'ghostty' &&
        this.deps.platform !== 'win32' &&
        (await this.deps.ensureGhosttyTerminfo())
      ) {
        await this.runTmuxAllowFailure([
          'set-option',
          '-t',
          this.sessionName,
          'default-terminal',
          'xterm-ghostty',
        ]);
      }
    }

    // tmux 不传播 COLORTERM，TUI（如 codex）会据此判定不支持真彩色而跳过
    // 混色底色；前端 ghostty-wasm 始终支持真彩色，对新建 pane 显式声明。
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

  // tmux 对 pane 内 OSC 10/11 颜色查询的代答优先取 window-style，否则取 attached
  // client 上报的 tty 前景/背景色；控制模式 client 无法上报，tmux 会回复纯黑，
  // 导致 TUI（如 codex）按 fg/bg 混色画出的输入框底色与背景同色而不可见。
  // window option 无 session 层，需逐 window 设置并用 hook 覆盖后续新窗口。
  // styleValue 可能来自客户端，resolveTmuxWindowStyle 的白名单防止穿透 set-hook 引号。
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

  private async assertTmuxCompatibility(): Promise<void> {
    const result = await this.runTmuxAllowFailure(['-V']);
    if (result.exitCode !== 0) {
      if (config.tmuxBin !== 'tmux') {
        throw new Error(
          `configured tmux executable is unavailable: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        );
      }
      return;
    }
    const version = parseTmuxVersion(result.stdout.trim());
    if (this.deps.enableSubscription && !isControlModeSupported(version)) {
      throw new Error(
        `tmux ${version?.major}.${version?.minor} is too old for tmex (control mode requires tmux >= 3.0)`
      );
    }
    if (config.tmuxBin !== 'tmux') {
      const server = await this.runTmuxAllowFailure(['display-message', '-p', '#{version}']);
      if (
        server.exitCode === 0 &&
        server.stdout.trim() &&
        !tmuxClientMatchesServer(result.stdout, server.stdout)
      ) {
        const clientVersion = tmuxVersionIdentity(result.stdout) ?? 'unknown';
        const serverVersion = tmuxVersionIdentity(server.stdout) ?? 'unknown';
        throw new Error(
          `tmux client ${clientVersion} does not match existing server ${serverVersion}; refusing to modify the session`
        );
      }
    }
  }

  // tmux 在 client attach 时会无条件向当前窗口的活动 pane 投递焦点事件（不受
  // focus-events 选项约束，实验见 plan-00）。若该 pane 开了 ?1004h（如 Claude Code），
  // ESC[I 会让其永久判定"用户在场"、通知静默。规避：attach 前把会话当前窗口切到
  // 一次性 parking 窗口（仅运行等待命令，无 ?1004h），让焦点事件落空，attach 完成后切回并清理。
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
      this.deps.parkingCommand(),
    ]);
    if (result.exitCode !== 0) {
      console.warn(
        `[local] failed to create parking window on ${this.deviceId}, attaching without focus shield`
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
    // 先清除旧的心跳定时器，防止重连期间旧 timeout 回调看到新 controlProcess 后误杀。
    this.stopHeartbeat();

    let attachReadyResolve: (() => void) | null = null;
    const attachReady = new Promise<void>((resolve) => {
      attachReadyResolve = resolve;
    });

    const parkingWindowId = await this.createParkingWindow();
    let proc: ControlClientProcess;
    try {
      proc = this.spawnControlClientProcess(() => {
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

    // connect 阶段（connected 尚为 false）进程瞬退不会走重连，这里显式失败。
    if (this.controlProcess !== proc) {
      const message = this.controlStderrTail.trim() || 'tmux control client exited during attach';
      console.warn(
        `[local] tmux control client died during attach on ${this.deviceId}: ${message}`
      );
      throw new Error(message);
    }

    for (const command of SOURCE_METADATA_SUBSCRIPTION_COMMANDS) {
      void this.controlCommands
        .execute((value) => proc.write(value), command, { transform: () => undefined })
        .catch((error) => this.callbacks.onError(error));
    }

    this.startHeartbeat();
  }

  private spawnControlClientProcess(onAttachReady: () => void): ControlClientProcess {
    this.controlCommands.dispose('tmux control connection replaced');
    let proc: ControlClientProcess | null = null;
    const controlCommands = new ControlModeCommandQueue(
      () => proc?.kill(),
      this.deps.controlStalledTimeoutMs
    );
    this.controlCommands = controlCommands;
    const metricsOptions = isManagedExternally()
      ? {
          onMetrics: (metrics: ControlStreamMetricsSnapshot) => {
            console.log(
              `[tmux-metrics] control_stream interval_ms=${metrics.intervalMs} ` +
                `raw_chunks=${metrics.rawChunks} raw_bytes=${metrics.rawBytes} ` +
                `control_outputs=${metrics.controlOutputs} ` +
                `control_output_bytes=${metrics.controlOutputBytes} ` +
                `terminal_outputs=${metrics.terminalOutputs} ` +
                `terminal_output_bytes=${metrics.terminalOutputBytes} ` +
                `titles=${metrics.titles} bells=${metrics.bells} ` +
                `notifications=${metrics.notifications} ` +
                `structure_changes=${metrics.structureChanges} blocks=${metrics.blocks}`
            );
          },
        }
      : undefined;
    const subscription = createControlModeSubscription(
      {
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
        onPause: (paneId) => {
          const active = this.controlProcess;
          if (!active) return;
          void controlCommands
            .execute((value) => active.write(value), `refresh-client -A ${paneId}:continue`, {
              transform: () => undefined,
            })
            .catch((error) => this.callbacks.onError(error));
        },
        onExit: () => {},
        onBlockBegin: () => controlCommands.nextBlockIsLiteral(),
        onBlockEnd: (block) => {
          if (controlCommands.handleBlock(block)) return;
          onAttachReady();
        },
      },
      metricsOptions
    );

    proc = this.deps.spawnControlClient(
      buildLocalTmuxArgv(['-C', 'attach-session', '-t', this.sessionName])
    );
    this.controlProcess = proc;
    this.controlSubscription = subscription;
    this.controlStartedAt = Date.now();
    this.controlStderrTail = '';

    void this.pumpControlStdout(proc, subscription);
    void this.pumpControlStderr(proc);
    void proc.exited
      .then((exitCode) => {
        this.handleControlClientExit(proc, exitCode);
      })
      .catch(() => {
        this.handleControlClientExit(proc, -1);
      });
    return proc;
  }

  private async pumpControlStdout(
    proc: ControlClientProcess,
    subscription: ControlModeSubscription
  ): Promise<void> {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done || this.controlProcess !== proc) {
          break;
        }
        subscription.push(chunk.value);
      }
    } catch (error) {
      if (!this.manualDisconnect && !shouldIgnoreReaderAbortError(error)) {
        this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    subscription.end();
    if (this.controlProcess === proc) {
      console.warn(
        `[local] control client stdout ended unexpectedly on ${this.deviceId}, killing process`
      );
      proc.kill();
    }
  }

  private async pumpControlStderr(proc: ControlClientProcess): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (this.controlProcess === proc) {
          this.controlStderrTail = (this.controlStderrTail + decoder.decode(chunk.value)).slice(
            -CONTROL_STDERR_TAIL_LIMIT
          );
        }
      }
    } catch {
      /* stderr 噪声不影响主流程 */
    }
  }

  private stopControlClient(): void {
    this.stopHeartbeat();
    const proc = this.controlProcess;
    this.controlProcess = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    this.controlCommands.dispose();
    proc?.kill();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatPending = false;
  }

  private sendHeartbeat(): void {
    if (!this.controlProcess || this.heartbeatPending || !this.connected || this.manualDisconnect) {
      return;
    }
    this.heartbeatPending = true;
    const control = this.controlProcess;
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

  private onHeartbeatResponse(control: ControlClientProcess): void {
    if (this.controlProcess !== control || !this.heartbeatPending) {
      return;
    }
    this.heartbeatPending = false;
  }

  private handleControlClientExit(proc: ControlClientProcess, exitCode: number): void {
    if (this.controlProcess !== proc) {
      return;
    }
    this.controlProcess = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    if (!this.connected || this.manualDisconnect) {
      return;
    }
    void this.reconnectControlClient(exitCode);
  }

  private async reconnectControlClient(exitCode: number): Promise<void> {
    if (Date.now() - this.controlStartedAt > CONTROL_STABLE_RESET_MS) {
      this.controlRestartCount = 0;
    }
    this.controlRestartCount += 1;
    const stderrMessage = this.controlStderrTail.trim();

    if (this.controlRestartCount > CONTROL_MAX_RESTARTS) {
      const message =
        stderrMessage || `tmux control client exited repeatedly (last code ${exitCode})`;
      console.warn(`[local] tmux control client gave up on ${this.deviceId}: ${message}`);
      void this.notifyRuntimeError(message);
      void this.shutdownInternal(true);
      return;
    }

    console.warn(
      `[local] tmux control client exited (code ${exitCode}) on ${this.deviceId}, reconnecting (attempt ${this.controlRestartCount})`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, CONTROL_RESTART_DELAY_MS * this.controlRestartCount)
    );
    if (!this.connected || this.manualDisconnect) {
      return;
    }

    const probe = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (probe.exitCode === TMUX_SPAWN_UNAVAILABLE_EXIT) {
      // 探测会话时进程资源暂时不足：不判定 session gone、不 shutdown，退避后再排一次重连，
      // 且不计入放弃预算，避免本机进程压力误杀一个其实健在的会话。
      this.handleSpawnUnavailable(probe.stderr);
      this.controlRestartCount = Math.max(0, this.controlRestartCount - 1);
      if (this.connected && !this.manualDisconnect) {
        setTimeout(() => {
          void this.reconnectControlClient(exitCode);
        }, CONTROL_RESTART_DELAY_MS * 4);
      }
      return;
    }
    if (probe.exitCode !== 0) {
      const message = probe.stderr.trim() || probe.stdout.trim() || 'tmux session gone';
      console.warn(`[local] tmux session gone on ${this.deviceId}: ${message}`);
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
      // 瞬退会再次触发 exit 处理并按重试计数走重连/放弃，这里仅记录
      console.warn(`[local] control client restart failed on ${this.deviceId}:`, error);
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
        true
      )
    ).stdout;
    const alternate = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-a', '-S', '-', '-E', '-', '-e', '-J', '-N', '-p', '-q'],
        true
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
        ['#{session_id}', '#{session_name}'].join(SNAPSHOT_FIELD_SEPARATOR),
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

    const transientResult = [sessionRes, windowsRes, panesRes].find(
      (res) => res.exitCode === TMUX_SPAWN_UNAVAILABLE_EXIT
    );
    if (transientResult) {
      // 进程压力下抓快照失败：保留现有快照，等下次事件/重连再刷，绝不据此判定 server gone。
      this.handleSpawnUnavailable(transientResult.stderr);
      return;
    }

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      const stderrBlob = `${sessionRes.stderr}\n${windowsRes.stderr}\n${panesRes.stderr}`;
      if (this.connected && !this.manualDisconnect && this.isTmuxServerGoneMessage(stderrBlob)) {
        const message =
          stderrBlob
            .trim()
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim() ?? 'tmux server gone';
        console.warn(`[local] tmux server gone during snapshot on ${this.deviceId}: ${message}`);
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
    this.markSpawnRecovered();
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
        console.warn(`[local] ignoring invalid tmux session id on ${this.deviceId}: ${id ?? ''}`);
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
          `[local] ignoring invalid tmux window snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
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
          `[local] ignoring invalid tmux pane snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
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
      console.warn(`[local] ignoring tmux snapshot with no valid windows on ${this.deviceId}`);
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

  // allowTargetMissing:
  // - false：失败即告警（connectionAlertNotifier / runtime status）并抛错
  // - true：target missing 时静默恢复（清空 active 指针 + 重新快照）并返回原结果
  // - 'silent'：target missing 时抛 TmuxTargetMissingError，不告警、不污染设备状态
  private async runTmux(
    argv: string[],
    allowTargetMissing: boolean | 'silent' = false
  ): Promise<CommandResult> {
    const result = await this.runTmuxAllowFailure(argv);
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
      `[local] tmux command failed deviceId=${this.deviceId} sessionName=${this.sessionName} argv=${argv.join(' ')} exitCode=${result.exitCode}: ${message}`
    );
    void this.notifyRuntimeError(message);
    if (this.connected && !this.manualDisconnect && this.isTmuxServerGoneMessage(message)) {
      console.warn(`[local] tmux server gone on ${this.deviceId}: ${message}`);
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      this.lifecycle.notifySessionClosed(message);
      void this.shutdownInternal(true);
    }
    throw new Error(message);
  }

  private async notifyRuntimeError(message: string): Promise<void> {
    const device = getDeviceById(this.deviceId);
    if (!device) {
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      return;
    }
    await connectionAlertNotifier.notify({
      device,
      error: new Error(message),
      source: 'runtime',
      silentTelegram: true,
    });
  }

  // 本机进程数耗尽导致 tmux 无法 spawn：瞬时故障，退避重试即可。告警/日志仅一次，
  // 成功一次后由 markSpawnRecovered 复位，避免刷屏（同类故障单次通知）。
  private handleSpawnUnavailable(message: string): void {
    if (this.spawnUnavailableNotified) {
      return;
    }
    this.spawnUnavailableNotified = true;
    const detail = (message || 'tmux spawn unavailable (process table exhausted)').trim();
    console.warn(
      `[local] tmux spawn unavailable on ${this.deviceId} (process pressure), degrading without shutdown: ${detail}`
    );
    void this.notifyRuntimeError(detail);
  }

  private markSpawnRecovered(): void {
    this.spawnUnavailableNotified = false;
  }

  private async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    try {
      return await this.deps.run(buildLocalTmuxArgv(argv));
    } catch (error) {
      // 进程资源暂时耗尽时 Bun.spawn 直接抛错。降级为「命令失败」语义，避免逃逸成
      // unhandledRejection；上层据 TMUX_SPAWN_UNAVAILABLE_EXIT 退避重试而非判定连接失效。
      if (isTransientSpawnError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: TMUX_SPAWN_UNAVAILABLE_EXIT, stdout: '', stderr: message };
      }
      throw error;
    }
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
    })();

    await this.cleanupPromise;
    this.cleanupPromise = null;

    if (notifyClose && !this.closeNotified && !this.manualDisconnect) {
      this.closeNotified = true;
      this.callbacks.onClose();
    }
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
}
