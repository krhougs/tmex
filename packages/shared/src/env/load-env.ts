// 三套环境（development / test / production）统一环境变量加载器。
//
// 设计要点：
// - production 走专属分支：只校验生产契约（变量由安装版 run.sh 经 app.env 注入），
//   绝不读取仓库 env 文件、绝不净化路径键（生产里这些键正是安装目录路径）。
// - development / test：净化继承的安装版毒变量 → 读 <env>.env / <env>.env.local
//   → override=true 应用，使仓库文件成为该环境的唯一真相。
// 详见 docs 与 prompt-archives/2026061301-env-three-tier/plan-00.md。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 安装目录标记：继承自安装版 app.env 的路径键会带此片段 */
const INSTALL_MARKER = 'Application Support/tmex';

/** 指向安装目录、dev/test 下需要净化的路径键 */
const PATH_KEYS = ['TMEX_MIGRATIONS_DIR', 'TMEX_FE_DIST_DIR'] as const;

/** 生产必需且非空的键 */
const PRODUCTION_REQUIRED = [
  'TMEX_MASTER_KEY',
  'GATEWAY_PORT',
  'TMEX_BIND_HOST',
  'DATABASE_URL',
] as const;

/** 生产必需且必须指向真实存在目录的键（由 run.sh export） */
const PRODUCTION_REQUIRED_DIRS = ['TMEX_FE_DIST_DIR', 'TMEX_MIGRATIONS_DIR'] as const;

export type EnvName = 'development' | 'test' | 'production';

type MutableEnv = Record<string, string | undefined>;

export interface LoadEnvOptions {
  /** 覆盖 NODE_ENV；缺省读 env.NODE_ENV */
  nodeEnv?: string;
  /** 目标环境对象；缺省 process.env（测试可注入纯对象） */
  env?: MutableEnv;
  /** 仓库根；缺省由 import.meta.dir 上溯定位（测试可注入） */
  repoRoot?: string;
  /** 静默日志 */
  silent?: boolean;
  /** 目录是否存在；缺省 existsSync（测试可注入） */
  dirExists?: (path: string) => boolean;
  /** 读取文件文本，不存在返回 null；缺省读真实文件（测试可注入） */
  readFile?: (path: string) => string | null;
}

export function resolveEnvName(raw: string | undefined): EnvName {
  if (raw === 'production') return 'production';
  if (raw === 'test') return 'test';
  return 'development';
}

function moduleDir(): string {
  // Bun 提供 import.meta.dir；Node / 通用回退到 import.meta.url。
  const bunDir = (import.meta as { dir?: string }).dir;
  if (typeof bunDir === 'string') return bunDir;
  return dirname(fileURLToPath(import.meta.url));
}

function defaultRepoRoot(): string {
  // packages/shared/src/env/load-env.ts → 仓库根
  return resolve(moduleDir(), '../../../..');
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 解析 KEY=VALUE 文本，跳过空行与 # 注释，去成对引号与 export 前缀 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** DATABASE_URL 是否为无需相对解析的特殊形态 */
function isSpecialDatabaseUrl(value: string): boolean {
  return isAbsolute(value) || /^(file:|sqlite:|https?:|:memory:)/.test(value);
}

/**
 * 按 NODE_ENV 加载环境变量，就地写入目标 env（默认 process.env）。
 * 返回解析出的环境名。production 缺失必需变量时抛错（fail-fast）。
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvName {
  const env = options.env ?? (process.env as MutableEnv);
  const name = resolveEnvName(options.nodeEnv ?? env.NODE_ENV);
  const log = options.silent ? () => {} : (msg: string) => console.log(`[env] ${msg}`);

  if (name === 'production') {
    applyProductionEnv(env, options, log);
  } else {
    applyRepoEnv(name, env, options, log);
  }
  return name;
}

function applyProductionEnv(
  env: MutableEnv,
  options: LoadEnvOptions,
  log: (msg: string) => void
): void {
  const dirExists = options.dirExists ?? existsSync;
  const missing: string[] = [];

  for (const key of PRODUCTION_REQUIRED) {
    if (!env[key]) missing.push(key);
  }
  for (const key of PRODUCTION_REQUIRED_DIRS) {
    const value = env[key];
    if (!value) {
      missing.push(key);
    } else if (!dirExists(value)) {
      missing.push(`${key}（目录不存在: ${value}）`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[env] 生产环境启动校验失败，缺少/无效的必需变量：${missing.join('、')}。生产变量应由安装版 run.sh 经 app.env 注入；请检查 app.env 是否完整、TMEX_FE_DIST_DIR/TMEX_MIGRATIONS_DIR 是否指向已部署的 resources 目录，或重新执行 \`tmex upgrade\` 重建 run.sh。`
    );
  }

  // 生产不读取任何仓库文件、不修改注入值，仅打印可观测摘要。
  log(
    `production: 使用 app.env 注入变量（不读仓库 env 文件） port=${env.GATEWAY_PORT} host=${env.TMEX_BIND_HOST} db=${env.DATABASE_URL}`
  );
}

function applyRepoEnv(
  name: EnvName,
  env: MutableEnv,
  options: LoadEnvOptions,
  log: (msg: string) => void
): void {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const readFile = options.readFile ?? defaultReadFile;

  // 1. 净化继承的安装版毒变量（收敛 dev-supervisor / test-preload 散点 hack）
  for (const key of PATH_KEYS) {
    const value = env[key];
    if (value?.includes(INSTALL_MARKER)) {
      delete env[key];
      log(`净化继承的安装版变量 ${key}`);
    }
  }

  // 2. 读取 <env>.env 与 <env>.env.local（后者覆盖前者）
  const merged: Record<string, string> = {};
  let loadedAny = false;
  for (const file of [`${name}.env`, `${name}.env.local`]) {
    const content = readFile(resolve(repoRoot, file));
    if (content == null) continue;
    Object.assign(merged, parseEnvFile(content));
    loadedAny = true;
    log(`已加载 ${file}`);
  }
  if (!loadedAny) {
    log(`未找到 ${name}.env（仓库根: ${repoRoot}），仅依赖进程已有变量`);
  }

  // 3. override=true 应用：文件定义的键覆盖继承的 shell 值，
  //    文件未定义的键（如各测试上下文的接线键）保持原值不动。
  for (const [key, value] of Object.entries(merged)) {
    env[key] = value;
  }

  // 4. 相对 DATABASE_URL 解析到仓库根（沿用 dev-supervisor 行为）
  const db = env.DATABASE_URL;
  if (db && !isSpecialDatabaseUrl(db)) {
    env.DATABASE_URL = resolve(repoRoot, db.replace(/^\.\//, ''));
  }
}
