import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { encrypt } from '../crypto';
import {
  type WeixinAccountConfigRecord,
  approveWeixinUser,
  createWeixinAccount,
  deleteWeixinAccount,
  getAllWeixinAccounts,
  getWeixinAccountById,
  getWeixinUserByAccountAndUserId,
  getWeixinUserContextTokens,
  setWeixinUserNeedsReactivation,
  updateWeixinAccount,
  upsertWeixinUserOnInbound,
} from '../db';
import { getDb as getOrmDb } from '../db/client';
import {
  type WeixinClient,
  WeixinNoContextTokenError,
  WeixinSessionExpiredError,
} from './ilink/client';
import type { WeixinStartOptions } from './ilink/client';
import { WeixinService } from './service';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

class FakeClient {
  sentTexts: Array<{ to: string; text: string }> = [];
  startOpts?: WeixinStartOptions;
  sendBehavior: (to: string) => void = () => {};

  async start(opts: WeixinStartOptions): Promise<void> {
    this.startOpts = opts;
    return new Promise<void>(() => {});
  }
  stop(): void {}
  async sendText(to: string, text: string): Promise<void> {
    this.sentTexts.push({ to, text });
    this.sendBehavior(to);
  }
}

async function setupRunningAccount(opts: { withUser?: boolean } = {}): Promise<{
  service: WeixinService;
  fake: FakeClient;
  accountId: string;
}> {
  // 测试库共享：清空既有微信账号，保证 refresh() 只接管本测试的账号。
  for (const existing of getAllWeixinAccounts()) {
    deleteWeixinAccount(existing.id);
  }

  const now = new Date().toISOString();
  const account: WeixinAccountConfigRecord = {
    id: crypto.randomUUID(),
    name: 'svc',
    enabled: true,
    allowAuthRequests: true,
    loggedIn: false,
    weixinUin: null,
    botTokenEnc: null,
    baseUrl: null,
    syncBuf: null,
    createdAt: now,
    updatedAt: now,
  };
  createWeixinAccount(account);
  updateWeixinAccount(account.id, {
    weixinUin: 'uin',
    botTokenEnc: await encrypt('tok'),
    baseUrl: 'https://ilink.example.com',
  });

  if (opts.withUser) {
    upsertWeixinUserOnInbound({
      accountId: account.id,
      userId: 'u1',
      displayName: 'u1',
      contextToken: 'ctx-u1',
      allowAuthRequests: true,
      at: now,
    });
    approveWeixinUser(account.id, 'u1');
  }

  const fake = new FakeClient();
  const service = new WeixinService(() => fake as unknown as WeixinClient);
  await service.refresh();
  return { service, fake, accountId: account.id };
}

describe('WeixinService send semantics', () => {
  test('sends to authorized user and clears needsReactivation on success', async () => {
    const { service, fake, accountId } = await setupRunningAccount({ withUser: true });
    setWeixinUserNeedsReactivation(accountId, 'u1', true);

    await service.sendToAuthorizedUsers({ text: 'hello-wx' });

    expect(fake.sentTexts).toContainEqual({ to: 'u1', text: 'hello-wx' });
    expect(getWeixinUserByAccountAndUserId(accountId, 'u1')?.needsReactivation).toBe(false);
    await service.stopAll();
  });

  test('marks needsReactivation when send throws no-context-token', async () => {
    const { service, fake, accountId } = await setupRunningAccount({ withUser: true });
    fake.sendBehavior = () => {
      throw new WeixinNoContextTokenError('u1');
    };

    await service.sendToAuthorizedUsers({ text: 'x' });

    expect(getWeixinUserByAccountAndUserId(accountId, 'u1')?.needsReactivation).toBe(true);
    await service.stopAll();
  });

  test('session expired on send clears credentials and flags users', async () => {
    const { service, fake, accountId } = await setupRunningAccount({ withUser: true });
    fake.sendBehavior = () => {
      throw new WeixinSessionExpiredError();
    };

    await service.sendToAuthorizedUsers({ text: 'x' });

    const account = getWeixinAccountById(accountId);
    expect(account?.loggedIn).toBe(false);
    expect(getWeixinUserByAccountAndUserId(accountId, 'u1')?.needsReactivation).toBe(true);
    await service.stopAll();
  });

  test('inbound from new user creates pending, caches token, and sends ack', async () => {
    const { service, fake, accountId } = await setupRunningAccount();
    const onMessage = fake.startOpts?.onMessage;
    expect(onMessage).toBeDefined();

    await onMessage?.({ fromUserId: 'u2', contextToken: 'ctx-u2', text: 'hi', raw: {} });

    const user = getWeixinUserByAccountAndUserId(accountId, 'u2');
    expect(user?.status).toBe('pending');
    expect(getWeixinUserContextTokens(accountId)).toContainEqual({
      userId: 'u2',
      contextToken: 'ctx-u2',
    });
    expect(fake.sentTexts.some((m) => m.to === 'u2')).toBe(true);
    await service.stopAll();
  });
});
