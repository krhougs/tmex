use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::crypto::CryptoDecryptError;

pub const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: u32 = 30;
pub const TELEGRAM_POLL_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone, PartialEq, Eq)]
pub struct TelegramBotToken(String);

impl TelegramBotToken {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TelegramBotToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TelegramBotToken([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelegramParseMode {
    Html,
    MarkdownV2,
}

impl TelegramParseMode {
    pub const fn as_api_value(self) -> &'static str {
        match self {
            Self::Html => "HTML",
            Self::MarkdownV2 => "MarkdownV2",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelegramOutgoingMessage {
    pub text: String,
    pub parse_mode: Option<TelegramParseMode>,
}

impl TelegramOutgoingMessage {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            parse_mode: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelegramGetUpdatesRequest {
    pub offset: Option<i64>,
    pub timeout_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelegramSendMessageRequest {
    pub chat_id: String,
    pub text: String,
    pub parse_mode: Option<TelegramParseMode>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct TelegramUpdate {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<TelegramIncomingMessage>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct TelegramIncomingMessage {
    #[serde(default)]
    pub text: Option<String>,
    pub chat: TelegramChat,
    #[serde(default, rename = "from")]
    pub sender: Option<TelegramUser>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct TelegramChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct TelegramUser {
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TelegramGetUpdatesBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    pub timeout: u32,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TelegramSendMessageBody<'a> {
    pub chat_id: &'a str,
    pub text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TelegramTransportError {
    #[error("Telegram network request failed")]
    Network,
    #[error("Telegram API returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("Telegram API returned an invalid response")]
    InvalidResponse,
    #[error("Telegram API rejected the request")]
    ApiRejected,
}

#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TelegramStoreError {
    message: String,
}

impl TelegramStoreError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Debug for TelegramStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TelegramStoreError")
            .field("message", &self.message)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TelegramServiceError {
    #[error(transparent)]
    Crypto(#[from] CryptoDecryptError),
    #[error("Telegram storage operation failed: {0}")]
    Store(#[from] TelegramStoreError),
    #[error("Telegram bot {bot_id} is not running: {message}")]
    BotNotRunning { bot_id: String, message: String },
    #[error("Telegram bot {bot_id} failed to start: {source}")]
    Start {
        bot_id: String,
        #[source]
        source: TelegramTransportError,
    },
    #[error("Telegram send failed for bot={bot_id} chat={chat_id}: {source}")]
    Send {
        bot_id: String,
        chat_id: String,
        #[source]
        source: TelegramTransportError,
    },
}
