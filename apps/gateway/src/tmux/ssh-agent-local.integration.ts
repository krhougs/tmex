import { describe, expect, test } from 'bun:test';
import { Client } from 'ssh2';

function resolveCurrentUser(): string {
  const user = process.env.USER?.trim() || process.env.LOGNAME?.trim();
  if (!user) {
    throw new Error('无法确定当前用户名（USER/LOGNAME 未设置）');
  }
  return user;
}

function resolveAgentSocket(): string {
  const socket = process.env.SSH_AUTH_SOCK?.trim();
  if (!socket) {
    throw new Error('SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 测试');
  }
  return socket;
}

describe('SSH agent localhost integration', () => {
  test('should login localhost via ssh-agent with current user', async () => {
    const username = resolveCurrentUser();
    const agent = resolveAgentSocket();

    await new Promise<void>((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        conn.end();
        reject(
          new Error(
            `SSH localhost agent 登录超时：username=${username}, host=127.0.0.1, port=22, hasAuthSock=${Boolean(agent)}`
          )
        );
      }, 10_000);

      const rejectWith = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        conn.end();

        const message = error instanceof Error ? error.message : String(error);
        reject(
          new Error(
            `SSH localhost agent 登录失败：username=${username}, host=127.0.0.1, port=22, hasAuthSock=${Boolean(agent)}, error=${message}`
          )
        );
      };

      conn.on('ready', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        conn.end();
        resolve();
      });

      conn.on('error', (err) => {
        rejectWith(err);
      });

      conn.on('close', () => {
        if (!settled) {
          rejectWith(new Error('连接在 ready 之前关闭'));
        }
      });

      conn.connect({
        host: '127.0.0.1',
        port: 22,
        username,
        agent,
      });
    });

    expect(true).toBe(true);
  });
});

