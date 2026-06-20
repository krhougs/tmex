// 腾讯 iLink bot 协议的线上 wire 类型与对外领域类型。
// 字段名严格对齐真实协议（reverse-engineered，见 openclaw-weixin / wechat-ilink-client）。

export const ILINK_LOGIN_HOST = 'https://ilinkai.weixin.qq.com';
export const ILINK_BOT_TYPE = 3;
export const CHANNEL_VERSION = '1.0.3';
export const CLIENT_ID_PREFIX = 'openclaw-weixin-';

// message_type
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

// message_state
export const MESSAGE_STATE_NEW = 0;
export const MESSAGE_STATE_GENERATING = 1;
export const MESSAGE_STATE_FINISH = 2;

// item_list[].type
export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;

// session 过期：ret 或 errcode 为 -14
export const SESSION_EXPIRED_ERRCODE = -14;

export interface BaseInfo {
  channel_version?: string;
}

export interface TextItem {
  text?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  [key: string]: unknown;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

// ---- 端点：get_bot_qrcode ----
export interface GetBotQrcodeResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

// ---- 端点：get_qrcode_status ----
export type QrcodeStatus = 'wait' | 'scaned' | 'confirmed' | 'expired';

export interface GetQrcodeStatusResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  status?: QrcodeStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// ---- 端点：getupdates ----
export interface GetUpdatesReq {
  get_updates_buf?: string;
  base_info?: BaseInfo;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ---- 端点：sendmessage ----
export interface SendMessageReq {
  msg?: WeixinMessage;
  base_info?: BaseInfo;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

// ---- 对外领域类型 ----
export interface WeixinCredentials {
  accountId: string;
  botToken: string;
  baseUrl: string;
}

export interface WeixinInboundMessage {
  fromUserId: string;
  contextToken: string | null;
  text: string;
  raw: unknown;
}
