use async_trait::async_trait;
use bytes::Bytes;
use chrono::{Datelike, Local, SecondsFormat, Timelike, Utc};
use http::{Method, Request, StatusCode};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use uuid::Uuid;

use crate::database::repository::{WeixinAccountStats, WeixinAccountUpdate};
use crate::entity::{weixin_account_users, weixin_accounts};
use crate::weixin::{
    StartWeixinLoginResponse, WeixinLoginStatusResponse, WeixinService, WeixinServiceError,
    WeixinServicePort,
};

use super::dto::SettingsNamespace;
use super::handler::HttpHandler;
use super::response::{error_json, json, HandlerError, HandlerResult, HttpResponse};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WeixinHttpErrorKind {
    AccountNotRunning,
    UserNotFound,
    OperationFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("Weixin service operation failed")]
pub struct WeixinHttpError {
    kind: WeixinHttpErrorKind,
}

impl WeixinHttpError {
    pub const fn operation_failed() -> Self {
        Self {
            kind: WeixinHttpErrorKind::OperationFailed,
        }
    }

    fn from_service(error: WeixinServiceError) -> Self {
        let kind = match error {
            WeixinServiceError::AccountNotRunning { .. } => WeixinHttpErrorKind::AccountNotRunning,
            WeixinServiceError::UserNotFound { .. } => WeixinHttpErrorKind::UserNotFound,
            _ => WeixinHttpErrorKind::OperationFailed,
        };
        Self { kind }
    }
}

#[async_trait]
pub trait WeixinHttpService: Send + Sync {
    async fn refresh(&self) -> Result<(), WeixinHttpError>;

    async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError>;

    async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError>;

    async fn start_login(
        &self,
        account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinHttpError>;

    async fn get_login_status(
        &self,
        account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinHttpError>;
}

#[async_trait]
impl WeixinHttpService for WeixinService {
    async fn refresh(&self) -> Result<(), WeixinHttpError> {
        WeixinServicePort::refresh(self)
            .await
            .map_err(WeixinHttpError::from_service)
    }

    async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError> {
        WeixinServicePort::send_test_message(self, account_id, user_id, text)
            .await
            .map_err(WeixinHttpError::from_service)
    }

    async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError> {
        WeixinServicePort::send_test_message_to_bound_user(self, account_id, text)
            .await
            .map_err(WeixinHttpError::from_service)
    }

    async fn start_login(
        &self,
        account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinHttpError> {
        WeixinServicePort::start_login(self, account_id)
            .await
            .map_err(WeixinHttpError::from_service)
    }

    async fn get_login_status(
        &self,
        account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinHttpError> {
        WeixinServicePort::get_login_status(self, account_id)
            .await
            .map_err(WeixinHttpError::from_service)
    }
}

pub async fn handle_weixin_request(
    handler: &HttpHandler,
    request: &Request<Bytes>,
) -> Result<Option<HttpResponse>, HandlerError> {
    let method = request.method();
    let path = request.uri().path();

    if path == "/api/settings/weixin/accounts" && method == Method::GET {
        return Ok(Some(handle_list_accounts(handler).await?));
    }
    if path == "/api/settings/weixin/accounts" && method == Method::POST {
        return Ok(Some(handle_create_account(handler, request).await?));
    }

    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["api", "settings", "weixin", "accounts", account_id]
            if method == Method::PATCH && valid_percent_encoding(account_id) =>
        {
            Ok(Some(
                handle_update_account(handler, request, account_id).await?,
            ))
        }
        ["api", "settings", "weixin", "accounts", account_id]
            if method == Method::DELETE && valid_percent_encoding(account_id) =>
        {
            Ok(Some(handle_delete_account(handler, account_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "login", "start"]
            if method == Method::POST && valid_percent_encoding(account_id) =>
        {
            Ok(Some(handle_start_login(handler, account_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "login", "status"]
            if method == Method::GET && valid_percent_encoding(account_id) =>
        {
            Ok(Some(handle_login_status(handler, account_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "test"]
            if method == Method::POST && valid_percent_encoding(account_id) =>
        {
            Ok(Some(handle_test_account(handler, account_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "users"]
            if method == Method::GET && valid_percent_encoding(account_id) =>
        {
            Ok(Some(handle_list_users(handler, account_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "users", raw_user_id, "approve"]
            if method == Method::POST && valid_percent_encoding(account_id) =>
        {
            let Some(user_id) = decode_user_id(raw_user_id) else {
                return Ok(None);
            };
            Ok(Some(
                handle_approve_user(handler, account_id, &user_id).await?,
            ))
        }
        ["api", "settings", "weixin", "accounts", account_id, "users", raw_user_id, "test"]
            if method == Method::POST && valid_percent_encoding(account_id) =>
        {
            let Some(user_id) = decode_user_id(raw_user_id) else {
                return Ok(None);
            };
            Ok(Some(handle_test_user(handler, account_id, &user_id).await?))
        }
        ["api", "settings", "weixin", "accounts", account_id, "users", raw_user_id]
            if method == Method::DELETE && valid_percent_encoding(account_id) =>
        {
            let Some(user_id) = decode_user_id(raw_user_id) else {
                return Ok(None);
            };
            Ok(Some(
                handle_delete_user(handler, account_id, &user_id).await?,
            ))
        }
        _ => Ok(None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeixinAccountDto {
    id: String,
    name: String,
    enabled: bool,
    allow_auth_requests: bool,
    logged_in: bool,
    created_at: String,
    updated_at: String,
    pending_count: u64,
    authorized_count: u64,
    needs_reactivation_count: u64,
}

impl From<WeixinAccountStats> for WeixinAccountDto {
    fn from(account: WeixinAccountStats) -> Self {
        Self {
            id: account.id,
            name: account.name,
            enabled: account.enabled,
            allow_auth_requests: account.allow_auth_requests,
            logged_in: account.logged_in,
            created_at: account.created_at,
            updated_at: account.updated_at,
            pending_count: account.pending_count,
            authorized_count: account.authorized_count,
            needs_reactivation_count: account.needs_reactivation_count,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeixinUserDto {
    id: String,
    account_id: String,
    user_id: String,
    display_name: String,
    status: String,
    needs_reactivation: bool,
    last_inbound_at: Option<String>,
    applied_at: String,
    authorized_at: Option<String>,
    updated_at: String,
}

impl From<weixin_account_users::Model> for WeixinUserDto {
    fn from(user: weixin_account_users::Model) -> Self {
        Self {
            id: user.id,
            account_id: user.account_id,
            user_id: user.user_id,
            display_name: user.display_name,
            status: user.status,
            needs_reactivation: user.needs_reactivation != 0,
            last_inbound_at: user.last_inbound_at,
            applied_at: user.applied_at,
            authorized_at: user.authorized_at,
            updated_at: user.updated_at,
        }
    }
}

async fn handle_list_accounts(handler: &HttpHandler) -> HandlerResult {
    let accounts = handler
        .repository
        .get_weixin_accounts_with_stats()
        .await?
        .into_iter()
        .map(WeixinAccountDto::from)
        .collect::<Vec<_>>();
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "accounts": accounts }),
    ))
}

async fn handle_create_account(handler: &HttpHandler, request: &Request<Bytes>) -> HandlerResult {
    let body = body_object(handler, request)?;
    let name = required_name(handler, &body)?;
    let enabled = nullable_bool(handler, &body, "enabled")?.unwrap_or(true);
    let allow_auth_requests = nullable_bool(handler, &body, "allowAuthRequests")?.unwrap_or(true);
    let account_id = Uuid::new_v4().to_string();
    let now = now_iso();
    handler
        .repository
        .create_weixin_account(weixin_accounts::Model {
            id: account_id.clone(),
            name,
            enabled: i64::from(enabled),
            allow_auth_requests: i64::from(allow_auth_requests),
            weixin_uin: None,
            bot_token_enc: None,
            base_url: None,
            sync_buf: None,
            created_at: now.clone(),
            updated_at: now,
        })
        .await?;
    broadcast_settings(handler).await?;
    Ok(json(
        StatusCode::CREATED,
        &serde_json::json!({ "success": true, "accountId": account_id }),
    ))
}

async fn handle_update_account(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    account_id: &str,
) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let body = body_object(handler, request)?;
    let updates = WeixinAccountUpdate {
        name: optional_name(handler, &body)?,
        enabled: optional_bool(handler, &body, "enabled")?,
        allow_auth_requests: optional_bool(handler, &body, "allowAuthRequests")?,
        ..WeixinAccountUpdate::default()
    };
    handler
        .repository
        .update_weixin_account(account_id, updates)
        .await?;
    broadcast_settings(handler).await?;
    if refresh(handler).await.is_err() {
        return Ok(service_failed());
    }
    Ok(success())
}

async fn handle_delete_account(handler: &HttpHandler, account_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    handler.repository.delete_weixin_account(account_id).await?;
    broadcast_settings(handler).await?;
    if refresh(handler).await.is_err() {
        return Ok(service_failed());
    }
    Ok(success())
}

async fn handle_start_login(handler: &HttpHandler, account_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let Some(service) = handler.weixin_service.as_ref() else {
        return Ok(login_failed(handler));
    };
    match service.start_login(account_id).await {
        Ok(response) => Ok(json(StatusCode::OK, &response)),
        Err(_) => Ok(login_failed(handler)),
    }
}

async fn handle_login_status(handler: &HttpHandler, account_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let Some(service) = handler.weixin_service.as_ref() else {
        return Ok(service_failed());
    };
    match service.get_login_status(account_id).await {
        Ok(response) => Ok(json(StatusCode::OK, &response)),
        Err(_) => Ok(service_failed()),
    }
}

async fn handle_test_account(handler: &HttpHandler, account_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let message = test_message(handler).await?;
    let result = match handler.weixin_service.as_ref() {
        Some(service) => {
            service
                .send_test_message_to_bound_user(account_id, &message)
                .await
        }
        None => Err(WeixinHttpError::operation_failed()),
    };
    match result {
        Ok(()) => Ok(success()),
        Err(error) => Ok(test_failed(handler, error)),
    }
}

async fn handle_list_users(handler: &HttpHandler, account_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let users = handler
        .repository
        .list_weixin_users_by_account(account_id)
        .await?
        .into_iter()
        .map(WeixinUserDto::from)
        .collect::<Vec<_>>();
    Ok(json(StatusCode::OK, &serde_json::json!({ "users": users })))
}

async fn handle_approve_user(
    handler: &HttpHandler,
    account_id: &str,
    user_id: &str,
) -> HandlerResult {
    let Some(account) = account(handler, account_id).await? else {
        return Ok(account_not_found(handler));
    };
    let Some(user) = handler
        .repository
        .approve_weixin_user(account_id, user_id)
        .await?
    else {
        return Ok(user_not_found(handler));
    };
    broadcast_settings(handler).await?;

    let settings = handler
        .repository
        .get_site_settings(&handler.site_defaults())
        .await?;
    let time = localized_now(&settings.language);
    let message = translate_with(
        handler,
        "weixin.approveMessageTemplate",
        &[("accountName", &account.name), ("time", &time)],
    );
    if let Some(service) = handler.weixin_service.as_ref() {
        let _ = service
            .send_test_message(account_id, user_id, &message)
            .await;
    }
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "user": WeixinUserDto::from(user) }),
    ))
}

async fn handle_test_user(handler: &HttpHandler, account_id: &str, user_id: &str) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    let message = test_message(handler).await?;
    let result = match handler.weixin_service.as_ref() {
        Some(service) => {
            service
                .send_test_message(account_id, user_id, &message)
                .await
        }
        None => Err(WeixinHttpError::operation_failed()),
    };
    match result {
        Ok(()) => Ok(success()),
        Err(error) => Ok(test_failed(handler, error)),
    }
}

async fn handle_delete_user(
    handler: &HttpHandler,
    account_id: &str,
    user_id: &str,
) -> HandlerResult {
    if account(handler, account_id).await?.is_none() {
        return Ok(account_not_found(handler));
    }
    handler
        .repository
        .delete_weixin_user(account_id, user_id)
        .await?;
    broadcast_settings(handler).await?;
    Ok(success())
}

async fn account(
    handler: &HttpHandler,
    account_id: &str,
) -> Result<Option<weixin_accounts::Model>, HandlerError> {
    Ok(handler
        .repository
        .get_weixin_account_by_id(account_id)
        .await?)
}

async fn broadcast_settings(handler: &HttpHandler) -> Result<(), HandlerError> {
    handler
        .runtime
        .settings_changed(SettingsNamespace::Weixin)
        .await?;
    Ok(())
}

async fn refresh(handler: &HttpHandler) -> Result<(), WeixinHttpError> {
    let Some(service) = handler.weixin_service.as_ref() else {
        return Err(WeixinHttpError::operation_failed());
    };
    service.refresh().await
}

async fn test_message(handler: &HttpHandler) -> Result<String, HandlerError> {
    let settings = handler
        .repository
        .get_site_settings(&handler.site_defaults())
        .await?;
    let time = localized_now(&settings.language);
    Ok(translate_with(
        handler,
        "weixin.testMessageTemplate",
        &[("siteName", &settings.site_name), ("time", &time)],
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

fn required_name(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
) -> Result<String, HandlerError> {
    let Some(value) = body.get("name").filter(|value| !value.is_null()) else {
        return Err(invalid(handler, "weixin.accountNameRequired"));
    };
    let Some(value) = value.as_str() else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(handler, "weixin.accountNameRequired"));
    }
    Ok(value.to_owned())
}

fn optional_name(
    handler: &HttpHandler,
    body: &JsonMap<String, JsonValue>,
) -> Result<Option<String>, HandlerError> {
    let Some(value) = body.get("name") else {
        return Ok(None);
    };
    let Some(value) = value.as_str() else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(handler, "weixin.accountNameRequired"));
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

fn decode_user_id(value: &str) -> Option<String> {
    if !valid_percent_encoding(value) {
        return None;
    }
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
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

fn account_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("weixin.accountNotFound"),
    )
}

fn user_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("weixin.userNotFound"),
    )
}

fn login_failed(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::BAD_GATEWAY,
        &handler.translate("weixin.loginFailed"),
    )
}

fn test_failed(handler: &HttpHandler, error: WeixinHttpError) -> HttpResponse {
    let key = match error.kind {
        WeixinHttpErrorKind::AccountNotRunning => "weixin.accountNotRunning",
        WeixinHttpErrorKind::UserNotFound => "weixin.userNotFound",
        WeixinHttpErrorKind::OperationFailed => "weixin.testMessageFailed",
    };
    error_json(StatusCode::BAD_REQUEST, &handler.translate(key))
}

fn service_failed() -> HttpResponse {
    error_json(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Weixin service operation failed",
    )
}

fn success() -> HttpResponse {
    json(StatusCode::OK, &serde_json::json!({ "success": true }))
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
