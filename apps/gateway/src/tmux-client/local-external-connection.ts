import { homedir } from 'node:os';
import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { config } from '../config';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { buildLocalTmuxEnv, getLocalShellPath } from '../tmux/local-shell-path';
import {
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneMeta,
  parsePaneScreenInfo,
} from './capture-history';
import type { TmuxConnectionOptions } from './connection-types';
import {
  type ControlModeSubscription,
  createControlModeSubscription,
} from './control-mode-subscription';
import { buildEnsureGhosttyTerminfoScript } from './ghostty-terminfo';
import { encodeInputToHexChunks } from './input-encoder';
import type { PaneStreamNotification } from './pane-stream-parser';
import {
  SNAPSHOT_FIELD_SEPARATOR,
  formatSnapshotRowForLog,
  isTmuxPaneId,
  isTmuxSessionId,
  isTmuxWindowId,
  parseSnapshotInteger,
  splitSnapshotFields,
} from './snapshot-format';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { isControlModeSupported, parseTmuxVersion } from './tmux-version';
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
}

interface LocalExternalTmuxConnectionDeps {
  enableSubscription: boolean;
  getDevice: (deviceId: string) => Device | null;
  run: (argv: string[]) => Promise<CommandResult>;
  ensureGhosttyTerminfo: () => Promise<boolean>;
  spawnControlClient: (argv: string[]) => ControlClientProcess;
}

const CONTROL_MAX_RESTARTS = 3;
const CONTROL_RESTART_DELAY_MS = 500;
const CONTROL_STABLE_RESET_MS = 10_000;
const CONTROL_STDERR_TAIL_LIMIT = 2048;
const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
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

function defaultRun(argv: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const subprocess = Bun.spawn(argv, {
      env: buildLocalTmuxEnv(getLocalShellPath()),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        resolve({ stdout, stderr, exitCode });
      })
      .catch(reject);
  });
}

function defaultSpawnControlClient(argv: string[]): ControlClientProcess {
  const subprocess = Bun.spawn(argv, {
    env: buildLocalTmuxEnv(getLocalShellPath()),
    // stdin 保持打开（tmux -C 在 stdin EOF 时退出），但永不写入。
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
  };
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
  private pendingPaneTitles = new Map<string, string>();
  private snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null = null;
  private snapshotWindows = new Map<string, TmuxWindow>();
  private inputTransition: Promise<void> = Promise.resolve();
  private bellDedup = new Map<string, number>();
  private closeNotified = false;
  private cleanupPromise: Promise<void> | null = null;
  private controlProcess: ControlClientProcess | null = null;
  private controlSubscription: ControlModeSubscription | null = null;
  private controlStartedAt = 0;
  private controlRestartCount = 0;
  private controlStderrTail = '';
  private spawnUnavailableNotified = false;

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<LocalExternalTmuxConnectionDeps> = {}
  ) {
    this.deviceId = options.deviceId;
    this.callbacks = options;
    this.deps = {
      enableSubscription: inputDeps.enableSubscription ?? true,
      getDevice: inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId)),
      run: inputDeps.run ?? defaultRun,
      ensureGhosttyTerminfo:
        inputDeps.ensureGhosttyTerminfo ??
        (async () => {
          const result = await this.deps.run(['/bin/sh', '-c', buildEnsureGhosttyTerminfoScript()]);
          return result.exitCode === 0;
        }),
      spawnControlClient: inputDeps.spawnControlClient ?? defaultSpawnControlClient,
    };
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.closeNotified = false;
    this.device = this.deps.getDevice(this.deviceId);
    if (!this.device) {
      throw new Error(`Device not found: ${this.deviceId}`);
    }
    if (this.device.type !== 'local') {
      throw new Error(`LocalExternalTmuxConnection only supports local device: ${this.deviceId}`);
    }

    this.sessionName = this.device.session?.trim() || 'tmex';

    if (this.deps.enableSubscription) {
      await this.assertControlModeSupport();
    }
    await this.ensureSession();
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
    if (!this.connected) {
      return;
    }

    const task = async () => {
      for (const chunk of encodeInputToHexChunks(data)) {
        await this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]);
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

  createWindow(name?: string): void {
    if (!this.connected) {
      return;
    }

    const argv = ['new-window', '-t', this.sessionName, '-c', this.resolveDefaultWorkingDir()];
    if (name) {
      argv.push('-n', name);
    }
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

  // TMEX_TMUX_WINDOW_STYLE=off 表示用户不希望 tmex 接管 window-style，动态更新同样跳过。
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

  private resolveDefaultWorkingDir(): string {
    return this.device?.defaultWorkingDir?.trim() || homedir();
  }

  private async ensureSession(): Promise<void> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return;
    }

    await this.runTmux(['new-session', '-d', '-c', this.resolveDefaultWorkingDir(), '-s', this.sessionName]);
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
    // control client 自带 attached+focused 标志，focus-events on 会把 ESC[I 投递给
    // ?1004h 的 pane（如 Claude Code），使其永久判定"用户在场"、通知静默，必须关闭。
    await this.runTmuxAllowFailure(['set-option', '-t', this.sessionName, '-g', 'focus-events', 'off']);
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
      if (termProgram === 'ghostty' && (await this.deps.ensureGhosttyTerminfo())) {
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

  private async assertControlModeSupport(): Promise<void> {
    const result = await this.runTmuxAllowFailure(['-V']);
    if (result.exitCode !== 0) {
      return;
    }
    const version = parseTmuxVersion(result.stdout.trim());
    if (!isControlModeSupported(version)) {
      throw new Error(
        `tmux ${version?.major}.${version?.minor} is too old for tmex (control mode requires tmux >= 3.0)`
      );
    }
  }

  // tmux 在 client attach 时会无条件向当前窗口的活动 pane 投递焦点事件（不受
  // focus-events 选项约束，实验见 plan-00）。若该 pane 开了 ?1004h（如 Claude Code），
  // ESC[I 会让其永久判定"用户在场"、通知静默。规避：attach 前把会话当前窗口切到
  // 一次性 parking 窗口（裸 sleep，无 ?1004h），让焦点事件落空，attach 完成后切回并清理。
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
      console.warn(`[local] tmux control client died during attach on ${this.deviceId}: ${message}`);
      throw new Error(message);
    }
  }

  private spawnControlClientProcess(onAttachReady: () => void): ControlClientProcess {
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
      onPromptMarker: (paneId, marker) => {
        this.callbacks.onPromptMarker?.(paneId, marker);
      },
      onClipboardWrite: (paneId, text) => {
        this.callbacks.onClipboardWrite?.(paneId, text);
      },
      onStructureChanged: () => {
        this.requestSnapshot();
      },
      onExit: () => {},
      onBlockEnd: () => {
        onAttachReady();
      },
    });

    const proc = this.deps.spawnControlClient([
      'tmux',
      ...(config.tmuxSocket ? ['-L', config.tmuxSocket] : []),
      '-C',
      'attach-session',
      '-t',
      this.sessionName,
    ]);
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
    const proc = this.controlProcess;
    this.controlProcess = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    proc?.kill();
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
      await this.runTmux(['new-window', '-d', '-t', this.sessionName, '-c', this.resolveDefaultWorkingDir()]);
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
        ['#{session_id}', '#{session_name}'].join(SNAPSHOT_FIELD_SEPARATOR),
      ]),
      this.runTmuxAllowFailure([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        ['#{window_id}', '#{window_index}', '#{window_name}', '#{window_active}'].join(
          SNAPSHOT_FIELD_SEPARATOR
        ),
      ]),
      this.runTmuxAllowFailure([
        'list-panes',
        '-s',
        '-t',
        this.sessionName,
        '-F',
        [
          '#{pane_id}',
          '#{window_id}',
          '#{pane_index}',
          '#{pane_title}',
          '#{pane_active}',
          '#{pane_width}',
          '#{pane_height}',
          '#{window_active}',
          '#{pane_current_command}',
        ].join(SNAPSHOT_FIELD_SEPARATOR),
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
      if (
        this.connected &&
        !this.manualDisconnect &&
        this.isTmuxServerGoneMessage(stderrBlob)
      ) {
        const message = stderrBlob.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ??
          'tmux server gone';
        console.warn(`[local] tmux server gone during snapshot on ${this.deviceId}: ${message}`);
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
    this.discardInvalidSnapshot();
    this.controlSubscription?.prunePanes(new Set(this.getExpectedPaneIds()));
    this.markSpawnRecovered();
    this.emitSnapshot();
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
      const [id, indexRaw, name, activeRaw] = splitSnapshotFields(line, 4);
      const index = parseSnapshotInteger(indexRaw);
      if (!isTmuxWindowId(id) || index === null || !this.isSnapshotFlag(activeRaw)) {
        console.warn(
          `[local] ignoring invalid tmux window snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      const active = activeRaw === '1';
      if (active) {
        this.activeWindowId = id;
      }
      this.snapshotWindows.set(id, {
        id,
        index,
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
      const [paneId, windowId, indexRaw, titleRaw, activeRaw, widthRaw, heightRaw, windowActiveRaw, currentCommandRaw] =
        splitSnapshotFields(line, 9);
      const index = parseSnapshotInteger(indexRaw);
      const width = parseSnapshotInteger(widthRaw);
      const height = parseSnapshotInteger(heightRaw);
      if (
        !isTmuxPaneId(paneId) ||
        !isTmuxWindowId(windowId) ||
        index === null ||
        width === null ||
        height === null ||
        !this.isSnapshotFlag(activeRaw) ||
        !this.isSnapshotFlag(windowActiveRaw)
      ) {
        console.warn(
          `[local] ignoring invalid tmux pane snapshot row on ${this.deviceId}: ${formatSnapshotRowForLog(line)}`
        );
        continue;
      }
      const pane: TmuxPane = {
        id: paneId,
        windowId,
        index,
        title: this.pendingPaneTitles.get(paneId) ?? (titleRaw?.trim() ? titleRaw : undefined),
        currentCommand: currentCommandRaw?.trim() ? currentCommandRaw.trim() : undefined,
        // pane_active 是窗口内 active；list-panes -s 下每个窗口都有一个
        active: activeRaw === '1',
        width,
        height,
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
    const socketArgs = config.tmuxSocket ? ['-L', config.tmuxSocket] : [];
    try {
      return await this.deps.run(['tmux', ...socketArgs, ...argv]);
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
