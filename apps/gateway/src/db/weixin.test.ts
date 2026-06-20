import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import {
  type WeixinAccountConfigRecord,
  approveWeixinUser,
  createWeixinAccount,
  deleteWeixinAccount,
  getWeixinAccountById,
  getWeixinAccountsWithStats,
  getWeixinUserByAccountAndUserId,
  getWeixinUserContextTokens,
  listAuthorizedWeixinUsersByAccount,
  setWeixinUserNeedsReactivation,
  updateWeixinAccount,
  upsertWeixinUserOnInbound,
} from './index';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function makeAccount(
  overrides: Partial<WeixinAccountConfigRecord> = {}
): WeixinAccountConfigRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'wx',
    enabled: true,
    allowAuthRequests: true,
    loggedIn: false,
    weixinUin: null,
    botTokenEnc: null,
    baseUrl: null,
    syncBuf: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('weixin account db', () => {
  test('create / loggedIn derivation / credential update + clear', () => {
    const account = makeAccount({ name: 'acc-a' });
    createWeixinAccount(account);

    const created = getWeixinAccountById(account.id);
    expect(created?.loggedIn).toBe(false);
    expect(created?.name).toBe('acc-a');

    updateWeixinAccount(account.id, {
      weixinUin: 'uin-1',
      botTokenEnc: 'enc-token',
      baseUrl: 'https://ilink.example.com',
    });
    const loggedIn = getWeixinAccountById(account.id);
    expect(loggedIn?.loggedIn).toBe(true);
    expect(loggedIn?.weixinUin).toBe('uin-1');

    updateWeixinAccount(account.id, { botTokenEnc: null, baseUrl: null, weixinUin: null });
    expect(getWeixinAccountById(account.id)?.loggedIn).toBe(false);
  });

  test('inbound upsert: new pending caches token; allowAuthRequests=false ignores new user', () => {
    const account = makeAccount();
    createWeixinAccount(account);
    const now = new Date().toISOString();

    const user = upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'u-pending',
      displayName: 'u-pending',
      contextToken: 'ctx-1',
      allowAuthRequests: true,
      at: now,
    });
    expect(user?.status).toBe('pending');
    expect(user?.needsReactivation).toBe(false);

    const tokens = getWeixinUserContextTokens(account.id);
    expect(tokens).toContainEqual({ userId: 'u-pending', contextToken: 'ctx-1' });

    const ignored = upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'u-new',
      displayName: 'u-new',
      contextToken: 'ctx-x',
      allowAuthRequests: false,
      at: now,
    });
    expect(ignored).toBeNull();
    expect(getWeixinUserByAccountAndUserId(account.id, 'u-new')).toBeNull();
  });

  test('inbound on existing user refreshes token and clears needsReactivation', () => {
    const account = makeAccount();
    createWeixinAccount(account);
    const t0 = new Date().toISOString();
    upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'u1',
      displayName: 'u1',
      contextToken: 'ctx-old',
      allowAuthRequests: true,
      at: t0,
    });
    approveWeixinUser(account.id, 'u1');
    setWeixinUserNeedsReactivation(account.id, 'u1', true);
    expect(getWeixinUserByAccountAndUserId(account.id, 'u1')?.needsReactivation).toBe(true);

    upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'u1',
      displayName: 'u1',
      contextToken: 'ctx-new',
      allowAuthRequests: true,
      at: new Date().toISOString(),
    });

    const refreshed = getWeixinUserByAccountAndUserId(account.id, 'u1');
    expect(refreshed?.needsReactivation).toBe(false);
    expect(refreshed?.status).toBe('authorized');
    const tokens = getWeixinUserContextTokens(account.id);
    expect(tokens).toContainEqual({ userId: 'u1', contextToken: 'ctx-new' });
  });

  test('approve + authorized list + stats counts', () => {
    const account = makeAccount();
    createWeixinAccount(account);
    const now = new Date().toISOString();
    for (const id of ['a', 'b', 'c']) {
      upsertWeixinUserOnInbound({
        accountId: account.id,
        userId: id,
        displayName: id,
        contextToken: `ctx-${id}`,
        allowAuthRequests: true,
        at: now,
      });
    }
    approveWeixinUser(account.id, 'a');
    approveWeixinUser(account.id, 'b');
    setWeixinUserNeedsReactivation(account.id, 'b', true);

    const authorized = listAuthorizedWeixinUsersByAccount(account.id);
    expect(authorized.map((u) => u.userId).sort()).toEqual(['a', 'b']);

    const stats = getWeixinAccountsWithStats().find((s) => s.id === account.id);
    expect(stats?.authorizedCount).toBe(2);
    expect(stats?.pendingCount).toBe(1);
    expect(stats?.needsReactivationCount).toBe(1);
  });

  test('user cap enforced at 16', () => {
    const account = makeAccount();
    createWeixinAccount(account);
    const now = new Date().toISOString();
    for (let i = 0; i < 16; i += 1) {
      upsertWeixinUserOnInbound({
        accountId: account.id,
        userId: `cap-${i}`,
        displayName: `cap-${i}`,
        contextToken: 'ctx',
        allowAuthRequests: true,
        at: now,
      });
    }
    expect(() =>
      upsertWeixinUserOnInbound({
        accountId: account.id,
        userId: 'cap-overflow',
        displayName: 'cap-overflow',
        contextToken: 'ctx',
        allowAuthRequests: true,
        at: now,
      })
    ).toThrow();
  });

  test('delete account cascades users', () => {
    const account = makeAccount();
    createWeixinAccount(account);
    upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'cascade-u',
      displayName: 'cascade-u',
      contextToken: 'ctx',
      allowAuthRequests: true,
      at: new Date().toISOString(),
    });
    deleteWeixinAccount(account.id);
    expect(getWeixinAccountById(account.id)).toBeNull();
    expect(getWeixinUserByAccountAndUserId(account.id, 'cascade-u')).toBeNull();
  });
});
