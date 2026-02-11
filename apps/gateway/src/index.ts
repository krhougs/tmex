import { handleApiRequest } from './api';
import { runtimeController } from './control/runtime';
import { config } from './config';
import { ensureSiteSettingsInitialized, getSiteSettings } from './db';
import { runMigrations } from './db/migrate';
import { pushSupervisor } from './push/supervisor';
import { telegramService } from './telegram/service';
import { WebSocketServer } from './ws';

interface RunningRuntime {
  stop: () => Promise<void>;
}

async function createRuntime(): Promise<RunningRuntime> {
  const wsServer = new WebSocketServer();
  await telegramService.refresh();
  await pushSupervisor.start();

  try {
    const settings = getSiteSettings();
    await telegramService.sendGatewayOnlineMessage(settings.siteName);
  } catch (err) {
    console.error('[gateway] failed to push startup message:', err);
  }

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: config.port,
    async fetch(req, bunServer) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const result = wsServer.handleUpgrade(req, bunServer);
        if (result === false) {
          return new Response('Not Found', { status: 404 });
        }
        if (result instanceof Response) {
          return result;
        }
        return undefined as unknown as Response;
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        return handleApiRequest(req, bunServer);
      }

      return new Response('Not Found', { status: 404 });
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
  });

  console.log(`[gateway] listening on port ${config.port}`);

  return {
    async stop() {
      wsServer.closeAll();
      await pushSupervisor.stopAll();
      await telegramService.stopAll();
      server.stop(true);
    },
  };
}

async function main(): Promise<void> {
  runMigrations();
  ensureSiteSettingsInitialized();

  while (true) {
    runtimeController.reset();
    const runtime = await createRuntime();

    await new Promise<void>((resolve) => {
      runtimeController.onRestart(async () => {
        await runtime.stop();
        resolve();
      });
    });
  }
}

await main();
