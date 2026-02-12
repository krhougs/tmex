import { handleApiRequest } from './api';
import { config } from './config';
import { runtimeController } from './control/runtime';
import { ensureSiteSettingsInitialized, getSiteSettings } from './db';
import { runMigrations } from './db/migrate';
import { pushSupervisor } from './push/supervisor';
import { telegramService } from './telegram/service';
import { WebSocketServer } from './ws';

interface GatewayRuntimeOptions {
  runMigrationsOnStart?: boolean;
  initializeSiteSettings?: boolean;
}

export interface GatewayRuntime {
  readonly port: number;
  handleRequest: (req: Request, bunServer: Bun.Server) => Response | Promise<Response> | undefined;
  websocket: {
    open: (ws: Bun.ServerWebSocket<unknown>) => void;
    message: (ws: Bun.ServerWebSocket<unknown>, message: string | Buffer) => void;
    close: (ws: Bun.ServerWebSocket<unknown>) => void;
  };
  onRestartRequested: (listener: () => Promise<void> | void) => void;
  stop: () => Promise<void>;
}

export async function createGatewayRuntime(
  options: GatewayRuntimeOptions = {}
): Promise<GatewayRuntime> {
  const { runMigrationsOnStart = true, initializeSiteSettings = true } = options;

  if (runMigrationsOnStart) {
    runMigrations();
  }

  if (initializeSiteSettings) {
    ensureSiteSettingsInitialized();
  }

  runtimeController.reset();

  const wsServer = new WebSocketServer();
  await telegramService.refresh();
  await pushSupervisor.start();

  try {
    const settings = getSiteSettings();
    await telegramService.sendGatewayOnlineMessage(settings.siteName);
  } catch (err) {
    console.error('[gateway] failed to push startup message:', err);
  }

  return {
    port: config.port,
    handleRequest(req, bunServer) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const result = wsServer.handleUpgrade(req, bunServer);
        if (result === false) {
          return new Response('Not Found', { status: 404 });
        }
        if (result instanceof Response) {
          return result;
        }
        return undefined;
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        return handleApiRequest(req, bunServer);
      }

      return undefined;
    },
    websocket: {
      open(ws) {
        wsServer.handleOpen(ws as any);
      },
      message(ws, message) {
        wsServer.handleMessage(ws as any, message);
      },
      close(ws) {
        wsServer.handleClose(ws as any);
      },
    },
    onRestartRequested(listener) {
      runtimeController.onRestart(listener);
    },
    async stop() {
      wsServer.closeAll();
      await pushSupervisor.stopAll();
      await telegramService.stopAll();
    },
  };
}
