use std::collections::HashSet;

use bytes::Bytes;
use chrono::{SecondsFormat, Utc};
use http::{Method, Request, StatusCode};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::database::repository::{
    compute_provider_models, AgentSettingsUpdate, CreateLlmProviderInput, LlmProviderUpdate,
    ProviderModelSource,
};
use crate::entity::{agent_settings, llm_providers};
use crate::llm::{FetchModelsError, FetchModelsOptions, ProviderRegistry};

use super::dto::SettingsNamespace;
use super::handler::HttpHandler;
use super::response::{error_json, json, HandlerError, HandlerResult, HttpResponse};

const PROTOCOLS: [&str; 2] = ["openai-chat", "openai-responses"];
const SEARCH_PROVIDERS: [(&str, &str); 2] = [("tavily", "Tavily"), ("brave", "Brave")];

pub async fn handle_llm_request(
    handler: &HttpHandler,
    request: &Request<Bytes>,
) -> Result<Option<HttpResponse>, HandlerError> {
    let method = request.method();
    let path = request.uri().path();

    if path == "/api/llm/providers" && method == Method::GET {
        return Ok(Some(handle_list_providers(handler).await?));
    }
    if path == "/api/llm/providers" && method == Method::POST {
        return Ok(Some(handle_create_provider(handler, request).await?));
    }
    if path == "/api/llm/settings" && method == Method::GET {
        return Ok(Some(handle_get_settings(handler).await?));
    }
    if path == "/api/llm/settings" && method == Method::PATCH {
        return Ok(Some(handle_update_settings(handler, request).await?));
    }

    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["api", "llm", "providers", id] if method == Method::PATCH => {
            Ok(Some(handle_update_provider(handler, request, id).await?))
        }
        ["api", "llm", "providers", id] if method == Method::DELETE => {
            Ok(Some(handle_delete_provider(handler, id).await?))
        }
        ["api", "llm", "providers", id, "refresh-models"] if method == Method::POST => {
            Ok(Some(handle_refresh_provider_models(handler, id).await?))
        }
        _ => Ok(None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmModelInfoDto {
    id: String,
    source: &'static str,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmProviderDto {
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    has_api_key: bool,
    enabled: bool,
    models: Vec<String>,
    model_details: Vec<LlmModelInfoDto>,
    models_fetched_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLlmSettingsDto {
    search_provider: String,
    has_tavily_api_key: bool,
    has_brave_api_key: bool,
    default_provider_id: Option<String>,
    default_model_id: Option<String>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProviderInfoDto {
    id: &'static str,
    label: &'static str,
    is_configured: bool,
}

struct RefreshModelsResult {
    provider: llm_providers::Model,
    models: Option<Vec<String>>,
    models_error: Option<String>,
}

async fn handle_list_providers(handler: &HttpHandler) -> HandlerResult {
    let providers = handler
        .repository
        .get_all_llm_providers()
        .await?
        .into_iter()
        .map(provider_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "providers": providers }),
    ))
}

async fn handle_create_provider(handler: &HttpHandler, request: &Request<Bytes>) -> HandlerResult {
    let body = body_object(handler, request)?;
    let name = body
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(invalid(handler, "apiError.llmProviderNameRequired"));
    }
    let Some(protocol) = body
        .get("protocol")
        .and_then(JsonValue::as_str)
        .filter(|value| PROTOCOLS.contains(value))
        .map(str::to_owned)
    else {
        return Err(invalid(handler, "apiError.llmProviderProtocolInvalid"));
    };
    let base_url = body
        .get("baseUrl")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !valid_base_url(&base_url) {
        return Err(invalid(handler, "apiError.llmProviderBaseUrlInvalid"));
    }
    let api_key = body
        .get("apiKey")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim();
    if api_key.is_empty() {
        return Err(invalid(handler, "apiError.llmProviderApiKeyRequired"));
    }
    let enabled = match body.get("enabled") {
        None => None,
        Some(value) => Some(
            value
                .as_bool()
                .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))?,
        ),
    };

    let created = handler
        .repository
        .create_llm_provider(CreateLlmProviderInput {
            name,
            protocol,
            base_url,
            api_key_enc: handler.master_key.encrypt(api_key)?,
            enabled,
        })
        .await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Llm)
        .await?;
    let refreshed = refresh_models_cache(handler, created).await;
    provider_response(
        StatusCode::CREATED,
        refreshed.provider,
        refreshed.models_error,
    )
}

async fn handle_update_provider(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    id: &str,
) -> HandlerResult {
    let Some(existing) = handler.repository.get_llm_provider_by_id(id).await? else {
        return Ok(provider_not_found(handler));
    };
    let body = body_object(handler, request)?;
    let mut updates = LlmProviderUpdate::default();

    if let Some(value) = body.get("name") {
        let value = value.as_str().unwrap_or_default().trim().to_owned();
        if value.is_empty() {
            return Err(invalid(handler, "apiError.llmProviderNameRequired"));
        }
        updates.name = Some(value);
    }
    if let Some(value) = body.get("protocol") {
        let Some(value) = value.as_str().filter(|value| PROTOCOLS.contains(value)) else {
            return Err(invalid(handler, "apiError.llmProviderProtocolInvalid"));
        };
        updates.protocol = Some(value.to_owned());
    }
    if let Some(value) = body.get("baseUrl") {
        let value = value.as_str().unwrap_or_default().trim().to_owned();
        if !valid_base_url(&value) {
            return Err(invalid(handler, "apiError.llmProviderBaseUrlInvalid"));
        }
        updates.base_url = Some(value);
    }
    if let Some(value) = body.get("apiKey") {
        let value = value
            .as_str()
            .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))?
            .trim();
        if !value.is_empty() {
            updates.api_key_enc = Some(handler.master_key.encrypt(value)?);
        }
    }
    if let Some(value) = body.get("enabled") {
        updates.enabled = Some(
            value
                .as_bool()
                .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))?,
        );
    }
    if let Some(value) = body.get("manualModels") {
        updates.manual_models = Some(normalize_string_array(handler, value)?);
    }
    if let Some(value) = body.get("disabledModels") {
        updates.disabled_models = Some(normalize_string_array(handler, value)?);
    }

    let credentials_changed = updates
        .base_url
        .as_ref()
        .is_some_and(|base_url| base_url != &existing.base_url)
        || updates.api_key_enc.is_some();
    let Some(mut provider) = handler.repository.update_llm_provider(id, updates).await? else {
        return Ok(provider_not_found(handler));
    };
    handler
        .runtime
        .settings_changed(SettingsNamespace::Llm)
        .await?;

    let mut models_error = None;
    if credentials_changed {
        let refreshed = refresh_models_cache(handler, provider).await;
        provider = refreshed.provider;
        models_error = refreshed.models_error;
    }
    provider_response(StatusCode::OK, provider, models_error)
}

async fn handle_delete_provider(handler: &HttpHandler, id: &str) -> HandlerResult {
    if handler
        .repository
        .get_llm_provider_by_id(id)
        .await?
        .is_none()
    {
        return Ok(provider_not_found(handler));
    }
    handler.repository.delete_llm_provider(id).await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Llm)
        .await?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_refresh_provider_models(handler: &HttpHandler, id: &str) -> HandlerResult {
    let Some(provider) = handler.repository.get_llm_provider_by_id(id).await? else {
        return Ok(provider_not_found(handler));
    };
    let refreshed = refresh_models_cache(handler, provider).await;
    if let Some(error) = refreshed.models_error {
        return Ok(error_json(StatusCode::BAD_GATEWAY, &error));
    }
    let Some(models) = refreshed.models else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "models": models }),
    ))
}

async fn handle_get_settings(handler: &HttpHandler) -> HandlerResult {
    let settings = handler.repository.get_agent_settings().await?;
    let search_providers = search_provider_infos(&settings);
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({
            "settings": settings_dto(settings),
            "searchProviders": search_providers,
        }),
    ))
}

async fn handle_update_settings(handler: &HttpHandler, request: &Request<Bytes>) -> HandlerResult {
    let body = body_object(handler, request)?;
    let mut updates = AgentSettingsUpdate::default();

    if let Some(value) = body.get("searchProvider") {
        let Some(value) = value
            .as_str()
            .filter(|value| matches!(*value, "none" | "tavily" | "brave"))
        else {
            return Err(invalid(handler, "apiError.llmSearchProviderInvalid"));
        };
        updates.search_provider = Some(value.to_owned());
    }
    if let Some(value) = body.get("defaultProviderId") {
        updates.default_provider_id = Some(match value {
            JsonValue::Null => None,
            JsonValue::String(value)
                if handler
                    .repository
                    .get_llm_provider_by_id(value)
                    .await?
                    .is_some() =>
            {
                Some(value.clone())
            }
            JsonValue::String(_) => {
                return Err(invalid(handler, "apiError.llmDefaultProviderNotFound"));
            }
            _ => return Err(invalid(handler, "apiError.invalidRequest")),
        });
    }
    if let Some(value) = body.get("defaultModelId") {
        updates.default_model_id = Some(match value {
            JsonValue::Null => None,
            JsonValue::String(value) => Some(value.clone()),
            _ => return Err(invalid(handler, "apiError.invalidRequest")),
        });
    }
    if let Some(value) = body.get("tavilyApiKey") {
        updates.tavily_api_key_enc = Some(search_key_update(handler, value)?);
    }
    if let Some(value) = body.get("braveApiKey") {
        updates.brave_api_key_enc = Some(search_key_update(handler, value)?);
    }

    let settings = handler.repository.update_agent_settings(updates).await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::Llm)
        .await?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "settings": settings_dto(settings) }),
    ))
}

async fn refresh_models_cache(
    handler: &HttpHandler,
    provider: llm_providers::Model,
) -> RefreshModelsResult {
    let registry = ProviderRegistry::new(handler.repository.clone(), handler.master_key.clone());
    let models = match registry
        .fetch_provider_models(
            &provider,
            handler.models_transport.as_ref(),
            FetchModelsOptions::default(),
        )
        .await
    {
        Ok(models) => models,
        Err(error) => {
            tracing::warn!(
                provider_id = provider.id,
                provider_name = provider.name,
                base_url = provider.base_url,
                diagnostic = error.diagnostic(),
                "failed to refresh LLM provider models"
            );
            return RefreshModelsResult {
                provider,
                models: None,
                models_error: Some(fetch_models_error_message(handler, &error)),
            };
        }
    };
    match handler
        .repository
        .update_llm_provider(
            &provider.id,
            LlmProviderUpdate {
                models_cache: Some(Some(models.clone())),
                models_fetched_at: Some(Some(now_iso())),
                ..LlmProviderUpdate::default()
            },
        )
        .await
    {
        Ok(updated) => RefreshModelsResult {
            provider: updated.unwrap_or(provider),
            models: Some(models),
            models_error: None,
        },
        Err(error) => {
            tracing::warn!(
                provider_id = provider.id,
                provider_name = provider.name,
                base_url = provider.base_url,
                %error,
                "failed to persist refreshed LLM provider models"
            );
            RefreshModelsResult {
                provider,
                models: None,
                models_error: Some(error.to_string()),
            }
        }
    }
}

fn provider_dto(provider: llm_providers::Model) -> Result<LlmProviderDto, HandlerError> {
    let models = compute_provider_models(&provider)?;
    Ok(LlmProviderDto {
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        base_url: provider.base_url,
        has_api_key: !provider.api_key_enc.is_empty(),
        enabled: provider.enabled != 0,
        models: models.effective,
        model_details: models
            .model_details
            .into_iter()
            .map(|model| LlmModelInfoDto {
                id: model.id,
                source: match model.source {
                    ProviderModelSource::Fetched => "fetched",
                    ProviderModelSource::Manual => "manual",
                },
                enabled: model.enabled,
            })
            .collect(),
        models_fetched_at: provider.models_fetched_at,
        created_at: provider.created_at,
        updated_at: provider.updated_at,
    })
}

fn provider_response(
    status: StatusCode,
    provider: llm_providers::Model,
    models_error: Option<String>,
) -> HandlerResult {
    let mut payload = serde_json::json!({ "provider": provider_dto(provider)? });
    if let Some(models_error) = models_error.filter(|error| !error.is_empty()) {
        payload["modelsError"] = JsonValue::String(models_error);
    }
    Ok(json(status, &payload))
}

fn settings_dto(settings: agent_settings::Model) -> AgentLlmSettingsDto {
    AgentLlmSettingsDto {
        search_provider: settings.search_provider,
        has_tavily_api_key: has_secret(settings.tavily_api_key_enc.as_deref()),
        has_brave_api_key: has_secret(settings.brave_api_key_enc.as_deref()),
        default_provider_id: settings.default_provider_id,
        default_model_id: settings.default_model_id,
        updated_at: settings.updated_at,
    }
}

fn search_provider_infos(settings: &agent_settings::Model) -> Vec<SearchProviderInfoDto> {
    SEARCH_PROVIDERS
        .into_iter()
        .map(|(id, label)| SearchProviderInfoDto {
            id,
            label,
            is_configured: match id {
                "tavily" => has_secret(settings.tavily_api_key_enc.as_deref()),
                "brave" => has_secret(settings.brave_api_key_enc.as_deref()),
                _ => false,
            },
        })
        .collect()
}

fn search_key_update(
    handler: &HttpHandler,
    value: &JsonValue,
) -> Result<Option<String>, HandlerError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))?
        .trim();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(handler.master_key.encrypt(value)?))
    }
}

fn normalize_string_array(
    handler: &HttpHandler,
    value: &JsonValue,
) -> Result<Vec<String>, HandlerError> {
    let values = value
        .as_array()
        .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))?;
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .map(str::to_owned)
                .ok_or_else(|| invalid(handler, "apiError.invalidRequest"))
        })
        .filter_map(|value| match value {
            Ok(value) if value.is_empty() || !seen.insert(value.clone()) => None,
            value => Some(value),
        })
        .collect()
}

fn fetch_models_error_message(handler: &HttpHandler, error: &FetchModelsError) -> String {
    let detail = match error {
        FetchModelsError::Decrypt(_) => return error.to_string(),
        FetchModelsError::Timeout { .. } => "timeout".to_owned(),
        FetchModelsError::Transport { detail, .. } => detail.clone(),
        FetchModelsError::HttpStatus { status, .. } => format!("HTTP {status}"),
        FetchModelsError::InvalidJson(_) => "invalid JSON response".to_owned(),
        FetchModelsError::UnexpectedShape { .. } => "unexpected response shape".to_owned(),
    };
    translate_with(
        handler,
        "apiError.llmFetchModelsFailed",
        &[("detail", detail.as_str())],
    )
}

fn valid_base_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn has_secret(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
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

fn invalid(handler: &HttpHandler, key: &'static str) -> HandlerError {
    HandlerError::InvalidRequest(handler.translate(key))
}

fn provider_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("apiError.llmProviderNotFound"),
    )
}

fn translate_with(handler: &HttpHandler, key: &'static str, values: &[(&str, &str)]) -> String {
    let mut translated = handler.translate(key);
    for (name, value) in values {
        translated = translated.replace(&format!("{{{{{name}}}}}"), value);
    }
    translated
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
