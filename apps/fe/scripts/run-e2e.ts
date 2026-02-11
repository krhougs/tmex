import * as net from 'node:net';
import { spawn } from 'node:child_process';

async function isPortAvailable(port: number): Promise<boolean> {
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

const defaultGatewayPort = 9663;
const defaultFePort = 9883;

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
