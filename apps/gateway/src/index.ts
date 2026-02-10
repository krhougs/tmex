import { handleApiRequest } from './api';
import { initAdmin } from './auth';
import { config } from './config';
import { initSchema } from './db';
import { WebSocketServer } from './ws';

// 初始化数据库
initSchema();
await initAdmin();

const wsServer = new WebSocketServer();

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: config.port,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket 升级
    if (url.pathname === '/ws') {
      const result = wsServer.handleUpgrade(req, server);
      if (result === false) {
        return new Response('Not Found', { status: 404 });
      }
      if (result instanceof Response) {
        return result;
      }
      return undefined as unknown as Response;
    }

    // API 请求
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      return handleApiRequest(req, server);
    }

    // 静态文件（生产环境应该由 nginx 处理）
    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      wsServer.handleOpen(ws);
    },
    message(ws, message) {
      wsServer.handleMessage(ws, message);
    },
    close(ws) {
      wsServer.handleClose(ws);
    },
  },
});

console.log(`[gateway] listening on port ${config.port}`);
