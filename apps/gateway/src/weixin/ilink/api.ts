// iLink bot 协议的 4 个端点低层 HTTP 函数。
// 全部支持注入 fetchImpl 以便测试；默认走 globalThis.fetch。

import {
  CHANNEL_VERSION,
  type GetBotQrcodeResp,
  type GetQrcodeStatusResp,
  type GetUpdatesResp,
  ILINK_BOT_TYPE,
  ILINK_LOGIN_HOST,
  ITEM_TYPE_TEXT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
  type MessageItem,
  type SendMessageReq,
  type SendMessageResp,
} from './types';

export type FetchImpl = typeof fetch;

interface BaseRequestOpts {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

function resolveFetch(fetchImpl?: FetchImpl): FetchImpl {
  return fetchImpl ?? globalThis.fetch;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// 每请求重新生成：random uint32 → 十进制字符串 → base64
export function generateWechatUin(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const decimal = String(buf[0]);
  return Buffer.from(decimal, 'utf8').toString('base64');
}

export function buildAuthHeaders(botToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': generateWechatUin(),
  };
  const token = botToken?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

async function readJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    // iLink 的业务错误（如 session 过期 -14）走 HTTP 200 + body 内 ret/errcode；
    // 非 2xx 一律是传输/反代层故障，抛带 status 的错误，让上层走 backoff / 标记需重激活，
    // 避免空 body 被当成「成功空响应」而热循环空转或误判发送成功。
    const body = await resp.text().catch(() => '');
    throw new Error(
      `iLink HTTP ${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }
  const text = await resp.text();
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

// ---- get_bot_qrcode ----
export interface GetBotQrcodeOpts extends BaseRequestOpts {
  host?: string;
  botType?: number;
}

export async function getBotQrcode(opts: GetBotQrcodeOpts = {}): Promise<GetBotQrcodeResp> {
  const host = trimTrailingSlash(opts.host ?? ILINK_LOGIN_HOST);
  const botType = opts.botType ?? ILINK_BOT_TYPE;
  const url = `${host}/ilink/bot/get_bot_qrcode?bot_type=${botType}`;
  const resp = await resolveFetch(opts.fetchImpl)(url, {
    method: 'GET',
    headers: buildAuthHeaders(),
    signal: opts.signal,
  });
  return readJson<GetBotQrcodeResp>(resp);
}

// ---- get_qrcode_status ----
export interface GetQrcodeStatusOpts extends BaseRequestOpts {
  host?: string;
}

export async function getQrcodeStatus(
  qrcode: string,
  opts: GetQrcodeStatusOpts = {}
): Promise<GetQrcodeStatusResp> {
  const host = trimTrailingSlash(opts.host ?? ILINK_LOGIN_HOST);
  const url = `${host}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const resp = await resolveFetch(opts.fetchImpl)(url, {
    method: 'GET',
    headers: buildAuthHeaders(),
    signal: opts.signal,
  });
  return readJson<GetQrcodeStatusResp>(resp);
}

// ---- getupdates ----
export interface GetUpdatesOpts extends BaseRequestOpts {
  baseUrl: string;
  botToken: string;
  getUpdatesBuf?: string;
}

export async function getUpdates(opts: GetUpdatesOpts): Promise<GetUpdatesResp> {
  const baseUrl = trimTrailingSlash(opts.baseUrl);
  const url = `${baseUrl}/ilink/bot/getupdates`;
  const body = {
    get_updates_buf: opts.getUpdatesBuf ?? '',
    base_info: buildBaseInfo(),
  };
  const resp = await resolveFetch(opts.fetchImpl)(url, {
    method: 'POST',
    headers: buildAuthHeaders(opts.botToken),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  return readJson<GetUpdatesResp>(resp);
}

// ---- sendmessage ----
export interface SendTextItemInput {
  text: string;
}

export interface SendMessageOpts extends BaseRequestOpts {
  baseUrl: string;
  botToken: string;
  toUserId: string;
  contextToken: string;
  clientId: string;
  items: SendTextItemInput[];
}

export async function sendMessage(opts: SendMessageOpts): Promise<SendMessageResp> {
  const baseUrl = trimTrailingSlash(opts.baseUrl);
  const url = `${baseUrl}/ilink/bot/sendmessage`;
  const itemList: MessageItem[] = opts.items.map((item) => ({
    type: ITEM_TYPE_TEXT,
    text_item: { text: item.text },
  }));
  const req: SendMessageReq = {
    msg: {
      to_user_id: opts.toUserId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: opts.contextToken,
      client_id: opts.clientId,
      item_list: itemList,
    },
    base_info: buildBaseInfo(),
  };
  const resp = await resolveFetch(opts.fetchImpl)(url, {
    method: 'POST',
    headers: buildAuthHeaders(opts.botToken),
    body: JSON.stringify(req),
    signal: opts.signal,
  });
  return readJson<SendMessageResp>(resp);
}
