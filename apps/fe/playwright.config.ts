import { existsSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

function resolveBunExecutable(): string {
  const explicit = process.env.TMEX_E2E_BUN;
  if (explicit) return explicit;

  const home = process.env.HOME;
  if (home) {
    const candidate = join(home, '.bun', 'bin', 'bun');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'bun';
}

// 默认端口配置
const DEFAULT_GATEWAY_PORT = 9663;
const DEFAULT_FE_PORT = 9883;

const gatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
const fePort = Number(process.env.TMEX_E2E_FE_PORT) || DEFAULT_FE_PORT;
const bunExecutable = resolveBunExecutable();
const forceFreshServers = Boolean(
  process.env.TMEX_E2E_DATABASE_URL || process.env.TMEX_E2E_SSH_DEVICE_NAME
);
const reuseExistingServer = !process.env.CI && !forceFreshServers;

// 用 connect 探测而非 listen：listen 不带 host 绑 ::，对监听 IPv4 的进程（如生产 tmex）会误判空闲
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

// 防护：reuseExistingServer 生效时，若端口未显式指定且默认端口已被占用，
// reuse 会直接命中已存在的实例（本机 9883 常驻生产 tmex），beforeAll 改写
// 全局设置会污染生产数据。此时直接拒绝，要求显式指定 env 或走 bun run test:e2e。
if (reuseExistingServer) {
  const conflicts: string[] = [];
  if (!process.env.TMEX_E2E_GATEWAY_PORT && (await isPortListening(gatewayPort))) {
    conflicts.push(`gateway port ${gatewayPort} (TMEX_E2E_GATEWAY_PORT not set)`);
  }
  if (!process.env.TMEX_E2E_FE_PORT && (await isPortListening(fePort))) {
    conflicts.push(`fe port ${fePort} (TMEX_E2E_FE_PORT not set)`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `[e2e] Refusing to reuse unknown server(s) already listening on default port(s): ${conflicts.join(
        ', '
      )}. This may be a production tmex instance. Set TMEX_E2E_FE_PORT / TMEX_E2E_GATEWAY_PORT explicitly (e.g. TMEX_E2E_FE_PORT=9885 TMEX_E2E_GATEWAY_PORT=9665), or run via \`bun run test:e2e\` which picks free ports automatically.`
    );
  }
}

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${fePort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      name: 'gateway',
      cwd: '../../',
      command: './apps/gateway/scripts/run-with-ssh-agent.sh ./apps/gateway/src/index.ts',
      // 行为配置（master key 等）由 gateway 自身 loadEnv() 从 test.env 加载；
      // 继承的安装版 TMEX_MIGRATIONS_DIR 由 loadEnv 净化、migrate.ts 回退到仓库 drizzle。
      // 这里只注入「按运行上下文变化的接线键」。
      env: {
        NODE_ENV: 'test',
        GATEWAY_PORT: String(gatewayPort),
        DATABASE_URL: process.env.TMEX_E2E_DATABASE_URL ?? `/tmp/tmex-e2e-${Date.now()}.db`,
        TMEX_BASE_URL: `http://localhost:${gatewayPort}`,
      },
      url: `http://localhost:${gatewayPort}/healthz`,
      timeout: 60_000,
      reuseExistingServer,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      name: 'fe',
      cwd: '.',
      command: `${bunExecutable} run dev`,
      env: {
        ...process.env,
        // 注入 test：vite.config 的 loadTmexEnv 据此加载 test.env（省略 FE_PORT/
        // TMEX_GATEWAY_URL 等接线键，故下方动态注入值不会被覆盖）；同时覆盖掉
        // 继承自安装版 app.env 的 NODE_ENV=production（会污染 vite dev 依赖预打包）。
        NODE_ENV: 'test',
        FE_PORT: String(fePort),
        TMEX_GATEWAY_URL: `http://localhost:${gatewayPort}`,
      },
      url: `http://localhost:${fePort}`,
      timeout: 60_000,
      reuseExistingServer,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});

export { DEFAULT_GATEWAY_PORT, DEFAULT_FE_PORT };
