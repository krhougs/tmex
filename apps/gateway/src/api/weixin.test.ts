import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Server } from 'bun';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { deleteWeixinAccount, ensureSiteSettingsInitialized, getAllWeixinAccounts } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { weixinService } from '../weixin/service';
import { handleApiRequest } from './index';

const fakeServer = {} as unknown as Server<unknown>;

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  // 测试库共享：清空既有微信账号，避免单例 refresh() 接管其它测试遗留的已登录账号去打真实网络。
  for (const account of getAllWeixinAccounts()) {
    deleteWeixinAccount(account.id);
  }
});

afterAll(async () => {
  await weixinService.stopAll();
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type AccountEntry = {
  id: string;
  name: string;
  loggedIn: boolean;
  authorizedCount: number;
};

describe('weixin account api routing', () => {
  test('account lifecycle: create / list / patch / users / login-status / delete', async () => {
    const created = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: 'wx-api' }),
      fakeServer
    );
    expect(created.status).toBe(201);
    const { accountId } = await bodyOf<{ accountId: string }>(created);
    expect(accountId).toBeTruthy();

    const list = await bodyOf<{ accounts: AccountEntry[] }>(
      await handleApiRequest(req('GET', '/api/settings/weixin/accounts'), fakeServer)
    );
    const entry = list.accounts.find((a) => a.id === accountId);
    expect(entry).toMatchObject({ name: 'wx-api', loggedIn: false, authorizedCount: 0 });

    const patched = await handleApiRequest(
      req('PATCH', `/api/settings/weixin/accounts/${accountId}`, {
        name: 'wx-api-2',
        allowAuthRequests: false,
      }),
      fakeServer
    );
    expect(patched.status).toBe(200);

    const usersRes = await handleApiRequest(
      req('GET', `/api/settings/weixin/accounts/${accountId}/users`),
      fakeServer
    );
    expect(usersRes.status).toBe(200);
    expect((await bodyOf<{ users: unknown[] }>(usersRes)).users).toEqual([]);

    const statusRes = await handleApiRequest(
      req('GET', `/api/settings/weixin/accounts/${accountId}/login/status`),
      fakeServer
    );
    expect(statusRes.status).toBe(200);
    expect((await bodyOf<{ loggedIn: boolean }>(statusRes)).loggedIn).toBe(false);

    const del = await handleApiRequest(
      req('DELETE', `/api/settings/weixin/accounts/${accountId}`),
      fakeServer
    );
    expect(del.status).toBe(200);

    const list2 = await bodyOf<{ accounts: AccountEntry[] }>(
      await handleApiRequest(req('GET', '/api/settings/weixin/accounts'), fakeServer)
    );
    expect(list2.accounts.some((a) => a.id === accountId)).toBe(false);
  });

  test('create requires non-empty name', async () => {
    const res = await handleApiRequest(
      req('POST', '/api/settings/weixin/accounts', { name: '   ' }),
      fakeServer
    );
    expect(res.status).toBe(400);
  });

  test('unknown account returns 404', async () => {
    const res = await handleApiRequest(
      req('GET', '/api/settings/weixin/accounts/does-not-exist/users'),
      fakeServer
    );
    expect(res.status).toBe(404);
  });
});
