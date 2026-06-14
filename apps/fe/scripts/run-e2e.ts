import { spawn } from 'node:child_process';
import * as net from 'node:net';

// listen 不带 host 默认绑 ::，对只监听 IPv4 的进程（如生产 tmex 的 9883）会误判可用，
// 必须先用 connect 探测
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port);
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  if (await isPortListening(port)) {
    return false;
  }
  return canBindPort(port);
}

async function findAvailablePort(startPort: number, maxAttempts = 20): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`Could not find available port starting from ${startPort}`);
}

function resolvePlaywrightCli(): string {
  // Prefer local bin to avoid PATH surprises.
  return 'node_modules/.bin/playwright';
}

// 默认端口避开生产常驻 tmex 的 9883/9663（见 playwright.config.ts 同步常量）。
const defaultGatewayPort = 9665;
const defaultFePort = 9885;

const requestedGatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || defaultGatewayPort;
const requestedFePort = Number(process.env.TMEX_E2E_FE_PORT) || defaultFePort;

const gatewayPort = (await isPortAvailable(requestedGatewayPort))
  ? requestedGatewayPort
  : await findAvailablePort(requestedGatewayPort);

const fePort = (await isPortAvailable(requestedFePort))
  ? requestedFePort
  : await findAvailablePort(requestedFePort);

if (gatewayPort !== requestedGatewayPort) {
  console.log(`[e2e] Gateway port ${requestedGatewayPort} is in use, using ${gatewayPort} instead`);
}
if (fePort !== requestedFePort) {
  console.log(`[e2e] Frontend port ${requestedFePort} is in use, using ${fePort} instead`);
}

process.env.TMEX_E2E_GATEWAY_PORT = String(gatewayPort);
process.env.TMEX_E2E_FE_PORT = String(fePort);

const cli = resolvePlaywrightCli();

const child = spawn(cli, ['test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
