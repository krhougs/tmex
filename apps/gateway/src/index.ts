import './bootstrap-env';
import { config } from './config';
import { createGatewayRuntime } from './runtime';
import { getDisplayVersion } from './system/version';

interface RunningRuntime {
  stop: () => Promise<void>;
}

async function main(): Promise<void> {
  console.log(`[gateway] tmex ${getDisplayVersion()}`);
  while (true) {
    const gateway = await createGatewayRuntime();
    const server = Bun.serve({
      hostname: '0.0.0.0',
      port: config.port,
      // 默认 10s 空闲超时会中断大文件传输（拖到桌面的单次下载在 rsync 期间无响应数据）。
      // 拉满到 255s；流式上传/下载（commit / prepare）持续有 NDJSON 数据，本就不受影响。
      idleTimeout: 255,
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
