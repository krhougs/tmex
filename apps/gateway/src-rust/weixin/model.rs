use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::crypto::{CryptoDecryptError, CryptoError};

pub const ILINK_LOGIN_HOST: &str = "https://ilinkai.weixin.qq.com";
pub const ILINK_BOT_TYPE: u8 = 3;
pub const CHANNEL_VERSION: &str = "1.0.3";
pub const CLIENT_ID_PREFIX: &str = "openclaw-weixin-";

pub const MESSAGE_TYPE_USER: i64 = 1;
pub const MESSAGE_TYPE_BOT: i64 = 2;
pub const MESSAGE_STATE_NEW: i64 = 0;
pub const MESSAGE_STATE_GENERATING: i64 = 1;
pub const MESSAGE_STATE_FINISH: i64 = 2;
pub const ITEM_TYPE_TEXT: i64 = 1;
pub const ITEM_TYPE_IMAGE: i64 = 2;
pub const ITEM_TYPE_VOICE: i64 = 3;
pub const ITEM_TYPE_FILE: i64 = 4;
pub const ITEM_TYPE_VIDEO: i64 = 5;
pub const SESSION_EXPIRED_ERRCODE: i64 = -14;

pub const DEFAULT_LOGIN_TIMEOUT: Duration = Duration::from_secs(8 * 60);
pub const DEFAULT_QRCODE_POLL_INTERVAL: Duration = Duration::from_secs(1);
pub const MAX_QRCODE_REFRESHES: usize = 3;
pub const DEFAULT_LONGPOLL_TIMEOUT: Duration = Duration::from_secs(60);
pub const LONGPOLL_TIMEOUT_MARGIN: Duration = Duration::from_secs(10);
pub const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(2);
pub const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(8 * 60 * 60);
pub const KEEPALIVE_SWEEP_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, PartialEq, Eq)]
pub struct WeixinBotToken(String);

impl WeixinBotToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for WeixinBotToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WeixinBotToken([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WeixinBaseUrl(String);

impl WeixinBaseUrl {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for WeixinBaseUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WeixinBaseUrl([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WeixinCredentials {
    pub account_id: String,
    pub bot_token: WeixinBotToken,
    pub base_url: WeixinBaseUrl,
}

impl fmt::Debug for WeixinCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WeixinCredentials")
            .field("account_id", &self.account_id)
            .field("bot_token", &"[REDACTED]")
            .field("base_url", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BaseInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_version: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct TextItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct MessageItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_completed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_item: Option<TextItem>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct WeixinMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_type: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_state: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_list: Option<Vec<MessageItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_token: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
pub struct GetBotQrcodeResponse {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub qrcode: Option<String>,
    #[serde(default)]
    pub qrcode_img_content: Option<String>,
}

impl fmt::Debug for GetBotQrcodeResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GetBotQrcodeResponse")
            .field("ret", &self.ret)
            .field("errcode", &self.errcode)
            .field("errmsg", &self.errmsg.as_ref().map(|_| "[REDACTED]"))
            .field("qrcode", &self.qrcode.as_ref().map(|_| "[REDACTED]"))
            .field(
                "qrcode_img_content",
                &self.qrcode_img_content.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QrcodeStatus {
    Wait,
    Scaned,
    Confirmed,
    Expired,
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
pub struct GetQrcodeStatusResponse {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub status: Option<QrcodeStatus>,
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub ilink_bot_id: Option<String>,
    #[serde(default)]
    pub baseurl: Option<String>,
    #[serde(default)]
    pub ilink_user_id: Option<String>,
}

impl fmt::Debug for GetQrcodeStatusResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GetQrcodeStatusResponse")
            .field("ret", &self.ret)
            .field("errcode", &self.errcode)
            .field("errmsg", &self.errmsg.as_ref().map(|_| "[REDACTED]"))
            .field("status", &self.status)
            .field("bot_token", &self.bot_token.as_ref().map(|_| "[REDACTED]"))
            .field("ilink_bot_id", &self.ilink_bot_id)
            .field("baseurl", &self.baseurl.as_ref().map(|_| "[REDACTED]"))
            .field("ilink_user_id", &self.ilink_user_id)
            .finish()
    }
}

#[derive(Clone, Default, Deserialize, PartialEq)]
pub struct GetUpdatesResponse {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub msgs: Option<Vec<WeixinMessage>>,
    #[serde(default)]
    pub get_updates_buf: Option<String>,
    #[serde(default)]
    pub longpolling_timeout_ms: Option<i64>,
}

impl fmt::Debug for GetUpdatesResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GetUpdatesResponse")
            .field("ret", &self.ret)
            .field("errcode", &self.errcode)
            .field("errmsg", &self.errmsg.as_ref().map(|_| "[REDACTED]"))
            .field("msgs", &self.msgs.as_ref().map(Vec::len))
            .field(
                "get_updates_buf",
                &self.get_updates_buf.as_ref().map(|_| "[REDACTED]"),
            )
            .field("longpolling_timeout_ms", &self.longpolling_timeout_ms)
            .finish()
    }
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
pub struct SendMessageResponse {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
}

impl fmt::Debug for SendMessageResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SendMessageResponse")
            .field("ret", &self.ret)
            .field("errcode", &self.errcode)
            .field("errmsg", &self.errmsg.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct GetUpdatesRequest {
    pub credentials: WeixinCredentials,
    pub get_updates_buf: String,
}

impl fmt::Debug for GetUpdatesRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GetUpdatesRequest")
            .field("credentials", &self.credentials)
            .field("get_updates_buf", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SendTextRequest {
    pub credentials: WeixinCredentials,
    pub to_user_id: String,
    pub context_token: String,
    pub client_id: String,
    pub items: Vec<String>,
}

impl fmt::Debug for SendTextRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SendTextRequest")
            .field("credentials", &self.credentials)
            .field("to_user_id", &self.to_user_id)
            .field("context_token", &"[REDACTED]")
            .field("client_id", &self.client_id)
            .field("items", &self.items)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WeixinInboundMessage {
    pub from_user_id: String,
    pub context_token: Option<String>,
    pub text: String,
    pub raw: WeixinMessage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeixinQrcode {
    pub url: String,
    pub qrcode_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WeixinLoginStatus {
    Pending,
    Confirmed,
    Expired,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWeixinLoginResponse {
    pub qrcode_url: String,
    pub qrcode_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeixinLoginStatusResponse {
    pub status: WeixinLoginStatus,
    pub logged_in: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WeixinTransportError {
    #[error("iLink request could not be constructed")]
    InvalidRequest,
    #[error("iLink network request failed")]
    Network,
    #[error("iLink HTTP {status} {reason}{details}", details = http_details(.excerpt))]
    HttpStatus {
        status: u16,
        reason: String,
        excerpt: String,
    },
    #[error("iLink returned invalid JSON")]
    InvalidResponse,
}

fn http_details(excerpt: &str) -> String {
    if excerpt.is_empty() {
        String::new()
    } else {
        format!(": {excerpt}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WeixinClientError {
    #[error(transparent)]
    Transport(#[from] WeixinTransportError),
    #[error("Weixin client operation was cancelled")]
    Cancelled,
    #[error("iLink login timed out")]
    LoginTimedOut,
    #[error("iLink qrcode expired and refresh limit reached")]
    QrcodeRefreshLimit,
    #[error("iLink get_bot_qrcode returned no qrcode")]
    MissingQrcode,
    #[error("iLink get_bot_qrcode returned no qrcode content")]
    MissingQrcodeContent,
    #[error("iLink login confirmed but bot_token/baseurl missing")]
    MissingConfirmedCredentials,
    #[error("Weixin client has no credentials; login first")]
    MissingCredentials,
    #[error("Weixin client is already polling")]
    AlreadyRunning,
    #[error("No context_token for user {user_id}. Receive a message from them first.")]
    NoContextToken { user_id: String },
    #[error("iLink bot session expired; re-login required")]
    SessionExpired,
    #[error("{endpoint} ret={ret} errmsg={message}")]
    Business {
        endpoint: &'static str,
        ret: i64,
        message: String,
    },
    #[error("Weixin client callback failed")]
    Callback,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Weixin storage operation failed during {operation}")]
pub struct WeixinStoreError {
    pub operation: &'static str,
}

impl WeixinStoreError {
    pub const fn new(operation: &'static str) -> Self {
        Self { operation }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WeixinServiceError {
    #[error(transparent)]
    Decrypt(#[from] CryptoDecryptError),
    #[error(transparent)]
    Encrypt(#[from] CryptoError),
    #[error(transparent)]
    Store(#[from] WeixinStoreError),
    #[error(transparent)]
    Client(#[from] WeixinClientError),
    #[error("Weixin account {account_id} was not found")]
    AccountNotFound { account_id: String },
    #[error("Weixin account {account_id} is not running: {message}")]
    AccountNotRunning { account_id: String, message: String },
    #[error("Weixin account {account_id} has no authorized user: {message}")]
    UserNotFound { account_id: String, message: String },
    #[error("Weixin login ended before a qrcode was available")]
    LoginUnavailable,
    #[error("Weixin service is stopping")]
    ServiceStopping,
}

pub(crate) fn redact_known_secrets(value: &str, secrets: &[&str]) -> String {
    secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .fold(value.to_owned(), |redacted, secret| {
            redacted.replace(secret, "[REDACTED]")
        })
}

pub(crate) fn truncate_utf16_units(value: &str, max_units: usize) -> String {
    let units = value.encode_utf16().take(max_units).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}
