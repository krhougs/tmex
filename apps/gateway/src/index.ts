import { config } from './config';
import { createGatewayRuntime } from './runtime';

interface RunningRuntime {
  stop: () => Promise<void>;
}

async function main(): Promise<void> {
  while (true) {
    const gateway = await createGatewayRuntime();
    const server = Bun.serve({
      hostname: '0.0.0.0',
      port: config.port,
      async fetch(req, bunServer) {
        const response = gateway.handleRequest(req, bunServer);
        if (response !== undefined) {
          return response;
        }
        return new Response('Not Found', { status: 404 });
      },
      websocket: gateway.websocket,
    });

    console.log(`[gateway] listening on port ${config.port}`);

    await new Promise<void>((resolve) => {
      gateway.onRestartRequested(async () => {
        await gateway.stop();
        server.stop(true);
        resolve();
      });
    });
  }
}

await main();
