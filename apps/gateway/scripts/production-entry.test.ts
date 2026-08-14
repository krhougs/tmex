import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const gatewayRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(gatewayRoot, '../..');

describe('Gateway production entry contract', () => {
  test('uses Rust for repository, Playwright, and container entry points', () => {
    const packageJson = JSON.parse(readFileSync(join(gatewayRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.dev).toContain('run-rust-gateway.sh');
    expect(packageJson.scripts.build).toContain('cargo build --locked');
    expect(packageJson.scripts.start).toContain('target/release/tmex-gateway');
    expect(packageJson.scripts['test:oracle']).toBe('bun test');

    const devSupervisor = readFileSync(join(repoRoot, 'scripts/dev-supervisor.sh'), 'utf8');
    const playwright = readFileSync(join(repoRoot, 'apps/fe/playwright.config.ts'), 'utf8');
    const dockerfile = readFileSync(join(gatewayRoot, 'Dockerfile'), 'utf8');
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    expect(devSupervisor).toContain('apps/gateway/scripts/run-rust-gateway.sh');
    expect(playwright).toContain('apps/gateway/scripts/run-rust-gateway.sh');
    expect(dockerfile).toContain('cargo build --locked --release --package tmex-gateway');
    expect(dockerfile).toContain('CMD ["tmex-gateway"]');
    expect(dockerfile).not.toContain('oven/bun');
    expect(dockerfile).not.toContain('dist/index.js');
    expect(compose).toContain('TMEX_BIND_HOST: 0.0.0.0');
    expect(compose).toContain('/home/tmex/.ssh:ro');
    expect(compose).not.toContain('bun');
    expect(`${dockerfile}\n${compose}`).not.toContain('TMEX_MIGRATIONS_DIR');
  });

  test('keeps TypeScript as an oracle without managed artifact producers', () => {
    expect(existsSync(join(gatewayRoot, 'src/index.ts'))).toBe(true);
    for (const script of [
      'build.ts',
      'build-managed.ts',
      'run-managed-smoke.ts',
      'scan-managed-artifact.ts',
      'smoke-managed-linux.sh',
    ]) {
      expect(existsSync(join(gatewayRoot, 'scripts', script))).toBe(false);
    }

    const envLoader = readFileSync(join(repoRoot, 'packages/shared/src/env/load-env.ts'), 'utf8');
    expect(envLoader).not.toContain('TMEX_MIGRATIONS_DIR');
  });
});
