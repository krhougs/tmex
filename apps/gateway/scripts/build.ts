// 构建 gateway（docker 镜像入口），构建期注入 monorepo 版本号。
//
// 版本真相源是 packages/app/package.json（发布的 tmex-cli 版本）。docker builder 需在
// 构建前 COPY packages/app/package.json 才能读到；读不到时退回 0.0.0（运行时再走其他回退）。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const gatewayRoot = resolve(import.meta.dir, '..');
const appPkgPath = resolve(gatewayRoot, '../../packages/app/package.json');

let version = '0.0.0';
try {
  version =
    (JSON.parse(readFileSync(appPkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
} catch {
  console.warn('[build] packages/app/package.json not found, version falls back to 0.0.0');
}

console.log(`[build] injecting TMEX_MONOREPO_VERSION="${version}"`);

const r = spawnSync(
  'bun',
  [
    'build',
    'src/index.ts',
    '--outdir',
    './dist',
    '--target',
    'bun',
    '--define',
    `TMEX_MONOREPO_VERSION="${version}"`,
  ],
  { cwd: gatewayRoot, stdio: 'inherit' }
);
process.exit(r.status ?? 1);
