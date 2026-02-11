import { existsSync } from 'node:fs';
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
const adminPassword = process.env.TMEX_E2E_ADMIN_PASSWORD ?? 'admin123';
const bunExecutable = resolveBunExecutable();

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
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
      command: `${bunExecutable} apps/gateway/src/index.ts`,
      env: {
        NODE_ENV: 'development',
        TMEX_MASTER_KEY: 'tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=',
        TMEX_ADMIN_PASSWORD: adminPassword,
        JWT_SECRET: 'dev-jwt-secret-not-for-production',
        GATEWAY_PORT: String(gatewayPort),
        DATABASE_URL: process.env.TMEX_E2E_DATABASE_URL ?? `/tmp/tmex-e2e-${Date.now()}.db`,
        TMEX_BASE_URL: `http://localhost:${gatewayPort}`,
      },
      url: `http://localhost:${gatewayPort}/healthz`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
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
        FE_PORT: String(fePort),
        TMEX_GATEWAY_URL: `http://localhost:${gatewayPort}`,
      },
      url: `http://localhost:${fePort}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});

export { DEFAULT_GATEWAY_PORT, DEFAULT_FE_PORT };
