import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const configDir = dirname(fileURLToPath(import.meta.url));

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
      env: {
        NODE_ENV: 'development',
        TMEX_MASTER_KEY: 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=',
        GATEWAY_PORT: String(gatewayPort),
        DATABASE_URL: process.env.TMEX_E2E_DATABASE_URL ?? `/tmp/tmex-e2e-${Date.now()}.db`,
        TMEX_BASE_URL: `http://localhost:${gatewayPort}`,
        // shell 可能继承安装版 app.env 的 TMEX_MIGRATIONS_DIR（指向生产 resources 的旧
        // migrations，缺新表），必须钉回仓库内目录
        TMEX_MIGRATIONS_DIR: join(configDir, '../gateway/drizzle'),
      },
      url: `http://localhost:${gatewayPort}/healthz`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI && !forceFreshServers,
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
        // shell 可能继承安装版 app.env 的 NODE_ENV=production，会污染 vite dev 的依赖预打包
        NODE_ENV: 'development',
        FE_PORT: String(fePort),
        TMEX_GATEWAY_URL: `http://localhost:${gatewayPort}`,
      },
      url: `http://localhost:${fePort}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI && !forceFreshServers,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});

export { DEFAULT_GATEWAY_PORT, DEFAULT_FE_PORT };
