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

const baseURL = process.env.TMEX_E2E_BASE_URL ?? 'http://localhost:3000';
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
    baseURL,
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
        GATEWAY_PORT: '8080',
        DATABASE_URL: '/tmp/tmex-e2e.db',
        TMEX_BASE_URL: 'http://localhost:8080',
      },
      url: 'http://localhost:8080/healthz',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
    {
      name: 'fe',
      cwd: '.',
      command: 'npm run dev -- --host 0.0.0.0 --port 3000',
      env: { ...process.env },
      url: baseURL,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});
