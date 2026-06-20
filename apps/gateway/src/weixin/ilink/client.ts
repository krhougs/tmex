// WeixinClient：iLink bot 协议的高层客户端。
// 负责登录（扫码）、长轮询收消息、context_token 缓存、发送文本。

import { type FetchImpl, getBotQrcode, getQrcodeStatus, getUpdates, sendMessage } from './api';
import {
  CLIENT_ID_PREFIX,
  type GetQrcodeStatusResp,
  type GetUpdatesResp,
  ITEM_TYPE_TEXT,
  SESSION_EXPIRED_ERRCODE,
  type WeixinCredentials,
  type WeixinInboundMessage,
  type WeixinMessage,
} from './types';

export class WeixinNoContextTokenError extends Error {
  constructor(toUserId: string) {
    super(`No context_token for user ${toUserId}. Receive a message from them first.`);
    this.name = 'WeixinNoContextTokenError';
  }
}

export class WeixinSessionExpiredError extends Error {
  constructor() {
    super('iLink bot session expired; re-login required.');
    this.name = 'WeixinSessionExpiredError';
  }
}

export interface WeixinClientOptions extends Partial<WeixinCredentials> {
  fetchImpl?: FetchImpl;
}

export interface WeixinStartOptions {
  signal?: AbortSignal;
  loadSyncBuf?: () => string | undefined | Promise<string | undefined>;
  saveSyncBuf?: (buf: string) => void | Promise<void>;
  initialContextTokens?: Record<string, string>;
  onMessage?: (msg: WeixinInboundMessage) => void | Promise<void>;
  onSessionExpired?: () => void;
  onError?: (err: unknown) => void;
  /** 长轮询 per-request 超时初值（毫秒）；省略用默认 60s，之后按服务端 longpolling_timeout_ms 调整。 */
  longpollTimeoutMs?: number;
}

export interface WeixinLoginOptions {
  onQrcode: (qr: { url: string; qrcodeId: string }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
const DEFAULT_QRCODE_POLL_INTERVAL_MS = 1_000;
const MAX_QRCODE_REFRESH = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
// 长轮询 per-request 超时：首请求用默认值（> 典型 35s 服务端窗口），之后按服务端
// longpolling_timeout_ms + margin 动态调整；超时按一次失败处理走 backoff 重连，
// 避免 TCP 黑洞导致 await getUpdates 永久挂起、整个账号静默失联。
const DEFAULT_LONGPOLL_TIMEOUT_MS = 60_000;
const LONGPOLL_TIMEOUT_MARGIN_MS = 10_000;

function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${CLIENT_ID_PREFIX}${hex}`;
}

class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

// 可被 AbortSignal 中断的 sleep。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof AbortError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function isSessionExpired(resp: GetUpdatesResp): boolean {
  return resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE;
}

export class WeixinClient {
  private creds: WeixinCredentials | null = null;
  private readonly fetchImpl?: FetchImpl;
  private readonly contextTokens = new Map<string, string>();
  private running = false;
  private internalAbort: AbortController | null = null;

  constructor(opts: WeixinClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl;
    if (opts.accountId && opts.botToken && opts.baseUrl) {
      this.creds = {
        accountId: opts.accountId,
        botToken: opts.botToken,
        baseUrl: opts.baseUrl,
      };
    }
  }

  get credentials(): WeixinCredentials | null {
    return this.creds;
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token);
  }

  isRunning(): boolean {
    return this.running;
  }

  static extractText(raw: unknown): string {
    const msg = raw as WeixinMessage | null | undefined;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.item_list)) {
      return '';
    }
    const parts: string[] = [];
    for (const item of msg.item_list) {
      if (item?.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === 'string') {
        parts.push(item.text_item.text);
      }
    }
    return parts.join('');
  }

  async login(opts: WeixinLoginOptions): Promise<WeixinCredentials> {
    const { onQrcode, signal } = opts;
    const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_QRCODE_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    let qrcodeId = await this.fetchQrcode(onQrcode, signal);
    let refreshes = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AbortError();
      await sleep(pollIntervalMs, signal);

      let status: GetQrcodeStatusResp;
      try {
        status = await getQrcodeStatus(qrcodeId, {
          fetchImpl: this.fetchImpl,
          signal,
        });
      } catch (err) {
        // 用户取消 / stop 才中止；扫码窗口长达数分钟，单次网络抖动 / 5xx 不应判负，
        // 等下一拍重试，直到 deadline 才超时退出。
        if (isAbort(err, signal)) throw err;
        continue;
      }

      switch (status.status) {
        case 'confirmed': {
          if (!status.bot_token || !status.baseurl) {
            throw new Error('iLink login confirmed but bot_token/baseurl missing.');
          }
          const accountId = status.ilink_bot_id ?? status.ilink_user_id ?? status.bot_token;
          this.creds = {
            accountId,
            botToken: status.bot_token,
            baseUrl: status.baseurl,
          };
          return this.creds;
        }
        case 'expired': {
          if (refreshes >= MAX_QRCODE_REFRESH) {
            throw new Error('iLink qrcode expired and refresh limit reached.');
          }
          refreshes += 1;
          qrcodeId = await this.fetchQrcode(onQrcode, signal);
          break;
        }
        // 'wait' / 'scaned' / undefined：继续轮询
        default:
          break;
      }
    }

    throw new Error('iLink login timed out.');
  }

  private async fetchQrcode(
    onQrcode: WeixinLoginOptions['onQrcode'],
    signal?: AbortSignal
  ): Promise<string> {
    const resp = await getBotQrcode({ fetchImpl: this.fetchImpl, signal });
    if (!resp.qrcode) {
      throw new Error('iLink get_bot_qrcode returned no qrcode.');
    }
    if (!resp.qrcode_img_content) {
      // qrcode_img_content 实为二维码要编码的 URL（非图片本身），前端据此生成二维码；
      // 缺失则 fail-loud，不回退到 qrcode（那是轮询 ID）。
      throw new Error('iLink get_bot_qrcode returned no qrcode content.');
    }
    onQrcode({
      url: resp.qrcode_img_content,
      qrcodeId: resp.qrcode,
    });
    return resp.qrcode;
  }

  async start(opts: WeixinStartOptions = {}): Promise<void> {
    if (!this.creds) {
      throw new Error('WeixinClient.start called without credentials; login first.');
    }
    if (this.running) {
      throw new Error('WeixinClient already running.');
    }

    if (opts.initialContextTokens) {
      for (const [userId, token] of Object.entries(opts.initialContextTokens)) {
        this.contextTokens.set(userId, token);
      }
    }

    this.internalAbort = new AbortController();
    const signal = this.linkSignals(opts.signal, this.internalAbort.signal);
    this.running = true;

    let getUpdatesBuf = (await opts.loadSyncBuf?.()) ?? '';
    let failures = 0;
    let longpollTimeoutMs = opts.longpollTimeoutMs ?? DEFAULT_LONGPOLL_TIMEOUT_MS;

    try {
      while (!signal.aborted) {
        let resp: GetUpdatesResp;
        try {
          // per-request 超时 = 服务端长轮询窗口 + margin（首请求用默认 60s）。
          // 超时只 abort 本次请求、不 abort 收信循环的 stop signal，故落入 catch 走 backoff，
          // 避免半开 / 黑洞连接让 await getUpdates 永久挂起。
          const perRequestSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(longpollTimeoutMs),
          ]);
          resp = await getUpdates({
            baseUrl: this.creds.baseUrl,
            botToken: this.creds.botToken,
            getUpdatesBuf,
            fetchImpl: this.fetchImpl,
            signal: perRequestSignal,
          });
        } catch (err) {
          // 仅当被 stop()/外部 abort 才退出；per-request 超时不会 abort 这个 stop signal，
          // 故落到 backoff 重连。
          if (signal.aborted) break;
          opts.onError?.(err);
          failures += 1;
          await this.backoffSleep(failures, signal);
          continue;
        }

        if (isSessionExpired(resp)) {
          opts.onSessionExpired?.();
          throw new WeixinSessionExpiredError();
        }

        if (typeof resp.ret === 'number' && resp.ret !== 0) {
          opts.onError?.(new Error(`getupdates ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`));
          failures += 1;
          await this.backoffSleep(failures, signal);
          continue;
        }

        failures = 0;
        if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
          longpollTimeoutMs = resp.longpolling_timeout_ms + LONGPOLL_TIMEOUT_MARGIN_MS;
        }

        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          if (signal.aborted) break;
          const inbound = this.toInbound(msg);
          if (msg.from_user_id && msg.context_token) {
            this.contextTokens.set(msg.from_user_id, msg.context_token);
          }
          try {
            await opts.onMessage?.(inbound);
          } catch (err) {
            opts.onError?.(err);
          }
        }

        if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
          getUpdatesBuf = resp.get_updates_buf;
          await opts.saveSyncBuf?.(getUpdatesBuf);
        }
      }
    } finally {
      this.running = false;
      this.internalAbort = null;
    }
  }

  stop(): void {
    this.internalAbort?.abort();
  }

  async sendText(toUserId: string, text: string, contextToken?: string): Promise<void> {
    if (!this.creds) {
      throw new Error('WeixinClient.sendText called without credentials; login first.');
    }
    const token = contextToken ?? this.contextTokens.get(toUserId);
    if (!token) {
      throw new WeixinNoContextTokenError(toUserId);
    }
    const resp = await sendMessage({
      baseUrl: this.creds.baseUrl,
      botToken: this.creds.botToken,
      toUserId,
      contextToken: token,
      clientId: generateClientId(),
      items: [{ text }],
      fetchImpl: this.fetchImpl,
    });
    if (resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE) {
      throw new WeixinSessionExpiredError();
    }
    if (typeof resp.ret === 'number' && resp.ret !== 0) {
      throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`);
    }
  }

  private toInbound(msg: WeixinMessage): WeixinInboundMessage {
    return {
      fromUserId: msg.from_user_id ?? '',
      contextToken: msg.context_token ?? null,
      text: WeixinClient.extractText(msg),
      raw: msg,
    };
  }

  private async backoffSleep(failures: number, signal: AbortSignal): Promise<void> {
    // 指数退避封顶：2s,4s,8s,16s,30s(封顶)…失败计数仅在收到有效响应后复位。
    const delay = Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1), BACKOFF_DELAY_MS);
    try {
      await sleep(delay, signal);
    } catch {
      // abort 期间被打断，交由 while 条件收尾
    }
  }

  // 把外部 signal 与内部 stop() signal 合并成一个。
  private linkSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
    if (!external) return internal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (external.aborted || internal.aborted) {
      controller.abort();
      return controller.signal;
    }
    external.addEventListener('abort', onAbort, { once: true });
    internal.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
  }
}
