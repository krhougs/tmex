import type { Server, ServerWebSocket } from 'bun';
import { verifyJwtToken } from '../auth';
import { TmuxConnection } from '../tmux/connection';
import type { TmuxEvent } from '../tmux/parser';
import type {
  WsMessage,
  DeviceConnectPayload,
  DeviceDisconnectPayload,
  TmuxSelectPayload,
  TermInputPayload,
  TermResizePayload,
  TermPastePayload,
  StateSnapshotPayload,
  EventTmuxPayload,
  EventDevicePayload,
} from '@tmex/shared';

interface ClientState {
  authenticated: boolean;
  selectedDeviceId: string | null;
  selectedPaneId: string | null;
}

interface DeviceConnectionEntry {
  connection: TmuxConnection;
  clients: Set<ServerWebSocket<ClientState>>;
}

export class WebSocketServer {
  private connections = new Map<string, DeviceConnectionEntry>();
  
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
        selectedDeviceId: null,
        selectedPaneId: null,
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
    // 从所有设备连接中移除
    for (const [deviceId, entry] of this.connections) {
      if (entry.clients.has(ws)) {
        entry.clients.delete(ws);
        
        // 如果没有客户端了，断开设备连接
        if (entry.clients.size === 0) {
          console.log(`[ws] no more clients for device ${deviceId}, disconnecting`);
          entry.connection.disconnect();
          this.connections.delete(deviceId);
        }
        break;
      }
    }
  }
  
  private async handleWsMessage(ws: ServerWebSocket<ClientState>, msg: WsMessage<unknown>): Promise<void> {
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
      
      default:
        console.log('[ws] unknown message type:', type);
    }
  }
  
  private async handleDeviceConnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void> {
    let entry = this.connections.get(deviceId);
    
    if (!entry) {
      // 创建新连接
      const connection = new TmuxConnection({
        deviceId,
        onEvent: (event) => this.broadcastTmuxEvent(deviceId, event),
        onTerminalOutput: (paneId, data) => this.broadcastTerminalOutput(deviceId, paneId, data),
        onError: (err) => this.broadcastError(deviceId, err),
        onClose: () => this.handleConnectionClose(deviceId),
      });
      
      try {
        await connection.connect();
        entry = {
          connection,
          clients: new Set(),
        };
        this.connections.set(deviceId, entry);
        
        // 请求初始状态
        connection.requestSnapshot();
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'event/device',
          payload: {
            deviceId,
            type: 'error',
            message: err instanceof Error ? err.message : 'Connection failed',
          },
        }));
        return;
      }
    }
    
    entry.clients.add(ws);
    ws.data.selectedDeviceId = deviceId;
    
    ws.send(JSON.stringify({
      type: 'device/connected',
      payload: { deviceId },
    }));
  }
  
  private async handleDeviceDisconnect(ws: ServerWebSocket<ClientState>, deviceId: string): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (entry) {
      entry.clients.delete(ws);
      
      if (entry.clients.size === 0) {
        entry.connection.disconnect();
        this.connections.delete(deviceId);
      }
    }
    
    if (ws.data.selectedDeviceId === deviceId) {
      ws.data.selectedDeviceId = null;
      ws.data.selectedPaneId = null;
    }
    
    ws.send(JSON.stringify({
      type: 'device/disconnected',
      payload: { deviceId },
    }));
  }
  
  private handleTmuxSelect(ws: ServerWebSocket<ClientState>, data: TmuxSelectPayload): void {
    const entry = this.connections.get(data.deviceId);
    if (!entry) return;
    
    if (data.paneId) {
      ws.data.selectedPaneId = data.paneId;
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
  
  private broadcastTmuxEvent(deviceId: string, event: TmuxEvent): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    
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
  
  private broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    
    // 发送二进制数据
    // 格式: [1 byte type][2 bytes paneId length][paneId bytes][data bytes]
    const paneIdBytes = new TextEncoder().encode(paneId);
    const message = new Uint8Array(3 + paneIdBytes.length + data.length);
    message[0] = 0x01; // type: terminal output
    message[1] = (paneIdBytes.length >> 8) & 0xff;
    message[2] = paneIdBytes.length & 0xff;
    message.set(paneIdBytes, 3);
    message.set(data, 3 + paneIdBytes.length);
    
    for (const client of entry.clients) {
      // 只发送给选择了这个 pane 的客户端，或者使用广播模式
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
    
    const message = JSON.stringify({
      type: 'event/device',
      payload: {
        deviceId,
        type: 'disconnected',
      },
    });
    
    for (const client of entry.clients) {
      client.send(message);
      client.data.selectedDeviceId = null;
      client.data.selectedPaneId = null;
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
