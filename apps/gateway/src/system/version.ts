import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatDisplayVersion } from '@tmex/shared';
import { config } from '../config';
import { readInstallMeta } from './install-info';

// 构建期注入（packages/app build:runtime / apps/gateway build）。未注入时为 undefined，
// 用 typeof 守卫避免 ReferenceError。打包产物总会注入，从而短路下方运行时回退。
declare const TMEX_MONOREPO_VERSION: string | undefined;

let cachedBase: string | undefined;

/**
 * dev/test 回退：从本模块上溯仓库根读 packages/app/package.json。
 * 仅未打包的源码运行时命中（打包产物有 define 短路，不会走到这里）。
 */
function readRepoPackageVersion(): string | null {
  const dir = (import.meta as { dir?: string }).dir;
  if (!dir) return null;
  // apps/gateway/src/system → 仓库根需上溯 4 级
  const path = resolve(dir, '../../../../packages/app/package.json');
  try {
    if (!existsSync(path)) return null;
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** monorepo 原始版本号（= 发布的 tmex-cli 版本，唯一真相源） */
export function getBaseVersion(): string {
  if (cachedBase !== undefined) return cachedBase;

  let base: string | null = null;

  // 1. 构建期注入（主生产路径）
  if (typeof TMEX_MONOREPO_VERSION === 'string' && TMEX_MONOREPO_VERSION) {
    base = TMEX_MONOREPO_VERSION;
  }

  // 2. production 兜底：install-meta.cliVersion
  if (!base && config.isProd) {
    base = readInstallMeta()?.cliVersion ?? null;
  }

  // 3. dev/test：仓库 package.json
  if (!base) {
    base = readRepoPackageVersion();
  }

  cachedBase = base ?? 'unknown';
  return cachedBase;
}

/** 展示版本（非 production 追加 _dev 后缀） */
export function getDisplayVersion(): string {
  return formatDisplayVersion(getBaseVersion(), config.isProd);
}
