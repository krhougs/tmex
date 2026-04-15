import type { Device, StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import { decryptWithContext } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { resolveSshAgentSocket, resolveSshUsername } from '../tmux/ssh-auth';
import { joinShellArgs, quoteShellArg } from './command-builder';
import type { TmuxConnectionOptions } from './connection-types';
import { createRuntimeFsPaths } from './fs-paths';
import { encodeInputToHexChunks } from './input-encoder';
import { createPaneTitleParser } from './pane-title-parser';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';

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

const DEFAULT_HISTORY_LINES = '-1000';
const BELL_DEDUP_WINDOW_MS = 200;
const COMMAND_SENTINEL = '\x1eTMEX_END ';

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
  private currentPipePaneId: string | null = null;
  private pipeReadAbort: (() => void) | null = null;
  private pipeTransition: Promise<void> = Promise.resolve();
  private hookReadAbort: (() => void) | null = null;
  private hookBuffer = '';
  private bellDedup = new Map<string, number>();
  private fsPaths = createRuntimeFsPaths({
    deviceId: 'pending',
    sessionName: 'pending',
    gatewayPid: process.pid,
  });
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
    this.fsPaths = createRuntimeFsPaths({
      deviceId: this.deviceId,
      sessionName: this.sessionName,
      gatewayPid: process.pid,
    });

    await this.connectSshClient();
    await this.openCommandChannel();
    await this.ensureRemoteRuntimeDirs();
    await this.ensureSession();
    await this.startHooks();

    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
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

    void this.selectPaneInternal(windowId, paneId).catch((error) => {
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

    const argv = name ? ['new-window', '-n', name] : ['new-window'];
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

  private async connectSshClient(): Promise<void> {
    if (!this.device) {
      throw new Error('SSH device not loaded');
    }
    const host = this.device.host;
    const port = this.device.port ?? 22;
    const username = resolveSshUsername(this.device.username, this.device.authMode);
    if (this.device.authMode === 'configRef' || (!host && this.device.sshConfigRef)) {
      throw new Error(
        'ssh_config_ref_not_supported: 当前版本暂不支持 SSH Config 引用，请改为填写 host + username，并选择 Agent/私钥/密码认证'
      );
    }
    if (!host) {
      throw new Error('SSH device missing host');
    }

    const authConfig: ConnectConfig = {
      host,
      port,
      username,
    };

    switch (this.device.authMode) {
      case 'password': {
        if (!this.device.passwordEnc) {
          throw new Error('auth_password_missing: 密码认证未提供密码');
        }
        authConfig.password = await this.deps.decrypt(this.device.passwordEnc, {
          scope: 'device',
          entityId: this.device.id,
          field: 'password_enc',
        });
        break;
      }
      case 'key': {
        if (!this.device.privateKeyEnc) {
          throw new Error('auth_key_missing: 私钥认证未提供私钥');
        }
        authConfig.privateKey = await this.deps.decrypt(this.device.privateKeyEnc, {
          scope: 'device',
          entityId: this.device.id,
          field: 'private_key_enc',
        });
        if (this.device.privateKeyPassphraseEnc) {
          authConfig.passphrase = await this.deps.decrypt(this.device.privateKeyPassphraseEnc, {
            scope: 'device',
            entityId: this.device.id,
            field: 'private_key_passphrase_enc',
          });
        }
        break;
      }
      case 'agent': {
        authConfig.agent = resolveSshAgentSocket('agent');
        break;
      }
      case 'auto': {
        const agentSocket = resolveSshAgentSocket('auto');
        if (agentSocket) {
          authConfig.agent = agentSocket;
        }
        if (this.device.privateKeyEnc) {
          authConfig.privateKey = await this.deps.decrypt(this.device.privateKeyEnc, {
            scope: 'device',
            entityId: this.device.id,
            field: 'private_key_enc',
          });
        } else if (this.device.passwordEnc) {
          authConfig.password = await this.deps.decrypt(this.device.passwordEnc, {
            scope: 'device',
            entityId: this.device.id,
            field: 'password_enc',
          });
        }
        break;
      }
      case 'configRef':
        break;
    }

    if (
      this.device.authMode === 'auto' &&
      !authConfig.agent &&
      !authConfig.privateKey &&
      !authConfig.password
    ) {
      throw new Error(
        'auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）'
      );
    }

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
  }

  private async ensureRemoteRuntimeDirs(): Promise<void> {
    await this.runShell(
      [
        `mkdir -p ${quoteShellArg(this.fsPaths.rootDir)}`,
        `mkdir -p ${quoteShellArg(this.fsPaths.panesDir)}`,
        `mkdir -p ${quoteShellArg(this.fsPaths.hooksDir)}`,
        `chmod 700 ${quoteShellArg(this.fsPaths.rootDir)}`,
        `chmod 700 ${quoteShellArg(this.fsPaths.panesDir)}`,
        `chmod 700 ${quoteShellArg(this.fsPaths.hooksDir)}`,
      ].join('\n')
    );
  }

  private async ensureSession(): Promise<void> {
    const exists = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (exists.exitCode === 0) {
      return;
    }

    await this.runTmux(['new-session', '-d', '-c', this.remoteHomeDir, '-s', this.sessionName]);
  }

  private async startHooks(): Promise<void> {
    await this.ensureRemoteRuntimeDirs();
    const fifoPath = this.fsPaths.hookFifoPath;
    await this.runShell(
      `rm -f ${quoteShellArg(fifoPath)} && mkfifo ${quoteShellArg(fifoPath)} && chmod 600 ${quoteShellArg(fifoPath)}`
    );

    const stopReader = await this.openReaderChannel(
      `exec tail -n +1 -f ${quoteShellArg(fifoPath)}`,
      {
        onData: (data) => {
          this.handleHookChunk(data.toString());
        },
        onClose: () => {
          if (!this.manualDisconnect) {
            this.callbacks.onError(new Error('SSH hook reader closed unexpectedly'));
          }
        },
      }
    );
    this.hookReadAbort = () => {
      stopReader();
      void this.runShellAllowFailure(`rm -f ${quoteShellArg(fifoPath)}`);
    };

    await this.installHook('alert-bell', ['bell', '#{window_id}', '#{pane_id}']);
    await this.installHook('pane-exited', ['pane-exited', '#{window_id}', '#{pane_id}']);
    await this.installHook('pane-died', ['pane-died', '#{window_id}', '#{pane_id}']);
  }

  private async stopHooks(): Promise<void> {
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'alert-bell']);
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'pane-exited']);
    await this.runTmuxAllowFailure(['set-hook', '-u', '-t', this.sessionName, 'pane-died']);
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
        const key = paneId || windowId || '-';
        const previous = this.bellDedup.get(key) ?? 0;
        const now = Date.now();
        if (now - previous >= BELL_DEDUP_WINDOW_MS) {
          this.bellDedup.set(key, now);
          this.callbacks.onEvent({
            type: 'bell',
            data: {
              windowId: windowId || undefined,
              paneId: paneId || this.activePaneId || undefined,
            },
          });
        }
        continue;
      }

      if (type === 'pane-exited' || type === 'pane-died') {
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

  private async selectPaneInternal(windowId: string, paneId: string): Promise<void> {
    this.activeWindowId = windowId;
    this.activePaneId = paneId;

    await this.runTmux(['select-window', '-t', windowId], true);
    await this.runTmux(['select-pane', '-t', paneId], true);
    await this.startPipeForPane(paneId);
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
    const normal = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-S', DEFAULT_HISTORY_LINES, '-e', '-p'],
        true,
        30000
      )
    ).stdout;
    const alternate = (
      await this.runTmux(
        ['capture-pane', '-t', paneId, '-a', '-S', DEFAULT_HISTORY_LINES, '-e', '-p', '-q'],
        true,
        30000
      )
    ).stdout;

    const preferAlternate = mode === '1';
    const history = preferAlternate
      ? alternate || normal
      : mode === '0'
        ? normal || alternate
        : alternate.length > normal.length
          ? alternate
          : normal;

    if (history) {
      this.callbacks.onTerminalHistory(paneId, history);
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

  private async startPipeForPane(paneId: string): Promise<void> {
    await this.queuePipeTransition(async () => {
      if (this.currentPipePaneId === paneId) {
        return;
      }

      await this.stopPipeNow();

      const fifoPath = this.fsPaths.paneFifoPath(paneId);
      await this.ensureRemoteRuntimeDirs();
      await this.runShell(
        `rm -f ${quoteShellArg(fifoPath)} && mkfifo ${quoteShellArg(fifoPath)} && chmod 600 ${quoteShellArg(fifoPath)}`
      );

      const parser = createPaneTitleParser({
        onTitle: (title) => {
          this.pendingPaneTitles.set(paneId, title);
          this.requestSnapshot();
        },
      });

      const stopReader = await this.openReaderChannel(`exec cat ${quoteShellArg(fifoPath)}`, {
        onData: (raw) => {
          const output = parser.push(raw);
          if (Array.from(raw).includes(0x07)) {
            this.callbacks.onEvent({ type: 'bell', data: { paneId } });
          }
          if (output.length > 0) {
            this.callbacks.onTerminalOutput(paneId, output);
          }
        },
        onClose: () => {
          if (!this.manualDisconnect && this.currentPipePaneId === paneId) {
            this.callbacks.onError(new Error(`SSH pane reader closed unexpectedly: ${paneId}`));
          }
        },
      });

      this.pipeReadAbort = () => {
        stopReader();
        void this.runShellAllowFailure(`rm -f ${quoteShellArg(fifoPath)}`);
      };

      await this.runTmux(['pipe-pane', '-O', '-t', paneId, `cat >${fifoPath}`]);
      this.currentPipePaneId = paneId;
    });
  }

  private async stopPipe(): Promise<void> {
    await this.queuePipeTransition(() => this.stopPipeNow());
  }

  private async stopPipeNow(): Promise<void> {
    const paneId = this.currentPipePaneId;
    this.currentPipePaneId = null;

    if (paneId) {
      await this.runTmuxAllowFailure(['pipe-pane', '-t', paneId]);
    }

    this.pipeReadAbort?.();
    this.pipeReadAbort = null;
  }

  private queuePipeTransition(task: () => Promise<void>): Promise<void> {
    const next = this.pipeTransition.catch(() => undefined).then(task);
    this.pipeTransition = next;
    return next;
  }

  private async runTmux(
    argv: string[],
    allowTargetMissing = false,
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
    this.commandQueue = next.then(() => undefined);
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
      await this.stopPipe().catch(() => undefined);
      await this.stopHooks().catch(() => undefined);
      await this.runShellAllowFailure(`rm -rf ${quoteShellArg(this.fsPaths.rootDir)}`).catch(
        () => undefined
      );
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
