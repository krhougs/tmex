import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { config } from '../config';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { buildLocalTmuxEnv, getLocalShellPath } from '../tmux/local-shell-path';
import { quoteShellArg } from './command-builder';
import type { TmuxConnectionOptions } from './connection-types';
import { createRuntimeFsPaths } from './fs-paths';
import { encodeInputToHexChunks } from './input-encoder';
import { createPaneStreamParser, type PaneStreamNotification } from './pane-stream-parser';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LocalExternalTmuxConnectionDeps {
  enableHooks: boolean;
  getDevice: (deviceId: string) => Device | null;
  run: (argv: string[]) => Promise<CommandResult>;
}

interface PaneReaderHandle {
  paneId: string;
  fifoPath: string;
  stopReader: () => void;
}

const DEFAULT_CHUNK_HISTORY_LINES = '-1000';

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
  private paneReaders = new Map<string, PaneReaderHandle>();
  private pipeTransition: Promise<void> = Promise.resolve();
  private inputTransition: Promise<void> = Promise.resolve();
  private hookReadAbort: (() => void) | null = null;
  private hookBuffer = '';
  private bellDedup = new Map<string, number>();
  private fsPaths = createRuntimeFsPaths({
    deviceId: 'pending',
    sessionName: 'pending',
    gatewayPid: process.pid,
  });

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<LocalExternalTmuxConnectionDeps> = {}
  ) {
    this.deviceId = options.deviceId;
    this.callbacks = options;
    this.deps = {
      enableHooks: inputDeps.enableHooks ?? true,
      getDevice: inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId)),
      run: inputDeps.run ?? defaultRun,
    };
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.device = this.deps.getDevice(this.deviceId);
    if (!this.device) {
      throw new Error(`Device not found: ${this.deviceId}`);
    }
    if (this.device.type !== 'local') {
      throw new Error(`LocalExternalTmuxConnection only supports local device: ${this.deviceId}`);
    }

    this.sessionName = this.device.session?.trim() || 'tmex';
    this.fsPaths = createRuntimeFsPaths({
      deviceId: this.deviceId,
      sessionName: this.sessionName,
      gatewayPid: process.pid,
    });
    this.ensureRuntimeDirs();

    await this.ensureSession();
    await this.configureSessionOptions();
    if (this.deps.enableHooks) {
      await this.startHooks();
    }
    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
    });
    await this.requestSnapshotInternal();
  }

  disconnect(): void {
    if (!this.connected && this.manualDisconnect) {
      return;
    }

    this.manualDisconnect = true;
    this.connected = false;
    void this.stopAllPipeReaders();
    if (this.deps.enableHooks) {
      void this.stopHooks();
    }
    rmSync(this.fsPaths.rootDir, { recursive: true, force: true });
  }

  requestSnapshot(): void {
    void this.requestSnapshotInternal();
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

  private async ensureSession(): Promise<void> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return;
    }

    await this.runTmux(['new-session', '-d', '-c', homedir(), '-s', this.sessionName]);
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
    await this.runTmuxAllowFailure(['set-option', '-t', this.sessionName, '-g', 'focus-events', 'on']);
  }

  private ensureRuntimeDirs(): void {
    mkdirSync(this.fsPaths.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.fsPaths.panesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.fsPaths.hooksDir, { recursive: true, mode: 0o700 });
  }

  private async startHooks(): Promise<void> {
    this.ensureRuntimeDirs();
    const fifoPath = this.fsPaths.hookFifoPath;
    rmSync(fifoPath, { force: true });
    await this.runShell(`mkfifo ${quoteShellArg(fifoPath)}`);

    const readerProcess = Bun.spawn(
      ['/bin/sh', '-lc', `tail -n +1 -f ${quoteShellArg(fifoPath)}`],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const reader = readerProcess.stdout.getReader();
    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          this.handleHookChunk(new TextDecoder().decode(chunk.value));
        }
      } catch (error) {
        if (!this.manualDisconnect && !shouldIgnoreReaderAbortError(error)) {
          this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    this.hookReadAbort = () => {
      reader.releaseLock();
      readerProcess.kill();
      rmSync(fifoPath, { force: true });
    };

    await this.installHook('pane-exited', ['pane-exited', '#{window_id}', '#{pane_id}']);
    await this.installHook('pane-died', ['pane-died', '#{window_id}', '#{pane_id}']);
    await this.installHook('after-new-window', ['refresh']);
    await this.installHook('after-split-window', ['refresh']);
  }

  private async stopHooks(): Promise<void> {
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'pane-exited']);
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'pane-died']);
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'after-new-window']);
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'after-split-window']);
    this.hookReadAbort?.();
    this.hookReadAbort = null;
    this.hookBuffer = '';
  }

  private async installHook(hookName: string, fields: string[]): Promise<void> {
    const fifoPath = this.fsPaths.hookFifoPath;
    const innerScript = `printf '%s\\t%s\\t%s\\n' ${fields
      .map((field) => quoteShellArg(field))
      .join(' ')} >> ${quoteShellArg(fifoPath)}`;
    await this.runTmux([
      'set-hook',
      '-t',
      this.sessionName,
      hookName,
      `run-shell -b ${quoteShellArg(innerScript)}`,
    ]);
  }

  private handleHookChunk(text: string): void {
    this.hookBuffer += text;

    while (true) {
      const newlineIndex = this.hookBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }

      const line = this.hookBuffer.slice(0, newlineIndex).trim();
      this.hookBuffer = this.hookBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const [type, windowId, paneId] = line.split('\t');
      if (type === 'bell') {
        continue;
      }

      if (type === 'pane-exited' || type === 'pane-died' || type === 'refresh') {
        this.requestSnapshot();
      }
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
    const mode = (
      await this.runTmux(['display-message', '-p', '-t', paneId, '#{alternate_on}'], true)
    ).stdout.trim();
    const alternateScreen = mode === '1';
    const normal = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-S', '-', '-E', '-', '-e', '-N', '-p'],
        true
      )
    ).stdout;
    const alternate = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-a', '-S', '-', '-E', '-', '-e', '-N', '-p', '-q'],
        true
      )
    ).stdout;

    const history = alternateScreen
      ? hasRenderableTerminalContent(normal)
        ? normal
        : alternate
      : normal || alternate;

    if (history) {
      this.callbacks.onTerminalHistory(paneId, history, alternateScreen);
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
        '#{session_id}\t#{session_name}',
      ]),
      this.runTmuxAllowFailure([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        '#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}',
      ]),
      this.runTmuxAllowFailure([
        'list-panes',
        '-t',
        this.sessionName,
        '-F',
        '#{pane_id}\t#{window_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{pane_width}\t#{pane_height}',
      ]),
    ]);

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      this.callbacks.onSnapshot({ deviceId: this.deviceId, session: null });
      return;
    }

    this.parseSnapshotSession(sessionRes.stdout.split(/\r?\n/));
    this.parseSnapshotWindows(windowsRes.stdout.split(/\r?\n/));
    this.parseSnapshotPanes(panesRes.stdout.split(/\r?\n/));
    await this.syncPipeReaders();
    this.emitSnapshot();
  }

  private parseSnapshotSession(lines: string[]): void {
    this.snapshotSession = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const [id, name] = line.split('\t');
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
      const [id, indexRaw, name, activeRaw] = line.split('\t');
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
      const [paneId, windowId, indexRaw, titleRaw, activeRaw, widthRaw, heightRaw] =
        line.split('\t');
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
        active: activeRaw === '1',
        width: Number.isNaN(width) ? 0 : width,
        height: Number.isNaN(height) ? 0 : height,
      };

      if (pane.active) {
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

  private async startPipeForPaneNow(paneId: string): Promise<void> {
    if (this.paneReaders.has(paneId)) {
      return;
    }

    const fifoPath = this.fsPaths.paneFifoPath(paneId);
    this.ensureRuntimeDirs();
    rmSync(fifoPath, { force: true });
    await this.runShell(`mkfifo ${quoteShellArg(fifoPath)}`);

    const parser = createPaneStreamParser({
      onTitle: (title) => {
        this.pendingPaneTitles.set(paneId, title);
        this.requestSnapshot();
      },
      onBell: () => {
        this.recordBell(paneId);
      },
      onNotification: (notification) => {
        this.emitNotification(paneId, notification);
      },
    });
    const readerProcess = Bun.spawn(['/bin/sh', '-lc', `cat ${quoteShellArg(fifoPath)}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = readerProcess.stdout.getReader();
    const stopReader = () => {
      reader.releaseLock();
      readerProcess.kill();
      rmSync(fifoPath, { force: true });
    };

    this.paneReaders.set(paneId, { paneId, fifoPath, stopReader });

    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          const output = parser.push(chunk.value);
          if (output.length > 0) {
            this.callbacks.onTerminalOutput(paneId, output);
          }
        }
      } catch (error) {
        if (!this.manualDisconnect && !shouldIgnoreReaderAbortError(error)) {
          this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    try {
      await this.runTmux(['pipe-pane', '-O', '-t', paneId, `cat >${fifoPath}`]);
    } catch (error) {
      this.paneReaders.delete(paneId);
      stopReader();
      throw error;
    }
  }

  private async stopPipeForPaneNow(paneId: string): Promise<void> {
    const handle = this.paneReaders.get(paneId);
    if (!handle) {
      return;
    }

    this.paneReaders.delete(paneId);
    await this.runTmuxAllowFailure(['pipe-pane', '-t', paneId]);
    handle.stopReader();
  }

  private async syncPipeReaders(): Promise<void> {
    const expectedPaneIds = this.getExpectedPaneIds();
    const expectedSet = new Set(expectedPaneIds);

    await this.queuePipeTransition(async () => {
      for (const paneId of Array.from(this.paneReaders.keys())) {
        if (!expectedSet.has(paneId)) {
          await this.stopPipeForPaneNow(paneId);
        }
      }
      for (const paneId of expectedPaneIds) {
        if (!this.paneReaders.has(paneId)) {
          await this.startPipeForPaneNow(paneId);
        }
      }
    });
  }

  private async stopAllPipeReaders(): Promise<void> {
    await this.queuePipeTransition(async () => {
      for (const paneId of Array.from(this.paneReaders.keys())) {
        await this.stopPipeForPaneNow(paneId);
      }
    });
  }

  private queuePipeTransition(task: () => Promise<void>): Promise<void> {
    const next = this.pipeTransition.catch(() => undefined).then(task);
    this.pipeTransition = next;
    return next;
  }

  private async runShell(command: string): Promise<void> {
    const result = await this.deps.run(['/bin/sh', '-lc', command]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `shell command failed: ${command}`);
    }
  }

  private async runTmux(argv: string[], allowTargetMissing = false): Promise<CommandResult> {
    const result = await this.runTmuxAllowFailure(argv);
    if (result.exitCode === 0) {
      return result;
    }

    const message = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tmux command failed: ${argv.join(' ')}`
    ).trim();
    if (allowTargetMissing && this.isRecoverableTargetMissingError(message)) {
      this.recoverFromTargetMissingError(message);
      return result;
    }

    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
    throw new Error(message);
  }

  private async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    return this.deps.run(['tmux', ...argv]);
  }

  private isRecoverableTargetMissingError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("can't find window") ||
      normalized.includes("can't find pane") ||
      normalized.includes('no such window') ||
      normalized.includes('no such pane')
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
}
