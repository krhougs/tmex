use async_trait::async_trait;
use bytes::Bytes;
use chrono::{Datelike, Local, SecondsFormat, Timelike, Utc};
use http::{Method, Request, StatusCode};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use uuid::Uuid;

use crate::database::repository::{TelegramBotStats, TelegramBotUpdate};
use crate::entity::{telegram_bot_chats, telegram_bots};
use crate::telegram::{TelegramService, TelegramServiceError};

use super::dto::SettingsNamespace;
use super::handler::HttpHandler;
use super::response::{error_json, json, HandlerError, HandlerResult, HttpResponse};

#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("Telegram service operation failed")]
pub struct TelegramHttpError;

#[async_trait]
pub trait TelegramHttpService: Send + Sync {
    async fn refresh(&self) -> Result<(), TelegramHttpError>;

    async fn send_test_message(
        &self,
        bot_id: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<(), TelegramHttpError>;
}

#[async_trait]
impl TelegramHttpService for TelegramService {
    async fn refresh(&self) -> Result<(), TelegramHttpError> {
        TelegramService::refresh(self)
            .await
            .map_err(redact_service_error)
    }

    async fn send_test_message(
        &self,
        bot_id: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<(), TelegramHttpError> {
        TelegramService::send_test_message(self, bot_id, chat_id, text)
            .await
            .map_err(redact_service_error)
    }
}

fn redact_service_error(_: TelegramServiceError) -> TelegramHttpError {
    TelegramHttpError
}

pub async fn handle_telegram_request(
    handler: &HttpHandler,
    request: &Request<Bytes>,
) -> Result<Option<HttpResponse>, HandlerError> {
    let method = request.method();
    let path = request.uri().path();

    if path == "/api/settings/telegram/bots" && method == Method::GET {
        return Ok(Some(handle_list_bots(handler).await?));
    }
    if path == "/api/settings/telegram/bots" && method == Method::POST {
        return Ok(Some(handle_create_bot(handler, request).await?));
    }

    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["api", "settings", "telegram", "bots", bot_id] if method == Method::PATCH => {
            Ok(Some(handle_update_bot(handler, request, bot_id).await?))
        }
        ["api", "settings", "telegram", "bots", bot_id] if method == Method::DELETE => {
            Ok(Some(handle_delete_bot(handler, bot_id).await?))
        }
        ["api", "settings", "telegram", "bots", bot_id, "chats"] if method == Method::GET => {
            Ok(Some(handle_list_chats(handler, bot_id).await?))
        }
        ["api", "settings", "telegram", "bots", bot_id, "chats", chat_id, "approve"]
            if method == Method::POST =>
        {
            let chat_id = decode_chat_id(handler, chat_id)?;
            Ok(Some(handle_approve_chat(handler, bot_id, &chat_id).await?))
        }
        ["api", "settings", "telegram", "bots", bot_id, "chats", chat_id, "test"]
            if method == Method::POST =>
        {
            let chat_id = decode_chat_id(handler, chat_id)?;
            Ok(Some(handle_test_chat(handler, bot_id, &chat_id).await?))
        }
        ["api", "settings", "telegram", "bots", bot_id, "chats", chat_id]
            if method == Method::DELETE =>
        {
            let chat_id = decode_chat_id(handler, chat_id)?;
            Ok(Some(handle_delete_chat(handler, bot_id, &chat_id).await?))
        }
        _ => Ok(None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramBotDto {
    id: String,
    name: String,
    enabled: bool,
    allow_auth_requests: bool,
    created_at: String,
    updated_at: String,
    pending_count: u64,
    authorized_count: u64,
}

impl From<TelegramBotStats> for TelegramBotDto {
    fn from(bot: TelegramBotStats) -> Self {
        Self {
            id: bot.id,
            name: bot.name,
            enabled: bot.enabled,
            allow_auth_requests: bot.allow_auth_requests,
            created_at: bot.created_at,
            updated_at: bot.updated_at,
            pending_count: bot.pending_count,
            authorized_count: bot.authorized_count,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramChatDto {
    id: String,
    bot_id: String,
    chat_id: String,
    chat_type: String,
    display_name: String,
    status: String,
    applied_at: String,
    authorized_at: Option<String>,
    updated_at: String,
}

impl From<telegram_bot_chats::Model> for TelegramChatDto {
    fn from(chat: telegram_bot_chats::Model) -> Self {
        Self {
            id: chat.id,
            bot_id: chat.bot_id,
            chat_id: chat.chat_id,
            chat_type: chat.chat_type,
            display_name: chat.display_name,
            status: chat.status,
            applied_at: chat.applied_at,
            authorized_at: chat.authorized_at,
            updated_at: chat.updated_at,
        }
    }
}

async fn handle_list_bots(handler: &HttpHandler) -> HandlerResult {
    let bots = handler
        .repository
        .get_telegram_bots_with_stats()
        .await?
        .into_iter()
        .map(TelegramBotDto::from)
        .collect::<Vec<_>>();
    Ok(json(StatusCode::OK, &serde_json::json!({ "bots": bots })))
}

async fn handle_create_bot(handler: &HttpHandler, request: &Request<Bytes>) -> HandlerResult {
    let body = body_object(handler, request)?;
    let name = required_trimmed_string(handler, &body, "name", "apiError.botNameRequired")?;
    let token = required_trimmed_string(handler, &body, "token", "apiError.botTokenRequired")?;
    let enabled = nullable_bool(handler, &body, "enabled")?.unwrap_or(true);
    let allow_auth_requests = nullable_bool(handler, &body, "allowAuthRequests")?.unwrap_or(true);
    let Some(service) = handler.telegram_service.as_ref() else {
        return Ok(service_unavailable());
    };

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    handler
        .repository
        .create_telegram_bot(telegram_bots::Model {
            id,
            name,
            token_enc: handler.master_key.encrypt(&token)?,
            enabled: i64::from(enabled),
            allow_auth_requests: i64::from(allow_auth_requests),
            last_update_id: None,
            created_at: now.clone(),
            updated_at: now,
        })
        .await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Telegram)
        .await?;
    if service.refresh().await.is_err() {
        return Ok(service_failed());
    }
    Ok(json(
        StatusCode::CREATED,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_update_bot(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    bot_id: &str,
) -> HandlerResult {
    if handler
        .repository
        .get_telegram_bot_by_id(bot_id)
        .await?
        .is_none()
    {
        return Ok(bot_not_found(handler));
    }
    let body = body_object(handler, request)?;
    let Some(service) = handler.telegram_service.as_ref() else {
        return Ok(service_unavailable());
    };
    let name = optional_trimmed_string(handler, &body, "name", "apiError.botNameRequired")?;
    let token = optional_trimmed_string(handler, &body, "token", "apiError.botTokenRequired")?
        .map(|token| handler.master_key.encrypt(&token))
        .transpose()?;
    let enabled = optional_bool(handler, &body, "enabled")?;
    let allow_auth_requests = optional_bool(handler, &body, "allowAuthRequests")?;

    handler
        .repository
        .update_telegram_bot(
            bot_id,
            TelegramBotUpdate {
                name,
                token_enc: token,
                enabled,
                allow_auth_requests,
                ..TelegramBotUpdate::default()
            },
        )
        .await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Telegram)
        .await?;
    if service.refresh().await.is_err() {
        return Ok(service_failed());
    }
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_delete_bot(handler: &HttpHandler, bot_id: &str) -> HandlerResult {
    if handler
        .repository
        .get_telegram_bot_by_id(bot_id)
        .await?
        .is_none()
    {
        return Ok(bot_not_found(handler));
    }
    let Some(service) = handler.telegram_service.as_ref() else {
        return Ok(service_unavailable());
    };

    handler.repository.delete_telegram_bot(bot_id).await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Telegram)
        .await?;
    if service.refresh().await.is_err() {
        return Ok(service_failed());
    }
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_list_chats(handler: &HttpHandler, bot_id: &str) -> HandlerResult {
    if handler
        .repository
        .get_telegram_bot_by_id(bot_id)
        .await?
        .is_none()
    {
        return Ok(bot_not_found(handler));
    }
    let chats = handler
        .repository
        .list_telegram_chats_by_bot(bot_id)
        .await?
        .into_iter()
        .map(TelegramChatDto::from)
        .collect::<Vec<_>>();
    Ok(json(StatusCode::OK, &serde_json::json!({ "chats": chats })))
}

async fn handle_approve_chat(handler: &HttpHandler, bot_id: &str, chat_id: &str) -> HandlerResult {
    let Some(bot) = handler.repository.get_telegram_bot_by_id(bot_id).await? else {
        return Ok(bot_not_found(handler));
    };
    let Some(service) = handler.telegram_service.as_ref() else {
        return Ok(service_unavailable());
    };
    let Some(chat) = handler
        .repository
        .approve_telegram_chat(bot_id, chat_id)
        .await?
    else {
        return Ok(chat_not_found(handler));
    };
    handler
        .runtime
        .settings_changed(SettingsNamespace::Telegram)
        .await?;
    let settings = handler
        .repository
        .get_site_settings(&handler.site_defaults())
        .await?;
    let time = localized_now(&settings.language);
    let message = translate_with(
        handler,
        "telegram.approveMessageTemplate",
        &[("botName", &bot.name), ("time", &time)],
    );
    if service
        .send_test_message(bot_id, chat_id, &message)
        .await
        .is_err()
    {
        return Ok(service_failed());
    }
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "chat": TelegramChatDto::from(chat) }),
    ))
}

async fn handle_delete_chat(handler: &HttpHandler, bot_id: &str, chat_id: &str) -> HandlerResult {
    if handler
        .repository
        .get_telegram_bot_by_id(bot_id)
        .await?
        .is_none()
    {
        return Ok(bot_not_found(handler));
    }
    handler
        .repository
        .delete_telegram_chat(bot_id, chat_id)
        .await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Telegram)
        .await?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_test_chat(handler: &HttpHandler, bot_id: &str, chat_id: &str) -> HandlerResult {
    if handler
        .repository
        .get_telegram_bot_by_id(bot_id)
        .await?
        .is_none()
    {
        return Ok(bot_not_found(handler));
    }
    let Some(service) = handler.telegram_service.as_ref() else {
        return Ok(service_unavailable());
    };
    let settings = handler
        .repository
        .get_site_settings(&handler.site_defaults())
        .await?;
    let time = localized_now(&settings.language);
    let message = translate_with(
        handler,
        "telegram.testMessageTemplate",
        &[("siteName", &settings.site_name), ("time", &time)],
    );
    if service
        .send_test_message(bot_id, chat_id, &message)
        .await
        .is_err()
    {
        return Ok(service_failed());
    }
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

fn body_object(
    handler: &HttpHandler,
    request: &Request<Bytes>,
) -> Result<JsonMap<String, JsonValue>, HandlerError> {
    match serde_json::from_slice::<JsonValue>(request.body()) {
        Ok(JsonValue::Object(body)) => Ok(body),
        _ => Err(invalid(handler, "apiError.invalidRequest")),
    }
}

fn required_trimmed_string(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
    field: &str,
    error_key: &'static str,
) -> Result<String, HandlerError> {
    let Some(value) = body.get(field).filter(|value| !value.is_null()) else {
        return Err(invalid(handler, error_key));
    };
    let Some(value) = value.as_str() else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(handler, error_key));
    }
    Ok(value.to_owned())
}

fn optional_trimmed_string(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
    field: &str,
    error_key: &'static str,
) -> Result<Option<String>, HandlerError> {
    let Some(value) = body.get(field) else {
        return Ok(None);
    };
    let Some(value) = value.as_str() else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(handler, error_key));
    }
    Ok(Some(value.to_owned()))
}

fn nullable_bool(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
    field: &str,
) -> Result<Option<bool>, HandlerError> {
    match body.get(field) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid(handler, "apiError.invalidRequest")),
    }
}

fn optional_bool(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
    field: &str,
) -> Result<Option<bool>, HandlerError> {
    match body.get(field) {
        None => Ok(None),
        Some(JsonValue::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid(handler, "apiError.invalidRequest")),
    }
}

fn decode_chat_id(handler: &HttpHandler, value: &str) -> Result<String, HandlerError> {
    if !valid_percent_encoding(value) {
        return Err(invalid(handler, "apiError.invalidRequest"));
    }
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| invalid(handler, "apiError.invalidRequest"))
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn invalid(handler: &HttpHandler, key: &'static str) -> HandlerError {
    HandlerError::InvalidRequest(handler.translate(key))
}

fn bot_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("apiError.botNotFound"),
    )
}

fn chat_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("apiError.chatNotFound"),
    )
}

fn service_unavailable() -> HttpResponse {
    error_json(
        StatusCode::INTERNAL_SERVER_ERROR,
        "telegram service is unavailable",
    )
}

fn service_failed() -> HttpResponse {
    error_json(
        StatusCode::INTERNAL_SERVER_ERROR,
        "telegram service operation failed",
    )
}

fn translate_with(handler: &HttpHandler, key: &'static str, values: &[(&str, &str)]) -> String {
    let mut translated = handler.translate(key);
    for (name, value) in values {
        translated = translated.replace(&format!("{{{{{name}}}}}"), value);
    }
    translated
}

fn localized_now(language: &str) -> String {
    let now = Local::now();
    if language == "zh_CN" {
        return format!(
            "{}/{}/{} {:02}:{:02}:{:02}",
            now.year(),
            now.month(),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
    }
    if language == "ja_JP" {
        return format!(
            "{}/{}/{} {}:{:02}:{:02}",
            now.year(),
            now.month(),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
    }
    let hour = now.hour();
    let (hour, period) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!(
        "{}/{}/{}, {}:{:02}:{:02} {}",
        now.month(),
        now.day(),
        now.year(),
        hour,
        now.minute(),
        now.second(),
        period
    )
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
