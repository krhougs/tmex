// 打包 runtime（内联 gateway），并在构建期注入 monorepo 版本号。
//
// 注入 TMEX_MONOREPO_VERSION 后，运行时 apps/gateway/src/system/version.ts 的
// typeof 守卫被短路，安装版/容器版无需再依赖 install-meta 或仓库 package.json 即可拿到版本。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkgRoot = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  version?: string;
};
const version = pkg.version ?? '0.0.0';

console.log(`[build:runtime] injecting TMEX_MONOREPO_VERSION="${version}"`);

const build = spawnSync(
  'bun',
  [
    'build',
    'src/runtime/server.ts',
    '--outdir',
    './dist/runtime',
    '--target',
    'bun',
    '--format',
    'esm',
    '--define',
    `TMEX_MONOREPO_VERSION="${version}"`,
  ],
  { cwd: pkgRoot, stdio: 'inherit' }
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const copy = spawnSync('bash', ['./scripts/copy-runtime-assets.sh'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
if (copy.status !== 0) {
  process.exit(copy.status ?? 1);
}
