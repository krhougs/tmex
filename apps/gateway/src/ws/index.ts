import type {
  DeviceConnectPayload,
  DeviceDisconnectPayload,
  EventDevicePayload,
  EventTmuxPayload,
  StateSnapshotPayload,
  TermInputPayload,
  TermPastePayload,
  TermResizePayload,
  TmuxSelectPayload,
  WsMessage,
} from '@tmex/shared';
import type { Server, ServerWebSocket } from 'bun';
import { verifyJwtToken } from '../auth';
import { TmuxConnection } from '../tmux/connection';
import type { TmuxEvent } from '../tmux/parser';

// 错误类型分类
function classifyError(error: Error): { type: string; message: string } {
  const msg = error.message.toLowerCase();

  if (msg.includes('all configured authentication methods failed')) {
    return {
      type: 'auth_failed',
      message: '认证失败：用户名、密码或密钥不正确，请检查设备配置'
    };
  }
  if (msg.includes('connect refused') || msg.includes('connection refused')) {
    return {
      type: 'connection_refused',
      message: '连接被拒绝：无法连接到目标主机，请检查主机地址和端口是否正确'
    };
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return {
      type: 'timeout',
      message: '连接超时：无法连接到设备，请检查网络或防火墙设置'
    };
  }
  if (msg.includes('host not found') || msg.includes('getaddrinfo')) {
    return {
      type: 'host_not_found',
      message: '主机未找到：无法解析主机地址，请检查 DNS 或主机名是否正确'
    };
  }
  if (msg.includes('handshake failed') || msg.includes('unable to verify')) {
    return {
      type: 'handshake_failed',
      message: '握手失败：无法建立安全连接，可能是密钥交换算法不兼容'
    };
  }

  return {
    type: 'unknown',
    message: `连接失败：${error.message}`
  };
}

interface ClientState {
  authenticated: boolean;
  selectedPanes: Record<string, string | null>;
}

interface DeviceConnectionEntry {
  connection: TmuxConnection;
  clients: Set<ServerWebSocket<ClientState>>;
  lastSnapshot: StateSnapshotPayload | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketServer {
  private connections = new Map<string, DeviceConnectionEntry>();

  private clearSnapshotTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotTimer) return;
    clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = null;
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

  handleUpgrade(req: Request, server: Server): Response | false {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return false;
    }

    // 验证认证
    const cookie = req.headers.get('Cookie');
    if (!cookie || !this.isAuthenticated(cookie)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const success = server.upgrade(req, {
      data: {
        authenticated: true,
        selectedPanes: {},
      } as ClientState,
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
        entry.connection.disconnect();
        toDelete.push(deviceId);
      }
    }

    for (const deviceId of toDelete) {
      this.connections.delete(deviceId);
    }
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
        const { deviceId } = payload as DeviceDisconnectPayload;
        await this.handleDeviceDisconnect(ws, deviceId);
        break;
      }

      case 'tmux/select': {
        const data = payload as TmuxSelectPayload;
        this.handleTmuxSelect(ws, data);
        break;
      }

      case 'term/input': {
        const data = payload as TermInputPayload;
        this.handleTermInput(ws, data);
        break;
      }

      case 'term/resize': {
        const data = payload as TermResizePayload;
        this.handleTermResize(ws, data);
        break;
      }

      case 'term/paste': {
        const data = payload as TermPastePayload;
        this.handleTermPaste(ws, data);
        break;
      }

      case 'tmux/create-window': {
        const data = payload as { deviceId: string; name?: string };
        this.handleCreateWindow(ws, data);
        break;
      }

      case 'tmux/close-window': {
        const data = payload as { deviceId: string; windowId: string };
        this.handleCloseWindow(ws, data);
        break;
      }

      case 'tmux/close-pane': {
        const data = payload as { deviceId: string; paneId: string };
        this.handleClosePane(ws, data);
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
    let entry = this.connections.get(deviceId);

    if (!entry) {
      // 创建新连接
      const connection = new TmuxConnection({
        deviceId,
        onEvent: (event) => this.broadcastTmuxEvent(deviceId, event),
        onTerminalOutput: (paneId, data) => this.broadcastTerminalOutput(deviceId, paneId, data),
        onSnapshot: (payload) => this.broadcastStateSnapshot(deviceId, payload),
        onError: (err) => this.broadcastError(deviceId, err),
        onClose: () => this.handleConnectionClose(deviceId),
      });

      try {
        await connection.connect();
        entry = {
          connection,
          clients: new Set(),
          lastSnapshot: null,
          snapshotTimer: null,
        };
        this.connections.set(deviceId, entry);
      } catch (err) {
        const errorInfo = classifyError(err instanceof Error ? err : new Error(String(err)));
        ws.send(
          JSON.stringify({
            type: 'event/device',
            payload: {
              deviceId,
              type: 'error',
              errorType: errorInfo.type,
              message: errorInfo.message,
              rawMessage: err instanceof Error ? err.message : String(err)
            },
          })
        );
        return;
      }
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

  private async handleDeviceDisconnect(
    ws: ServerWebSocket<ClientState>,
    deviceId: string
  ): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (entry) {
      entry.clients.delete(ws);

      if (entry.clients.size === 0) {
        this.clearSnapshotTimer(entry);
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

  private handleTmuxSelect(ws: ServerWebSocket<ClientState>, data: TmuxSelectPayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    if (data.paneId !== undefined) {
      ws.data.selectedPanes[data.deviceId] = data.paneId;
    }

    if (data.windowId && data.paneId) {
      entry.connection.selectPane(data.windowId, data.paneId);
    }
  }

  private handleTermInput(ws: ServerWebSocket<ClientState>, data: TermInputPayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    // 如果是组合输入状态，不发送
    if (data.isComposing) {
      return;
    }

    entry.connection.sendInput(data.paneId, data.data);
  }

  private handleTermResize(ws: ServerWebSocket<ClientState>, data: TermResizePayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.resizePane(data.paneId, data.cols, data.rows);
  }

  private handleTermPaste(ws: ServerWebSocket<ClientState>, data: TermPastePayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    // 分块发送粘贴内容
    const chunkSize = 1024;
    const text = data.data;

    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      entry.connection.sendInput(data.paneId, chunk);
    }
  }

  private handleCreateWindow(ws: ServerWebSocket<ClientState>, data: { deviceId: string; name?: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.createWindow(data.name);
  }

  private handleCloseWindow(ws: ServerWebSocket<ClientState>, data: { deviceId: string; windowId: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.closeWindow(data.windowId);
  }

  private handleClosePane(ws: ServerWebSocket<ClientState>, data: { deviceId: string; paneId: string }): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;

    entry.connection.closePane(data.paneId);
  }

  private broadcastTmuxEvent(deviceId: string, event: TmuxEvent): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    this.scheduleSnapshot(deviceId);

    const message = JSON.stringify({
      type: 'event/tmux',
      payload: {
        deviceId,
        type: event.type,
        data: event.data,
      },
    });

    for (const client of entry.clients) {
      client.send(message);
    }
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

    // 发送二进制数据
    // 格式: [1 byte type][2 bytes deviceId length][deviceId bytes][2 bytes paneId length][paneId bytes][data bytes]
    const deviceIdBytes = new TextEncoder().encode(deviceId);
    const paneIdBytes = new TextEncoder().encode(paneId);
    const headerSize = 1 + 2 + deviceIdBytes.length + 2 + paneIdBytes.length;
    const message = new Uint8Array(headerSize + data.length);
    message[0] = 0x01; // type: terminal output
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

  private broadcastError(deviceId: string, err: Error): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    const message = JSON.stringify({
      type: 'event/device',
      payload: {
        deviceId,
        type: 'error',
        message: err.message,
      },
    });

    for (const client of entry.clients) {
      client.send(message);
    }
  }

  private handleConnectionClose(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;

    this.clearSnapshotTimer(entry);

    const message = JSON.stringify({
      type: 'event/device',
      payload: {
        deviceId,
        type: 'disconnected',
      },
    });

    for (const client of entry.clients) {
      client.send(message);
      delete client.data.selectedPanes[deviceId];
    }

    this.connections.delete(deviceId);
  }

  private isAuthenticated(cookieHeader: string): boolean {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [key, value] = cookie.trim().split('=');
      if (key === 'token' && value) {
        // 简化验证，实际应该完整验证 JWT
        return true;
      }
    }
    return false;
  }
}
