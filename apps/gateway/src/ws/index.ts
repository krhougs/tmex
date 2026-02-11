import type {
  DeviceConnectPayload,
  EventDevicePayload,
  EventTmuxPayload,
  StateSnapshotPayload,
  TermInputPayload,
  TermPastePayload,
  TermResizePayload,
  TmuxSelectPayload,
  TmuxSelectWindowPayload,
  WsMessage,
} from '@tmex/shared';
import type { Server, ServerWebSocket } from 'bun';
import { getSiteSettings } from '../db';
import { TmuxConnection } from '../tmux/connection';
import { resolveBellContext } from '../tmux/bell-context';
import { classifySshError } from './error-classify';
import type { TmuxEvent } from '../tmux/parser';
import { t } from '../i18n';

interface TermSyncSizePayload {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
}

interface ClientState {
  selectedPanes: Record<string, string | null>;
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
  private connections = new Map<string, DeviceConnectionEntry>();
  private pendingConnectionEntries = new Map<string, Promise<DeviceConnectionEntry | null>>();

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
      Boolean(client.data.selectedPanes[deviceId])
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
        selectedPanes: {},
      },
    });

    return success ? undefined : new Response('Upgrade failed', { status: 500 });
  }

  handleOpen(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client connected');
    ws.send(JSON.stringify({ type: 'connected', payload: {} }));
  }

  handleMessage(ws: ServerWebSocket<ClientState>, message: string | Buffer): void {
    try {
      const data = JSON.parse(message.toString()) as WsMessage<unknown>;
      this.handleWsMessage(ws, data);
    } catch (err) {
      console.error('[ws] failed to parse message:', err);
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid message format' } }));
    }
  }

  handleClose(ws: ServerWebSocket<ClientState>): void {
    console.log('[ws] client disconnected');

    const toDelete: string[] = [];

    for (const [deviceId, entry] of this.connections) {
      if (!entry.clients.has(ws)) continue;
      entry.clients.delete(ws);
      delete ws.data.selectedPanes[deviceId];

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

  private async handleWsMessage(
    ws: ServerWebSocket<ClientState>,
    msg: WsMessage<unknown>
  ): Promise<void> {
    const { type, payload } = msg;

    switch (type) {
      case 'device/connect': {
        const { deviceId } = payload as DeviceConnectPayload;
        await this.handleDeviceConnect(ws, deviceId);
        break;
      }

      case 'device/disconnect': {
        const { deviceId } = payload as DeviceConnectPayload;
        this.handleDeviceDisconnect(ws, deviceId);
        break;
      }

      case 'tmux/select': {
        const data = payload as TmuxSelectPayload;
        this.handleTmuxSelect(ws, data);
        break;
      }

      case 'tmux/select-window': {
        const data = payload as TmuxSelectWindowPayload;
        this.handleTmuxSelectWindow(data);
        break;
      }

      case 'term/input': {
        const data = payload as TermInputPayload;
        this.handleTermInput(data);
        break;
      }

      case 'term/resize': {
        const data = payload as TermResizePayload;
        this.handleTermResize(data);
        break;
      }

      case 'term/sync-size': {
        const data = payload as TermSyncSizePayload;
        this.handleTermSyncSize(data);
        break;
      }

      case 'term/paste': {
        const data = payload as TermPastePayload;
        this.handleTermPaste(data);
        break;
      }

      case 'tmux/create-window': {
        const data = payload as { deviceId: string; name?: string };
        this.handleCreateWindow(data);
        break;
      }

      case 'tmux/close-window': {
        const data = payload as { deviceId: string; windowId: string };
        this.handleCloseWindow(data);
        break;
      }

      case 'tmux/close-pane': {
        const data = payload as { deviceId: string; paneId: string };
        this.handleClosePane(data);
        break;
      }

      default:
        console.log('[ws] unknown message type:', type);
    }
  }

  private async handleDeviceConnect(
    ws: ServerWebSocket<ClientState>,
    deviceId: string
  ): Promise<void> {
    const entry = await this.getOrCreateConnectionEntry(deviceId, ws);
    if (!entry) {
      return;
    }

    entry.clients.add(ws);
    ws.data.selectedPanes[deviceId] ??= null;

    ws.send(
      JSON.stringify({
        type: 'device/connected',
        payload: { deviceId },
      })
    );

    if (entry.lastSnapshot) {
      ws.send(
        JSON.stringify({
          type: 'state/snapshot',
          payload: entry.lastSnapshot,
        })
      );
    } else {
      entry.connection.requestSnapshot();
    }
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
      const settings = getSiteSettings();
      ws.send(
        JSON.stringify({
          type: 'event/device',
          payload: {
            deviceId,
            type: 'error',
            errorType: errorInfo.type,
            message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
            rawMessage: err instanceof Error ? err.message : String(err),
          },
        })
      );
      return null;
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

    delete ws.data.selectedPanes[deviceId];

    ws.send(
      JSON.stringify({
        type: 'device/disconnected',
        payload: { deviceId },
      })
    );
  }

  private handleTmuxSelectWindow(data: TmuxSelectWindowPayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.selectWindow(data.windowId);
  }

  private handleTmuxSelect(ws: ServerWebSocket<ClientState>, data: TmuxSelectPayload): void {
    if (data.paneId !== undefined) {
      ws.data.selectedPanes[data.deviceId] = data.paneId;
      this.refreshSnapshotPolling(data.deviceId);
    }

    const entry = this.connections.get(data.deviceId);
    if (!entry) {
      return;
    }

    if (data.windowId && data.paneId) {
      entry.connection.selectPane(data.windowId, data.paneId);
    }
  }

  private handleTermInput(data: TermInputPayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    if (data.isComposing) {
      return;
    }

    entry.connection.sendInput(data.paneId, data.data);
  }

  private handleTermResize(data: TermResizePayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.resizePane(data.paneId, data.cols, data.rows);
  }

  private handleTermSyncSize(data: TermSyncSizePayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.resizePane(data.paneId, data.cols, data.rows);
  }

  private handleTermPaste(data: TermPastePayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    const chunkSize = 1024;
    const text = data.data;

    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      entry.connection.sendInput(data.paneId, chunk);
    }
  }

  private handleCreateWindow(data: { deviceId: string; name?: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.createWindow(data.name);
  }

  private handleCloseWindow(data: { deviceId: string; windowId: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.closeWindow(data.windowId);
  }

  private handleClosePane(data: { deviceId: string; paneId: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.closePane(data.paneId);
  }

  private async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    this.scheduleSnapshot(deviceId);

    const extendedEvent = await this.extendTmuxEvent(deviceId, event);

    const message = JSON.stringify({
      type: 'event/tmux',
      payload: {
        deviceId,
        type: extendedEvent.type,
        data: extendedEvent.data,
      },
    });

    for (const client of entry.clients) {
      client.send(message);
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

    const message = JSON.stringify({
      type: 'state/snapshot',
      payload,
    });

    for (const client of entry.clients) {
      client.send(message);
    }
  }

  private broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const deviceIdBytes = new TextEncoder().encode(deviceId);
    const paneIdBytes = new TextEncoder().encode(paneId);
    const headerSize = 1 + 2 + deviceIdBytes.length + 2 + paneIdBytes.length;
    const message = new Uint8Array(headerSize + data.length);
    message[0] = 0x01;
    message[1] = (deviceIdBytes.length >> 8) & 0xff;
    message[2] = deviceIdBytes.length & 0xff;
    message.set(deviceIdBytes, 3);

    const paneLenOffset = 3 + deviceIdBytes.length;
    message[paneLenOffset] = (paneIdBytes.length >> 8) & 0xff;
    message[paneLenOffset + 1] = paneIdBytes.length & 0xff;

    const paneOffset = paneLenOffset + 2;
    message.set(paneIdBytes, paneOffset);
    message.set(data, paneOffset + paneIdBytes.length);

    for (const client of entry.clients) {
      if (client.data.selectedPanes[deviceId] !== paneId) {
        continue;
      }
      client.send(message);
    }
  }

  private broadcastTerminalHistory(deviceId: string, paneId: string, data: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return;
    }

    const message = JSON.stringify({
      type: 'term/history',
      payload: {
        deviceId,
        paneId,
        data,
      },
    });

    for (const client of entry.clients) {
      if (client.data.selectedPanes[deviceId] !== paneId) {
        continue;
      }
      client.send(message);
    }
  }

  private broadcastError(deviceId: string, err: Error): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const errorInfo = classifySshError(err);
    const settings = getSiteSettings();

    const message = JSON.stringify({
      type: 'event/device',
      payload: {
        deviceId,
        type: 'error',
        errorType: errorInfo.type,
        message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
        rawMessage: err.message,
      },
    });

    for (const client of entry.clients) {
      client.send(message);
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

      const settings = getSiteSettings();
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
      delete client.data.selectedPanes[deviceId];
    }

    this.clearReconnectTimer(entry);
    this.connections.delete(deviceId);
  }

  private broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    const message = JSON.stringify({
      type: 'event/device',
      payload,
    });

    for (const client of entry.clients) {
      client.send(message);
    }
  }
}
