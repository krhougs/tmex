import type { EventDevicePayload, StateSnapshotPayload, TmuxEventType } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { Server, ServerWebSocket } from 'bun';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import { resolveBellContext } from '../tmux/bell-context';
import { TmuxConnection } from '../tmux/connection';
import type { TmuxEvent } from '../tmux/parser';
import { classifySshError } from './error-classify';
import { createBorshClientState, type BorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';

interface ClientState {
  borshState: BorshClientState;
}

interface DeviceConnectionEntry {
  connection: TmuxConnection;
  clients: Set<ServerWebSocket<ClientState>>;
  lastSnapshot: StateSnapshotPayload | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  snapshotPollTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketServer {
  connections = new Map<string, DeviceConnectionEntry>();
  pendingConnectionEntries = new Map<string, Promise<DeviceConnectionEntry | null>>();

  private clearSnapshotTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotTimer) return;
    clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = null;
  }

  private clearSnapshotPollTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotPollTimer) return;
    clearInterval(entry.snapshotPollTimer);
    entry.snapshotPollTimer = null;
  }

  private clearReconnectTimer(entry: DeviceConnectionEntry): void {
    if (!entry.reconnectTimer) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  private refreshSnapshotPolling(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const hasSelectedPaneClient = Array.from(entry.clients).some((client) =>
      Boolean(client.data.borshState.selectedPanes[deviceId])
    );

    if (!hasSelectedPaneClient) {
      this.clearSnapshotPollTimer(entry);
      return;
    }

    if (entry.snapshotPollTimer) {
      return;
    }

    entry.snapshotPollTimer = setInterval(() => {
      if (this.connections.get(deviceId) !== entry) {
        return;
      }

      try {
        entry.connection.requestSnapshot();
      } catch (err) {
        console.error('[ws] polling snapshot failed:', err);
      }
    }, 1000);
  }

  private scheduleSnapshot(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    if (entry.snapshotTimer) return;

    entry.snapshotTimer = setTimeout(() => {
      if (this.connections.get(deviceId) !== entry) {
        return;
      }
      entry.snapshotTimer = null;
      try {
        entry.connection.requestSnapshot();
      } catch (err) {
        console.error('[ws] failed to request snapshot:', err);
      }
    }, 100);
  }

  handleUpgrade(req: Request, server: Server<any>): Response | false | undefined {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return false;
    }

    const success = (server as any).upgrade(req, {
      data: {
        borshState: createBorshClientState(),
      } satisfies ClientState,
    });

    return success ? undefined : new Response('Upgrade failed', { status: 500 });
  }

  handleOpen(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client connected');
    sessionStateStore.create(ws);
  }

  handleMessage(ws: ServerWebSocket<ClientState>, message: string | Buffer): void {
    if (typeof message === 'string') {
      return;
    }

    const data = new Uint8Array(message);

    if (!wsBorsh.checkMagic(data)) {
      this.sendError(ws, null, wsBorsh.ERROR_INVALID_FRAME, 'Missing magic bytes', false);
      return;
    }

    let envelope: wsBorsh.Envelope;
    try {
      envelope = wsBorsh.decodeEnvelope(data);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        null,
        e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
        e?.message ?? 'Invalid envelope',
        e?.retryable ?? false
      );
      return;
    }

    const clientState = ws.data.borshState;

    // CHUNK 重组
    if (envelope.kind === wsBorsh.KIND_CHUNK) {
      try {
        const chunk = wsBorsh.decodeChunk(envelope.payload);
        const reassembled = clientState.chunkReassembler.addChunk(chunk);
        if (!reassembled) {
          return;
        }
        void this.handleBorshMessage(ws, reassembled.kind, reassembled.seq, reassembled.payload);
        return;
      } catch (err) {
        const e = err instanceof wsBorsh.WsBorshError ? err : null;
        this.sendError(
          ws,
          null,
          e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
          e?.message ?? 'Invalid chunk',
          e?.retryable ?? false
        );
        return;
      }
    }

    void this.handleBorshMessage(ws, envelope.kind, envelope.seq, envelope.payload);
  }

  handleClose(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client disconnected');

    switchBarrier.cleanupClient(ws);
    sessionStateStore.cleanup(ws);

    const toDelete: string[] = [];

    for (const [deviceId, entry] of this.connections) {
      if (!entry.clients.has(ws)) continue;
      entry.clients.delete(ws);
      delete ws.data.borshState.selectedPanes[deviceId];

      if (entry.clients.size === 0) {
        console.log(`[ws] no more clients for device ${deviceId}, disconnecting`);
        this.clearSnapshotTimer(entry);
        this.clearSnapshotPollTimer(entry);
        this.clearReconnectTimer(entry);
        entry.connection.disconnect();
        toDelete.push(deviceId);
      } else {
        this.refreshSnapshotPolling(deviceId);
      }
    }

    for (const deviceId of toDelete) {
      this.connections.delete(deviceId);
    }
  }

  closeAll(): void {
    for (const [deviceId, entry] of this.connections) {
      this.clearSnapshotTimer(entry);
      this.clearSnapshotPollTimer(entry);
      this.clearReconnectTimer(entry);
      entry.connection.disconnect();
      this.connections.delete(deviceId);
    }
    this.pendingConnectionEntries.clear();
  }

  private async handleBorshMessage(
    ws: ServerWebSocket<ClientState>,
    kind: number,
    refSeq: number,
    payload: Uint8Array
  ): Promise<void> {
    const state = ws.data.borshState;

    if (kind !== wsBorsh.KIND_HELLO_C2S && !state.negotiated) {
      this.sendError(ws, refSeq, wsBorsh.ERROR_INVALID_FRAME, 'HELLO required', false);
      return;
    }

    if (kind === wsBorsh.KIND_HELLO_C2S) {
      this.handleHello(ws, refSeq, payload);
      return;
    }

    if (kind === wsBorsh.KIND_PING) {
      this.handlePing(ws, refSeq, payload);
      return;
    }

    switch (kind) {
      case wsBorsh.KIND_DEVICE_CONNECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectSchema, payload);
        await this.handleDeviceConnect(ws, decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_DEVICE_DISCONNECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectSchema, payload);
        this.handleDeviceDisconnect(ws, decoded.deviceId);
        return;
      }

      case wsBorsh.KIND_TMUX_SELECT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, payload);
        this.handleTmuxSelect(ws, decoded);
        return;
      }

      case wsBorsh.KIND_TMUX_SELECT_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectWindowSchema, payload);
        this.handleTmuxSelectWindow(decoded.deviceId, decoded.windowId);
        return;
      }

      case wsBorsh.KIND_TMUX_CREATE_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxCreateWindowSchema, payload);
        this.handleCreateWindow(decoded.deviceId, decoded.name ?? undefined);
        return;
      }

      case wsBorsh.KIND_TMUX_CLOSE_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxCloseWindowSchema, payload);
        this.handleCloseWindow(decoded.deviceId, decoded.windowId);
        return;
      }

      case wsBorsh.KIND_TMUX_CLOSE_PANE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxClosePaneSchema, payload);
        this.handleClosePane(decoded.deviceId, decoded.paneId);
        return;
      }

      case wsBorsh.KIND_TMUX_RENAME_WINDOW: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxRenameWindowSchema, payload);
        this.handleRenameWindow(decoded.deviceId, decoded.windowId, decoded.name);
        return;
      }

      case wsBorsh.KIND_TERM_INPUT: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermInputSchema, payload);
        if (decoded.isComposing) return;
        const text = new TextDecoder().decode(decoded.data);
        this.handleTermInput(decoded.deviceId, decoded.paneId, text);
        return;
      }

      case wsBorsh.KIND_TERM_PASTE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermPasteSchema, payload);
        const text = new TextDecoder().decode(decoded.data);
        this.handleTermPaste(decoded.deviceId, decoded.paneId, text);
        return;
      }

      case wsBorsh.KIND_TERM_RESIZE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermResizeSchema, payload);
        this.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
        return;
      }

      case wsBorsh.KIND_TERM_SYNC_SIZE: {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermSyncSizeSchema, payload);
        this.handleTermResize(decoded.deviceId, decoded.paneId, decoded.cols, decoded.rows);
        return;
      }

      default:
        this.sendError(ws, refSeq, wsBorsh.ERROR_UNKNOWN_KIND, `Unknown kind: ${kind}`, false);
    }
  }

  private handleHello(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    let hello: wsBorsh.b.infer<typeof wsBorsh.schema.HelloC2SSchema>;
    try {
      hello = wsBorsh.decodePayload(wsBorsh.schema.HelloC2SSchema, payload);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'HELLO payload decode failed',
        e?.retryable ?? false
      );
      return;
    }

    const serverMaxFrameBytes = wsBorsh.DEFAULT_MAX_FRAME_BYTES;
    const effectiveMaxFrameBytes = Math.min(hello.maxFrameBytes, serverMaxFrameBytes);

    ws.data.borshState.negotiated = true;
    ws.data.borshState.maxFrameBytes = effectiveMaxFrameBytes;

    const helloS2C: wsBorsh.b.infer<typeof wsBorsh.schema.HelloS2CSchema> = {
      serverImpl: 'tmex-gateway',
      serverVersion: '0.1.0',
      selectedVersion: wsBorsh.CURRENT_VERSION,
      maxFrameBytes: serverMaxFrameBytes,
      heartbeatIntervalMs: 15000,
      capabilities: ['tmex-ws-borsh-v1'],
    };

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, helloS2C);
    this.sendEnvelope(ws, wsBorsh.KIND_HELLO_S2C, payloadBytes);
  }

  private handlePing(ws: ServerWebSocket<ClientState>, refSeq: number, payload: Uint8Array): void {
    try {
      const ping = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, payload);
      const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
        nonce: ping.nonce,
        timeMs: ping.timeMs,
      });
      this.sendEnvelope(ws, wsBorsh.KIND_PONG, pongPayload);
    } catch (err) {
      const e = err instanceof wsBorsh.WsBorshError ? err : null;
      this.sendError(
        ws,
        refSeq,
        e?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        e?.message ?? 'PING payload decode failed',
        e?.retryable ?? false
      );
    }
  }

  private sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void {
    const seq = ws.data.borshState.seqGen();
    const data = wsBorsh.encodeEnvelope(kind, payload, seq);
    ws.send(data);
  }

  private sendChunked(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void {
    const state = ws.data.borshState;

    const originalSeq = state.seqGen();
    const chunked = wsBorsh.splitPayloadIntoChunks(payload, kind, originalSeq, {
      maxFrameBytes: state.maxFrameBytes,
      chunkStreamId: wsBorsh.generateChunkStreamId(),
    });

    if (chunked.totalChunks === 0) {
      ws.send(wsBorsh.encodeEnvelope(kind, payload, originalSeq));
      return;
    }

    for (const chunk of chunked.chunks) {
      ws.send(wsBorsh.encodeChunk(chunk, state.seqGen()));
    }
  }

  private sendError(
    ws: ServerWebSocket<ClientState>,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
      refSeq,
      code,
      message,
      retryable,
    });
    this.sendEnvelope(ws, wsBorsh.KIND_ERROR, payload);
  }

  private async getOrCreateConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    const existing = this.connections.get(deviceId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingConnectionEntries.get(deviceId);
    if (pending) {
      return pending;
    }

    let creationPromise: Promise<DeviceConnectionEntry | null>;
    creationPromise = this.createDeviceConnectionEntry(deviceId, ws)
      .then((createdEntry) => {
        if (createdEntry) {
          this.connections.set(deviceId, createdEntry);
        }
        return createdEntry;
      })
      .finally(() => {
        if (this.pendingConnectionEntries.get(deviceId) === creationPromise) {
          this.pendingConnectionEntries.delete(deviceId);
        }
      });

    this.pendingConnectionEntries.set(deviceId, creationPromise);
    return creationPromise;
  }

  private async handleDeviceConnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void> {
    const entry = await this.getOrCreateConnectionEntry(deviceId, ws);
    if (!entry) return;

    entry.clients.add(ws);
    ws.data.borshState.selectedPanes[deviceId] ??= null;

    const connectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, { deviceId });
    this.sendEnvelope(ws, wsBorsh.KIND_DEVICE_CONNECTED, connectedPayload);

    if (entry.lastSnapshot) {
      const snapshotBytes = wsBorsh.encodeStateSnapshot(entry.lastSnapshot);
      this.sendChunked(ws, wsBorsh.KIND_STATE_SNAPSHOT, snapshotBytes);
    } else {
      entry.connection.requestSnapshot();
    }
  }

  private handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (entry) {
      entry.clients.delete(ws);
      this.refreshSnapshotPolling(deviceId);

      if (entry.clients.size === 0) {
        this.clearSnapshotTimer(entry);
        this.clearSnapshotPollTimer(entry);
        this.clearReconnectTimer(entry);
        entry.connection.disconnect();
        this.connections.delete(deviceId);
      }
    }

    delete ws.data.borshState.selectedPanes[deviceId];

    const disconnectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectedSchema, { deviceId });
    this.sendEnvelope(ws, wsBorsh.KIND_DEVICE_DISCONNECTED, disconnectedPayload);
  }

  private handleTmuxSelect(
    ws: ServerWebSocket<ClientState>,
    data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
  ): void {
    const deviceId = data.deviceId;
    const paneId = data.paneId ?? undefined;

    if (paneId) {
      ws.data.borshState.selectedPanes[deviceId] = paneId;
      this.refreshSnapshotPolling(deviceId);
    }

    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const windowId = data.windowId ?? undefined;
    if (!windowId || !paneId) return;

    const started = switchBarrier.startTransaction(ws as any, {
      deviceId,
      windowId,
      paneId,
      selectToken: data.selectToken,
      wantHistory: data.wantHistory,
      cols: data.cols ?? null,
      rows: data.rows ?? null,
    });

    if (!started) {
      this.sendError(ws, null, wsBorsh.ERROR_SELECT_CONFLICT, 'Failed to start select transaction', false);
      return;
    }

    switchBarrier.sendSwitchAck(ws as any, deviceId);

    entry.connection.selectPane(windowId, paneId);

    const cols = data.cols ?? null;
    const rows = data.rows ?? null;
    if (cols !== null && rows !== null) {
      entry.connection.resizePane(paneId, cols, rows);
    }
  }

  private handleTmuxSelectWindow(deviceId: string, windowId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.selectWindow(windowId);
  }

  private handleTermInput(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.sendInput(paneId, data);
  }

  private handleTermResize(deviceId: string, paneId: string, cols: number, rows: number): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.resizePane(paneId, cols, rows);
  }

  private handleTermPaste(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const chunkSize = 1024;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      entry.connection.sendInput(paneId, chunk);
    }
  }

  private handleCreateWindow(deviceId: string, name?: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.createWindow(name);
  }

  private handleCloseWindow(deviceId: string, windowId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.closeWindow(windowId);
  }

  private handleClosePane(deviceId: string, paneId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.closePane(paneId);
  }

  private handleRenameWindow(deviceId: string, windowId: string, name: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.connection.renameWindow(windowId, name);
  }

  private async createDeviceConnectionEntry(
    deviceId: string,
    ws: ServerWebSocket<ClientState>
  ): Promise<DeviceConnectionEntry | null> {
    const connection = new TmuxConnection({
      deviceId,
      onEvent: (event) => {
        void this.broadcastTmuxEvent(deviceId, event);
      },
      onTerminalOutput: (paneId, data) => this.broadcastTerminalOutput(deviceId, paneId, data),
      onTerminalHistory: (paneId, data) => this.broadcastTerminalHistory(deviceId, paneId, data),
      onSnapshot: (payload) => this.broadcastStateSnapshot(deviceId, payload),
      onError: (err) => this.broadcastError(deviceId, err),
      onClose: () => {
        void this.handleConnectionClose(deviceId);
      },
    });

    try {
      await connection.connect();
      return {
        connection,
        clients: new Set(),
        lastSnapshot: null,
        snapshotTimer: null,
        snapshotPollTimer: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
      };
    } catch (err) {
      const errorInfo = classifySshError(err instanceof Error ? err : new Error(String(err)));
      ws.send(
        wsBorsh.encodeEnvelope(
          wsBorsh.KIND_DEVICE_EVENT,
          wsBorsh.encodeDeviceEventPayload({
            deviceId,
            type: 'error',
            errorType: errorInfo.type,
            message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
            rawMessage: err instanceof Error ? err.message : String(err),
          }),
          ws.data.borshState.seqGen()
        )
      );
      return null;
    }
  }

  private async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    this.scheduleSnapshot(deviceId);

    const extendedEvent = await this.extendTmuxEvent(deviceId, event);

    const payloadBytes = wsBorsh.encodeTmuxEventPayload({
      deviceId,
      type: extendedEvent.type,
      data: extendedEvent.data,
    });

    if (extendedEvent.type === 'bell') {
      const settings = getSiteSettings();
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const paneId = typeof data.paneId === 'string' && data.paneId ? data.paneId : '-';

      for (const client of entry.clients) {
        if (!sessionStateStore.shouldAllowBell(client, deviceId, paneId, settings.bellThrottleSeconds)) {
          continue;
        }
        this.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
      }
      return;
    }

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
    }
  }

  private async extendTmuxEvent(deviceId: string, event: TmuxEvent): Promise<TmuxEvent> {
    if (event.type !== 'bell') {
      return event;
    }

    const settings = getSiteSettings();
    const snapshot = this.connections.get(deviceId)?.lastSnapshot ?? null;
    const data = resolveBellContext({
      deviceId,
      siteUrl: settings.siteUrl,
      snapshot,
      rawData: event.data,
    });

    return {
      type: 'bell',
      data,
    };
  }

  private broadcastStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    entry.lastSnapshot = payload;
    const payloadBytes = wsBorsh.encodeStateSnapshot(payload);

    for (const client of entry.clients) {
      this.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT, payloadBytes);
    }
  }

  private broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    for (const client of entry.clients) {
      if (client.data.borshState.selectedPanes[deviceId] !== paneId) {
        continue;
      }

      if (switchBarrier.shouldBufferOutput(client, deviceId)) {
        switchBarrier.bufferOutput(client, deviceId, data);
        continue;
      }

      const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, {
        deviceId,
        paneId,
        encoding: 1,
        data,
      });
      this.sendChunked(client, wsBorsh.KIND_TERM_OUTPUT, payloadBytes);
    }
  }

  private broadcastTerminalHistory(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const historyBytes = new TextEncoder().encode(data);

    for (const client of entry.clients) {
      if (client.data.borshState.selectedPanes[deviceId] !== paneId) {
        continue;
      }
      switchBarrier.sendTermHistory(client as any, deviceId, paneId, historyBytes);
    }
  }

  private broadcastError(deviceId: string, err: Error): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const errorInfo = classifySshError(err);

    const payloadBytes = wsBorsh.encodeDeviceEventPayload({
      deviceId,
      type: 'error',
      errorType: errorInfo.type,
      message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
      rawMessage: err.message,
    });

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  private broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    const payloadBytes = wsBorsh.encodeDeviceEventPayload(payload);

    for (const client of entry.clients) {
      this.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  private async handleConnectionClose(deviceId: string): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return;
    }

    this.clearSnapshotTimer(entry);
    this.clearSnapshotPollTimer(entry);

    const { sshReconnectMaxRetries, sshReconnectDelaySeconds } = getSiteSettings();

    if (entry.clients.size > 0 && entry.reconnectAttempts < sshReconnectMaxRetries) {
      entry.reconnectAttempts += 1;
      const delay = Math.max(1, sshReconnectDelaySeconds) * 1000;

      const notifying: EventDevicePayload = {
        deviceId,
        type: 'error',
        errorType: 'reconnecting',
        message: t('sshError.reconnecting', {
          delay: delay / 1000,
          attempt: entry.reconnectAttempts,
          maxRetries: sshReconnectMaxRetries,
        }),
      };
      this.broadcastDeviceEvent(entry, notifying);

      this.clearReconnectTimer(entry);
      entry.reconnectTimer = setTimeout(async () => {
        entry.reconnectTimer = null;

        const current = this.connections.get(deviceId);
        if (!current || current !== entry || entry.clients.size === 0) {
          return;
        }

        const retryConnection = await this.createDeviceConnectionEntry(deviceId, Array.from(entry.clients)[0]);
        if (!retryConnection) {
          if (entry.reconnectAttempts < sshReconnectMaxRetries) {
            await this.handleConnectionClose(deviceId);
            return;
          }

          const finalEvent: EventDevicePayload = {
            deviceId,
            type: 'error',
            errorType: 'reconnect_failed',
            message: t('sshError.reconnectFailed'),
          };
          this.broadcastDeviceEvent(entry, finalEvent);
          return;
        }

        retryConnection.clients = entry.clients;
        retryConnection.reconnectAttempts = entry.reconnectAttempts;
        this.connections.set(deviceId, retryConnection);

        const reconnected: EventDevicePayload = {
          deviceId,
          type: 'reconnected',
          message: t('sshError.reconnected'),
        };
        this.broadcastDeviceEvent(retryConnection, reconnected);

        retryConnection.connection.requestSnapshot();
      }, delay);

      return;
    }

    const disconnected: EventDevicePayload = {
      deviceId,
      type: 'disconnected',
    };
    this.broadcastDeviceEvent(entry, disconnected);

    for (const client of entry.clients) {
      delete client.data.borshState.selectedPanes[deviceId];
    }

    this.clearReconnectTimer(entry);
    this.connections.delete(deviceId);
  }
}
