import { describe, expect, test } from 'bun:test';

import { buildLocalTmuxEnv, createLocalShellPathCache } from './local-shell-path';

describe('local shell PATH cache', () => {
  test('primes PATH from default shell once and caches it', () => {
    let runCount = 0;
    const cache = createLocalShellPathCache({
      platform: 'darwin',
      env: {
        SHELL: '/bin/zsh',
        USER: 'alice',
        PATH: '/usr/bin:/bin',
      },
      fileExists: () => true,
      runSync: () => {
        runCount += 1;
        return {
          exitCode: 0,
          stdout: [
            'some noisy shell output',
            '__TMEX_SHELL_ENV_BEGIN__',
            'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            '__TMEX_SHELL_ENV_END__',
          ].join('\n'),
          stderr: '',
        };
      },
    });

    expect(cache.get()).toBe(null);
    expect(cache.prime()).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    expect(cache.get()).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    expect(cache.prime()).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    expect(runCount).toBe(1);
  });

  test('continues probing when earlier PATH still cannot resolve tmux', () => {
    const commands: string[][] = [];
    const cache = createLocalShellPathCache({
      platform: 'darwin',
      env: {
        SHELL: '/bin/zsh',
        USER: 'alice',
        PATH: '/usr/bin:/bin',
      },
      fileExists: (path) => path === '/bin/zsh' || path === '/opt/homebrew/bin/tmux',
      runSync: (cmd) => {
        commands.push(cmd);

        if (cmd[1] === '-l' && cmd[2] === '-c') {
          return {
            exitCode: 0,
            stdout: [
              '__TMEX_SHELL_ENV_BEGIN__',
              'PATH=/usr/bin:/bin',
              '__TMEX_SHELL_ENV_END__',
            ].join('\n'),
            stderr: '',
          };
        }

        return {
          exitCode: 0,
          stdout: [
            '__TMEX_SHELL_ENV_BEGIN__',
            'PATH=/opt/homebrew/bin:/usr/bin:/bin',
            '__TMEX_SHELL_ENV_END__',
          ].join('\n'),
          stderr: '',
        };
      },
    });

    expect(cache.prime()).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(commands).toEqual([
      [
        '/bin/zsh',
        '-l',
        '-c',
        "printf '__TMEX_SHELL_ENV_BEGIN__\\n'; /usr/bin/env; printf '__TMEX_SHELL_ENV_END__\\n'",
      ],
      [
        '/bin/zsh',
        '-l',
        '-i',
        '-c',
        "printf '__TMEX_SHELL_ENV_BEGIN__\\n'; /usr/bin/env; printf '__TMEX_SHELL_ENV_END__\\n'",
      ],
    ]);
  });

  test('falls back to dscl user shell when SHELL is missing', () => {
    const commands: string[][] = [];
    const cache = createLocalShellPathCache({
      platform: 'darwin',
      env: {
        USER: 'alice',
        PATH: '/usr/bin:/bin',
      },
      fileExists: () => true,
      runSync: (cmd) => {
        commands.push(cmd);
        if (cmd[0] === '/usr/bin/dscl') {
          return {
            exitCode: 0,
            stdout: 'UserShell: /bin/zsh\n',
            stderr: '',
          };
        }

        return {
          exitCode: 0,
          stdout: [
            '__TMEX_SHELL_ENV_BEGIN__',
            'PATH=/opt/homebrew/bin:/usr/bin:/bin',
            '__TMEX_SHELL_ENV_END__',
          ].join('\n'),
          stderr: '',
        };
      },
    });

    expect(cache.prime()).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(commands[0]).toEqual(['/usr/bin/dscl', '.', '-read', '/Users/alice', 'UserShell']);
    expect(commands[1]).toEqual([
      '/bin/zsh',
      '-l',
      '-c',
      "printf '__TMEX_SHELL_ENV_BEGIN__\\n'; /usr/bin/env; printf '__TMEX_SHELL_ENV_END__\\n'",
    ]);
  });
});

describe('buildLocalTmuxEnv', () => {
  test('overrides PATH with cached shell PATH for local tmux spawn', () => {
    expect(
      buildLocalTmuxEnv('/opt/homebrew/bin:/usr/bin:/bin', {
        HOME: '/Users/alice',
        PATH: '/usr/bin:/bin',
        LANG: 'zh_CN.UTF-8',
      })
    ).toEqual({
      HOME: '/Users/alice',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
    });
  });

  test('adds UTF-8 locale when launchd-like env has no locale configured', () => {
    expect(
      buildLocalTmuxEnv('/opt/homebrew/bin:/usr/bin:/bin', {
        HOME: '/Users/alice',
        PATH: '/usr/bin:/bin',
      })
    ).toEqual({
      HOME: '/Users/alice',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      LC_CTYPE: 'en_US.UTF-8',
    });
  });

  test('keeps existing locale values unchanged', () => {
    expect(
      buildLocalTmuxEnv('/opt/homebrew/bin:/usr/bin:/bin', {
        HOME: '/Users/alice',
        PATH: '/usr/bin:/bin',
        LANG: 'zh_CN.UTF-8',
        LC_CTYPE: 'zh_CN.UTF-8',
      })
    ).toEqual({
      HOME: '/Users/alice',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
      LC_CTYPE: 'zh_CN.UTF-8',
    });
  });

  test('strips tmex-injected env (app.env) so user shells never inherit them', () => {
    const result = buildLocalTmuxEnv('/opt/homebrew/bin:/usr/bin:/bin', {
      HOME: '/Users/alice',
      USER: 'alice',
      SHELL: '/bin/zsh',
      PATH: '/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      // 以下均为 tmex 注入，必须被剔除
      NODE_ENV: 'production',
      DATABASE_URL: '/Library/Application Support/tmex/data/tmex.db',
      GATEWAY_PORT: '9883',
      FE_PORT: '8085',
      TMEX_MASTER_KEY: 'super-secret-key',
      TMEX_FE_DIST_DIR: '/Library/Application Support/tmex/resources/fe-dist',
      TMEX_MIGRATIONS_DIR: '/Library/Application Support/tmex/resources/drizzle',
      TMEX_BIND_HOST: '0.0.0.0',
      TMEX_TMUX_TERM_PROGRAM: 'ghostty',
    });

    // tmex 注入键一个都不剩
    for (const key of Object.keys(result)) {
      expect(key.startsWith('TMEX_')).toBe(false);
    }
    expect(result.NODE_ENV).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.GATEWAY_PORT).toBeUndefined();
    expect(result.FE_PORT).toBeUndefined();
    expect(result.TMEX_MASTER_KEY).toBeUndefined();

    // 用户终端需要的键完整保留
    expect(result).toEqual({
      HOME: '/Users/alice',
      USER: 'alice',
      SHELL: '/bin/zsh',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      LANG: 'zh_CN.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
  });
});
