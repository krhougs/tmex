import type {
  StartWeixinLoginResponse,
  WeixinAccountUser,
  WeixinLoginStatus,
  WeixinLoginStatusResponse,
} from '@tmex/shared';
import { decryptWithContext, encrypt } from '../crypto';
import {
  type WeixinAccountConfigRecord,
  getAllWeixinAccounts,
  getWeixinAccountById,
  getWeixinUserContextTokens,
  listAuthorizedWeixinUsersByAccount,
  setWeixinUserNeedsReactivation,
  updateWeixinAccount,
  upsertWeixinUserOnInbound,
} from '../db';
import { t } from '../i18n';
import { WeixinClient, type WeixinClientOptions, WeixinSessionExpiredError } from './ilink/client';
import type { WeixinCredentials, WeixinInboundMessage } from './ilink/types';

export type WeixinClientFactory = (opts: WeixinClientOptions) => WeixinClient;

// 8 小时保活：iLink 无主动 push 且 context_token 会过期，定时提醒已绑定用户回复任意内容以保持新鲜。
const KEEPALIVE_INTERVAL_MS = 8 * 60 * 60 * 1000;
const KEEPALIVE_SWEEP_MS = 30 * 60 * 1000;

interface RunningAccount {
  id: string;
  /** 解密后的 botToken，用于检测 refresh 时凭证是否变化。 */
  botToken: string;
  client: WeixinClient;
}

interface LoginSession {
  status: WeixinLoginStatus;
  message?: string;
  qrcodeUrl: string;
  qrcodeId: string;
  client: WeixinClient;
  abort: AbortController;
}

export class WeixinService {
  private runningAccounts = new Map<string, RunningAccount>();
  private loginSessions = new Map<string, LoginSession>();
  // session 过期告警单次（按 accountId）；成功（重新）启动后重置。
  private sessionExpiredNotified = new Set<string>();
  // refresh 串行化链，防止并发 refresh（登录成功 + update/delete 请求并发）交错导致游离 client 泄漏。
  private refreshChain: Promise<void> = Promise.resolve();
  // 8 小时保活定时器与每用户上次保活时间（in-memory，重启重置）。
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastKeepaliveAt = new Map<string, number>();

  constructor(
    private readonly createClient: WeixinClientFactory = (opts) => new WeixinClient(opts)
  ) {}

  /** 串行化入口：避免并发 refresh 在 await 点交错，导致同一账号被启动两次、旧 client 游离泄漏。 */
  async refresh(): Promise<void> {
    const run = this.refreshChain.then(() => this.doRefresh());
    this.refreshChain = run.catch(() => {});
    return run;
  }

  /** 与 DB 对账：清理孤儿登录会话、停掉失效账号，(重新)启动有效账号的长轮询。 */
  private async doRefresh(): Promise<void> {
    this.ensureKeepaliveTimer();
    const accounts = getAllWeixinAccounts();
    const activeIds = new Set(accounts.map((a) => a.id));

    // 已不存在的账号（如被删除）若仍有进行中的扫码登录会话，中止并清除，
    // 避免后台对已删除账号继续打 iLink 上游轮询、Map 条目悬挂。
    for (const [id, session] of this.loginSessions) {
      if (!activeIds.has(id)) {
        session.abort.abort();
        this.loginSessions.delete(id);
      }
    }

    const toStop: string[] = [];
    for (const [id] of this.runningAccounts) {
      if (!activeIds.has(id)) {
        toStop.push(id);
      }
    }
    await Promise.all(toStop.map((id) => this.stopAccount(id)));

    for (const account of accounts) {
      const shouldRun = account.enabled && account.botTokenEnc != null && account.baseUrl != null;
      if (!shouldRun) {
        await this.stopAccount(account.id);
        continue;
      }

      let botToken: string;
      try {
        botToken = await decryptWithContext(account.botTokenEnc as string, {
          scope: 'weixin_account',
          entityId: account.id,
          field: 'bot_token_enc',
        });
      } catch (err) {
        console.error(`[weixin] failed to decrypt token for ${account.id}:`, err);
        continue;
      }

      const running = this.runningAccounts.get(account.id);
      if (running && running.botToken === botToken) {
        continue;
      }
      if (running) {
        await this.stopAccount(account.id);
      }

      this.startAccount(account, botToken);
    }
  }

  private startAccount(account: WeixinAccountConfigRecord, botToken: string): void {
    const baseUrl = account.baseUrl ?? '';
    const weixinUin = account.weixinUin ?? account.id;
    const client = this.createClient({ accountId: weixinUin, botToken, baseUrl });

    // 同步注水 context_token 缓存：start() 是 detached，若靠它注水则 refresh() 后立刻发消息会取不到 token。
    for (const { userId, contextToken } of getWeixinUserContextTokens(account.id)) {
      client.setContextToken(userId, contextToken);
    }

    this.runningAccounts.set(account.id, { id: account.id, botToken, client });
    this.sessionExpiredNotified.delete(account.id);

    // 长轮询在后台跑（不 await）：过期/异常退出时清理。
    void client
      .start({
        loadSyncBuf: () => getWeixinAccountById(account.id)?.syncBuf ?? undefined,
        saveSyncBuf: (buf) => {
          updateWeixinAccount(account.id, { syncBuf: buf });
        },
        onMessage: (msg) => this.handleInbound(account.id, msg),
        onSessionExpired: () => this.handleSessionExpired(account.id),
        onError: (err) => console.error(`[weixin] account ${account.id} poll error:`, err),
      })
      .catch((err) => {
        if (!(err instanceof WeixinSessionExpiredError)) {
          console.error(`[weixin] account ${account.id} loop crashed:`, err);
        }
      })
      .finally(() => {
        const cur = this.runningAccounts.get(account.id);
        if (cur && cur.client === client) {
          this.runningAccounts.delete(account.id);
        }
      });

    console.log(`[weixin] account started: ${account.name} (${account.id})`);
  }

  private async stopAccount(accountId: string): Promise<void> {
    const running = this.runningAccounts.get(accountId);
    if (!running) {
      return;
    }
    running.client.stop();
    this.runningAccounts.delete(accountId);
    console.log(`[weixin] account stopped: ${accountId}`);
  }

  private async handleInbound(accountId: string, msg: WeixinInboundMessage): Promise<void> {
    const account = getWeixinAccountById(accountId);
    if (!account) {
      return;
    }
    const userId = msg.fromUserId;
    if (!userId) {
      return;
    }

    // 单用户绑定走前端一条龙（扫码 → 引导发消息 → 检测到 pending 自动 approve），
    // 回执由 approve 端点发送；这里只落库：缓存最新 context_token、刷新 lastInboundAt、清 needsReactivation。
    const now = new Date().toISOString();
    try {
      upsertWeixinUserOnInbound({
        accountId,
        userId,
        displayName: userId,
        contextToken: msg.contextToken,
        allowAuthRequests: account.allowAuthRequests,
        at: now,
      });
    } catch (err) {
      console.error('[weixin] failed to upsert user on inbound:', err);
    }
  }

  /** 整个账号的 bot 登录失效（-14）：清凭证、标记授权用户需重激活、单次告警。 */
  private handleSessionExpired(accountId: string): void {
    if (!this.sessionExpiredNotified.has(accountId)) {
      this.sessionExpiredNotified.add(accountId);
      const account = getWeixinAccountById(accountId);
      console.warn(
        `[weixin] account ${account?.name ?? accountId} session expired; re-login required.`
      );
      for (const user of listAuthorizedWeixinUsersByAccount(accountId)) {
        setWeixinUserNeedsReactivation(accountId, user.userId, true);
      }
    }
    updateWeixinAccount(accountId, { botTokenEnc: null, baseUrl: null, weixinUin: null });
  }

  /** 启动上线通知（最佳努力）：向已绑定用户发一条「tmex 上线」。 */
  async sendGatewayOnlineMessage(siteName: string): Promise<void> {
    await this.sendToAuthorizedUsers({ text: t('weixin.gatewayOnline', { siteName }) });
  }

  /** 半主动·最佳努力：向各账号的授权用户用缓存 token 发送；失败标记需重激活。 */
  async sendToAuthorizedUsers(params: { text: string }): Promise<void> {
    for (const [accountId, running] of this.runningAccounts) {
      for (const user of listAuthorizedWeixinUsersByAccount(accountId)) {
        const cont = await this.sendToUser(accountId, running, user, params.text);
        if (!cont) break; // 会话过期：停止该账号后续发送
      }
    }
  }

  /** 给单个授权用户发送。成功（含标记 needsReactivation）返回 true；会话过期返回 false（调用方应停止该账号）。 */
  private async sendToUser(
    accountId: string,
    running: RunningAccount,
    user: WeixinAccountUser,
    text: string
  ): Promise<boolean> {
    try {
      await running.client.sendText(user.userId, text);
      if (user.needsReactivation) {
        setWeixinUserNeedsReactivation(accountId, user.userId, false);
      }
      return true;
    } catch (err) {
      if (err instanceof WeixinSessionExpiredError) {
        this.handleSessionExpired(accountId);
        return false;
      }
      if (!user.needsReactivation) {
        console.warn(
          `[weixin] send to ${user.userId} failed; marking needs-reactivation:`,
          err instanceof Error ? err.message : err
        );
      }
      setWeixinUserNeedsReactivation(accountId, user.userId, true);
      return true;
    }
  }

  private ensureKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      return;
    }
    this.keepaliveTimer = setInterval(() => void this.runKeepaliveSweep(), KEEPALIVE_SWEEP_MS);
    this.keepaliveTimer.unref?.();
  }

  /** 每 30 分钟扫一遍：对距上次 inbound / 上次保活 ≥ 8 小时的已绑定用户发保活提醒。 */
  private async runKeepaliveSweep(): Promise<void> {
    const now = Date.now();
    for (const [accountId, running] of this.runningAccounts) {
      for (const user of listAuthorizedWeixinUsersByAccount(accountId)) {
        const key = `${accountId}:${user.userId}`;
        const lastInbound = user.lastInboundAt ? Date.parse(user.lastInboundAt) : 0;
        const since = Math.max(lastInbound, this.lastKeepaliveAt.get(key) ?? 0);
        if (now - since < KEEPALIVE_INTERVAL_MS) {
          continue;
        }
        this.lastKeepaliveAt.set(key, now);
        const cont = await this.sendToUser(accountId, running, user, t('weixin.keepalivePrompt'));
        if (!cont) break;
      }
    }
  }

  async sendTestMessage(accountId: string, userId: string, text: string): Promise<void> {
    const running = this.runningAccounts.get(accountId);
    if (!running) {
      throw new Error(t('weixin.accountNotRunning'));
    }
    await running.client.sendText(userId, text);
  }

  /** 给账号的（单个）已绑定用户发测试消息。 */
  async sendTestMessageToBoundUser(accountId: string, text: string): Promise<void> {
    const [user] = listAuthorizedWeixinUsersByAccount(accountId);
    if (!user) {
      throw new Error(t('weixin.userNotFound'));
    }
    await this.sendTestMessage(accountId, user.userId, text);
  }

  /** 启动扫码登录：取二维码后立即返回，确认/失败在后台推进 loginSession 状态。 */
  async startLogin(accountId: string): Promise<StartWeixinLoginResponse> {
    const account = getWeixinAccountById(accountId);
    if (!account) {
      throw new Error(t('weixin.accountNotFound'));
    }

    const prev = this.loginSessions.get(accountId);
    if (prev) {
      prev.abort.abort();
      this.loginSessions.delete(accountId);
    }

    const abort = new AbortController();
    const client = this.createClient({});

    return await new Promise<StartWeixinLoginResponse>((resolve, reject) => {
      let resolved = false;

      const loginPromise = client.login({
        signal: abort.signal,
        onQrcode: (qr) => {
          this.loginSessions.set(accountId, {
            status: 'pending',
            qrcodeUrl: qr.url,
            qrcodeId: qr.qrcodeId,
            client,
            abort,
          });
          if (!resolved) {
            resolved = true;
            resolve({ qrcodeUrl: qr.url, qrcodeId: qr.qrcodeId });
          }
        },
      });

      loginPromise
        .then(async (creds) => {
          await this.persistLogin(accountId, creds);
          const session = this.loginSessions.get(accountId);
          if (session) {
            session.status = 'confirmed';
          }
          await this.refresh();
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          const status: WeixinLoginStatus = /expired|timed out/i.test(message)
            ? 'expired'
            : 'error';
          const session = this.loginSessions.get(accountId);
          if (session) {
            session.status = status;
            session.message = message;
          } else {
            this.loginSessions.set(accountId, {
              status,
              message,
              qrcodeUrl: '',
              qrcodeId: '',
              client,
              abort,
            });
          }
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
    });
  }

  getLoginStatus(accountId: string): WeixinLoginStatusResponse {
    const account = getWeixinAccountById(accountId);
    const loggedIn = account?.botTokenEnc != null;
    const session = this.loginSessions.get(accountId);
    if (!session) {
      return { status: loggedIn ? 'confirmed' : 'pending', loggedIn };
    }
    return { status: session.status, loggedIn, message: session.message };
  }

  private async persistLogin(accountId: string, creds: WeixinCredentials): Promise<void> {
    const botTokenEnc = await encrypt(creds.botToken);
    updateWeixinAccount(accountId, {
      weixinUin: creds.accountId,
      botTokenEnc,
      baseUrl: creds.baseUrl,
    });
    this.sessionExpiredNotified.delete(accountId);
  }

  async stopAll(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const session of this.loginSessions.values()) {
      session.abort.abort();
    }
    this.loginSessions.clear();
    const ids = Array.from(this.runningAccounts.keys());
    await Promise.all(ids.map((id) => this.stopAccount(id)));
  }
}

export const weixinService = new WeixinService();
