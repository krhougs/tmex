// 三套环境加载器单元测试

import { describe, expect, it } from 'bun:test';
import { type LoadEnvOptions, loadEnv, parseEnvFile, resolveEnvName } from './load-env';

const REPO_ROOT = '/repo';
const INSTALL_DIR = '/Users/x/Library/Application Support/tmex';

const DEV_ENV_FILE = [
  'NODE_ENV=development',
  'GATEWAY_PORT=19663',
  'FE_PORT=19883',
  'DATABASE_URL=./tmex.db',
  'TMEX_BASE_URL=http://127.0.0.1:19663',
  '# 注释行',
  '',
].join('\n');

const TEST_ENV_FILE = ['NODE_ENV=test', 'TMEX_MASTER_KEY=key', 'TMEX_SITE_NAME=tmex'].join('\n');

function fileReaderFrom(files: Record<string, string>): (path: string) => string | null {
  return (path: string) => files[path] ?? null;
}

describe('parseEnvFile', () => {
  it('解析基本 KEY=VALUE，跳过空行与注释', () => {
    const parsed = parseEnvFile('A=1\n\n# c\nB=2\n');
    expect(parsed).toEqual({ A: '1', B: '2' });
  });

  it('去除成对引号、export 前缀，保留值中的 =', () => {
    const parsed = parseEnvFile('export A="hello"\nB=\'world\'\nC=a=b=c\n');
    expect(parsed).toEqual({ A: 'hello', B: 'world', C: 'a=b=c' });
  });

  it('忽略无 = 的行与空 key', () => {
    const parsed = parseEnvFile('garbage\n=novalue\nA=1');
    expect(parsed).toEqual({ A: '1' });
  });
});

describe('resolveEnvName', () => {
  it('production / test 精确匹配，其余回退 development', () => {
    expect(resolveEnvName('production')).toBe('production');
    expect(resolveEnvName('test')).toBe('test');
    expect(resolveEnvName('development')).toBe('development');
    expect(resolveEnvName(undefined)).toBe('development');
    expect(resolveEnvName('staging')).toBe('development');
  });
});

describe('loadEnv - development', () => {
  it('文件值 override 继承的 shell 值，并净化安装版毒变量', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'development',
      GATEWAY_PORT: '9883', // 继承自安装版，应被文件覆盖
      TMEX_MIGRATIONS_DIR: `${INSTALL_DIR}/resources/gateway-drizzle`, // 毒变量
      SSH_AUTH_SOCK: '/tmp/agent.sock', // 文件未定义，应保留
    };
    const name = loadEnv({
      env,
      repoRoot: REPO_ROOT,
      silent: true,
      readFile: fileReaderFrom({ [`${REPO_ROOT}/development.env`]: DEV_ENV_FILE }),
    });

    expect(name).toBe('development');
    expect(env.GATEWAY_PORT).toBe('19663');
    expect(env.TMEX_MIGRATIONS_DIR).toBeUndefined(); // 已净化
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock'); // 保留
    expect(env.DATABASE_URL).toBe(`${REPO_ROOT}/tmex.db`); // 相对路径解析到仓库根
  });

  it('.local 覆盖 .env', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development' };
    loadEnv({
      env,
      repoRoot: REPO_ROOT,
      silent: true,
      readFile: fileReaderFrom({
        [`${REPO_ROOT}/development.env`]: 'GATEWAY_PORT=19663',
        [`${REPO_ROOT}/development.env.local`]: 'GATEWAY_PORT=29663',
      }),
    });
    expect(env.GATEWAY_PORT).toBe('29663');
  });
});

describe('loadEnv - test', () => {
  it('加载 test.env 共享配置，且不动文件未定义的接线键（如 :memory:）', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:', // 由 preload 注入的接线键，文件未定义，应保留
    };
    loadEnv({
      env,
      repoRoot: REPO_ROOT,
      silent: true,
      readFile: fileReaderFrom({ [`${REPO_ROOT}/test.env`]: TEST_ENV_FILE }),
    });

    expect(env.TMEX_MASTER_KEY).toBe('key');
    expect(env.DATABASE_URL).toBe(':memory:'); // 未被覆盖，也未被相对解析
  });
});

describe('loadEnv - production', () => {
  function prodEnv(): Record<string, string | undefined> {
    return {
      NODE_ENV: 'production',
      TMEX_MASTER_KEY: 'k',
      GATEWAY_PORT: '9883',
      TMEX_BIND_HOST: '127.0.0.1',
      DATABASE_URL: `${INSTALL_DIR}/data/tmex.db`,
      TMEX_FE_DIST_DIR: `${INSTALL_DIR}/resources/fe-dist`,
      TMEX_MIGRATIONS_DIR: `${INSTALL_DIR}/resources/gateway-drizzle`,
    };
  }

  const prodOpts = (env: Record<string, string | undefined>): LoadEnvOptions => ({
    env,
    silent: true,
    dirExists: () => true,
    readFile: () => {
      throw new Error('production 不应读取任何仓库文件');
    },
  });

  it('契约齐全时通过，且不读文件、不净化指向安装目录的路径键', () => {
    const env = prodEnv();
    const name = loadEnv(prodOpts(env));

    expect(name).toBe('production');
    // 关键安全断言：生产路径键即使含安装目录标记也绝不能被删除
    expect(env.TMEX_MIGRATIONS_DIR).toBe(`${INSTALL_DIR}/resources/gateway-drizzle`);
    expect(env.TMEX_FE_DIST_DIR).toBe(`${INSTALL_DIR}/resources/fe-dist`);
  });

  it('缺少 TMEX_MASTER_KEY 时 fail-fast 抛错', () => {
    const env = prodEnv();
    env.TMEX_MASTER_KEY = undefined;
    expect(() => loadEnv(prodOpts(env))).toThrow(/TMEX_MASTER_KEY/);
  });

  it('路径键目录不存在时 fail-fast 抛错', () => {
    const env = prodEnv();
    expect(() =>
      loadEnv({ env, silent: true, dirExists: () => false, readFile: () => null })
    ).toThrow(/TMEX_FE_DIST_DIR|TMEX_MIGRATIONS_DIR/);
  });
});
