use std::collections::HashSet;

use async_trait::async_trait;
use bytes::Bytes;
use http::{Method, Request, StatusCode, Uri};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::agent::{
    AgentError, AgentSupervisor, SubmitUserMessageResult, DEFAULT_AGENT_SESSION_TITLE,
    HOSTED_TOOL_KEYS,
};
use crate::database::repository::{AgentSessionUpdate, CreateAgentSessionInput, RepositoryError};
use crate::entity::{agent_confirmations, agent_messages, agent_queued_messages, agent_sessions};

use super::handler::HttpHandler;
use super::response::{error_json, json, HandlerError, HandlerResult, HttpResponse};

const MAX_STEPS_MIN: i64 = 1;
const MAX_STEPS_MAX: i64 = 100;

#[async_trait]
pub trait AgentHttpService: Send + Sync {
    fn is_session_active(&self, session_id: &str) -> bool;

    async fn submit_user_message(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<SubmitUserMessageResult, AgentError>;

    async fn edit_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentError>;

    async fn withdraw_queued_message(&self, item_id: &str) -> Result<(), AgentError>;

    async fn stop_session(&self, session_id: &str) -> Result<(), AgentError>;

    async fn resolve_confirmation(
        &self,
        confirmation_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> Result<agent_confirmations::Model, AgentError>;
}

#[async_trait]
impl AgentHttpService for AgentSupervisor {
    fn is_session_active(&self, session_id: &str) -> bool {
        AgentSupervisor::is_session_active(self, session_id)
    }

    async fn submit_user_message(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<SubmitUserMessageResult, AgentError> {
        AgentSupervisor::submit_user_message(self, session_id, text, steer).await
    }

    async fn edit_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentError> {
        AgentSupervisor::edit_queued_message(self, item_id, text).await
    }

    async fn withdraw_queued_message(&self, item_id: &str) -> Result<(), AgentError> {
        AgentSupervisor::withdraw_queued_message(self, item_id).await
    }

    async fn stop_session(&self, session_id: &str) -> Result<(), AgentError> {
        AgentSupervisor::stop_session(self, session_id).await
    }

    async fn resolve_confirmation(
        &self,
        confirmation_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> Result<agent_confirmations::Model, AgentError> {
        AgentSupervisor::resolve_confirmation(self, confirmation_id, approved, reason).await
    }
}

pub async fn handle_agent_request(
    handler: &HttpHandler,
    request: &Request<Bytes>,
) -> Result<Option<HttpResponse>, HandlerError> {
    let method = request.method();
    let path = request.uri().path();

    if path == "/api/agent/sessions" && method == Method::GET {
        return Ok(Some(handle_list_sessions(handler, request.uri()).await?));
    }
    if path == "/api/agent/sessions" && method == Method::POST {
        return Ok(Some(handle_create_session(handler, request).await?));
    }

    let segments = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["api", "agent", "sessions", id] if method == Method::GET => {
            Ok(Some(handle_get_session(handler, id).await?))
        }
        ["api", "agent", "sessions", id] if method == Method::PATCH => {
            Ok(Some(handle_update_session(handler, request, id).await?))
        }
        ["api", "agent", "sessions", id] if method == Method::DELETE => {
            Ok(Some(handle_delete_session(handler, id).await?))
        }
        ["api", "agent", "sessions", id, "messages"] if method == Method::GET => Ok(Some(
            handle_list_messages(handler, request.uri(), id).await?,
        )),
        ["api", "agent", "sessions", id, "messages"] if method == Method::POST => Ok(Some(
            handle_submit_message(handler, request, id, false).await?,
        )),
        ["api", "agent", "sessions", id, "queue"] if method == Method::GET => {
            Ok(Some(handle_list_queued(handler, id).await?))
        }
        ["api", "agent", "sessions", id, "queue"] if method == Method::POST => {
            Ok(Some(handle_enqueue(handler, request, id).await?))
        }
        ["api", "agent", "queue", item_id] if method == Method::PATCH => {
            Ok(Some(handle_edit_queued(handler, request, item_id).await?))
        }
        ["api", "agent", "queue", item_id] if method == Method::DELETE => {
            Ok(Some(handle_withdraw_queued(handler, item_id).await?))
        }
        ["api", "agent", "sessions", id, "stop"] if method == Method::POST => {
            Ok(Some(handle_stop_session(handler, id).await?))
        }
        ["api", "agent", "sessions", id, "confirmations"] if method == Method::GET => {
            Ok(Some(handle_list_confirmations(handler, id).await?))
        }
        ["api", "agent", "confirmations", id, "decide"] if method == Method::POST => Ok(Some(
            handle_decide_confirmation(handler, request, id).await?,
        )),
        _ => Ok(None),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionDto {
    id: String,
    title: String,
    device_id: Option<String>,
    pane_id: Option<String>,
    provider_id: Option<String>,
    model_id: String,
    system_prompt: Option<String>,
    write_mode: String,
    use_provider_web_search: bool,
    provider_hosted_tools: Vec<String>,
    allow_control_chars: bool,
    origin_pane_title: Option<String>,
    origin_process_name: Option<String>,
    status: String,
    last_error: Option<String>,
    max_steps_per_turn: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentMessageDto {
    id: String,
    session_id: String,
    seq: i64,
    role: String,
    content: JsonValue,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentQueuedMessageDto {
    id: String,
    session_id: String,
    seq: i64,
    text: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfirmationDto {
    id: String,
    session_id: String,
    tool_name: String,
    tool_call_id: String,
    input: JsonValue,
    status: String,
    reason: Option<String>,
    decided_at: Option<String>,
    created_at: String,
}

async fn handle_list_sessions(handler: &HttpHandler, uri: &Uri) -> HandlerResult {
    let device_id = query_parameter(uri, "deviceId").filter(|value| !value.is_empty());
    let pane_id = query_parameter(uri, "paneId").filter(|value| !value.is_empty());
    let sessions = handler
        .repository
        .get_all_agent_sessions()
        .await?
        .into_iter()
        .filter(|session| {
            device_id
                .as_deref()
                .is_none_or(|device_id| session.device_id.as_deref() == Some(device_id))
                && pane_id
                    .as_deref()
                    .is_none_or(|pane_id| session.pane_id.as_deref() == Some(pane_id))
        })
        .map(session_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "sessions": sessions }),
    ))
}

async fn handle_create_session(handler: &HttpHandler, request: &Request<Bytes>) -> HandlerResult {
    let body = body_object(handler, request)?;
    let device_id = body
        .get("deviceId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if device_id.is_empty() {
        return Err(invalid(handler, "apiError.agentDeviceRequired"));
    }
    if handler
        .repository
        .get_device_by_id(device_id)
        .await?
        .is_none()
    {
        return Ok(error_json(
            StatusCode::NOT_FOUND,
            &handler.translate("apiError.deviceNotFound"),
        ));
    }

    let pane_id = body
        .get("paneId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if pane_id.is_empty() {
        return Err(invalid(handler, "apiError.agentPaneRequired"));
    }

    let provider_id = match body.get("providerId") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(provider_id))
            if handler
                .repository
                .get_llm_provider_by_id(provider_id)
                .await?
                .is_some() =>
        {
            Some(provider_id.clone())
        }
        Some(_) => return Err(invalid(handler, "apiError.llmProviderNotFound")),
    };

    let model_id = match body.get("modelId") {
        None | Some(JsonValue::Null) => {
            handler
                .repository
                .get_agent_settings()
                .await?
                .default_model_id
        }
        Some(JsonValue::String(model_id)) if !model_id.trim().is_empty() => {
            Some(model_id.trim().to_owned())
        }
        Some(_) => return Err(invalid(handler, "apiError.invalidRequest")),
    };
    let Some(model_id) = model_id.filter(|model_id| !model_id.is_empty()) else {
        return Err(invalid(handler, "apiError.llmNoDefaultModel"));
    };

    let write_mode = match body.get("writeMode") {
        None => None,
        Some(JsonValue::String(value)) if matches!(value.as_str(), "confirm" | "auto") => {
            Some(value.clone())
        }
        Some(_) => return Err(invalid(handler, "apiError.agentWriteModeInvalid")),
    };
    let use_provider_web_search = optional_bool(handler, &body, "useProviderWebSearch")?;
    if use_provider_web_search == Some(true) {
        require_responses_provider(
            handler,
            provider_id.as_deref(),
            "apiError.agentProviderWebSearchRequiresResponses",
        )
        .await?;
    }

    let provider_hosted_tools = match body.get("providerHostedTools") {
        None => Vec::new(),
        Some(value) => parse_hosted_tools(handler, value)?,
    };
    if !provider_hosted_tools.is_empty() {
        require_responses_provider(
            handler,
            provider_id.as_deref(),
            "apiError.agentHostedToolRequiresResponses",
        )
        .await?;
    }

    let allow_control_chars = optional_bool(handler, &body, "allowControlChars")?;
    let system_prompt = match body.get("systemPrompt") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        Some(_) => return Err(invalid(handler, "apiError.invalidRequest")),
    };
    let max_steps_per_turn = body
        .get("maxStepsPerTurn")
        .map(|value| validate_max_steps(handler, value))
        .transpose()?;

    let origin_pane_title = body
        .get("originPaneTitle")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let origin_process_name = match handler
        .runtime
        .agent_origin_process_name(device_id, pane_id)
        .await
    {
        Ok(process_name) => process_name,
        Err(_) => {
            tracing::warn!(device_id, pane_id, "failed to capture agent session origin");
            None
        }
    };

    let session = handler
        .repository
        .create_agent_session(CreateAgentSessionInput {
            title: DEFAULT_AGENT_SESSION_TITLE.to_owned(),
            device_id: Some(device_id.to_owned()),
            pane_id: Some(pane_id.to_owned()),
            provider_id,
            model_id,
            system_prompt,
            write_mode,
            use_provider_web_search,
            provider_hosted_tools: Some(provider_hosted_tools),
            allow_control_chars,
            origin_pane_title,
            origin_process_name,
            max_steps_per_turn,
        })
        .await?;
    Ok(json(
        StatusCode::CREATED,
        &serde_json::json!({ "session": session_dto(session)? }),
    ))
}

async fn handle_get_session(handler: &HttpHandler, id: &str) -> HandlerResult {
    let Some(session) = handler.repository.get_agent_session_by_id(id).await? else {
        return Ok(session_not_found(handler));
    };
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "session": session_dto(session)? }),
    ))
}

async fn handle_update_session(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    id: &str,
) -> HandlerResult {
    let Some(existing) = handler.repository.get_agent_session_by_id(id).await? else {
        return Ok(session_not_found(handler));
    };
    let body = body_object(handler, request)?;
    let mut updates = AgentSessionUpdate::default();

    if let Some(value) = body.get("title") {
        let Some(title) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err(invalid(handler, "apiError.invalidRequest"));
        };
        updates.title = Some(title.to_owned());
    }
    if let Some(value) = body.get("paneId") {
        let Some(pane_id) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err(invalid(handler, "apiError.agentPaneRequired"));
        };
        updates.pane_id = Some(Some(pane_id.to_owned()));
    }

    if let Some(value) = body.get("providerId") {
        updates.provider_id = match value {
            JsonValue::Null => Some(None),
            JsonValue::String(provider_id)
                if handler
                    .repository
                    .get_llm_provider_by_id(provider_id)
                    .await?
                    .is_some() =>
            {
                Some(Some(provider_id.clone()))
            }
            _ => return Err(invalid(handler, "apiError.llmProviderNotFound")),
        };
    }
    if let Some(value) = body.get("modelId") {
        let Some(model_id) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err(invalid(handler, "apiError.invalidRequest"));
        };
        updates.model_id = Some(model_id.to_owned());
    }
    if let Some(value) = body.get("systemPrompt") {
        updates.system_prompt = match value {
            JsonValue::Null => Some(None),
            JsonValue::String(prompt) => Some(Some(prompt.clone())),
            _ => return Err(invalid(handler, "apiError.invalidRequest")),
        };
    }
    if let Some(value) = body.get("writeMode") {
        let Some(write_mode) = value
            .as_str()
            .filter(|value| matches!(*value, "confirm" | "auto"))
        else {
            return Err(invalid(handler, "apiError.agentWriteModeInvalid"));
        };
        updates.write_mode = Some(write_mode.to_owned());
    }
    if body.contains_key("useProviderWebSearch") {
        updates.use_provider_web_search = optional_bool(handler, &body, "useProviderWebSearch")?;
    }
    if let Some(value) = body.get("providerHostedTools") {
        let effective_provider = updates
            .provider_id
            .as_ref()
            .map_or(existing.provider_id.as_deref(), |value| value.as_deref());
        let tools = parse_hosted_tools(handler, value)?;
        if !tools.is_empty() {
            require_responses_provider(
                handler,
                effective_provider,
                "apiError.agentHostedToolRequiresResponses",
            )
            .await?;
        }
        updates.provider_hosted_tools = Some(tools);
    }
    if body.contains_key("allowControlChars") {
        updates.allow_control_chars = optional_bool(handler, &body, "allowControlChars")?;
    }
    if let Some(value) = body.get("maxStepsPerTurn") {
        updates.max_steps_per_turn = Some(validate_max_steps(handler, value)?);
    }

    if updates
        .use_provider_web_search
        .unwrap_or(existing.use_provider_web_search != 0)
    {
        let effective_provider = updates
            .provider_id
            .as_ref()
            .map_or(existing.provider_id.as_deref(), |value| value.as_deref());
        require_responses_provider(
            handler,
            effective_provider,
            "apiError.agentProviderWebSearchRequiresResponses",
        )
        .await?;
    }

    let Some(session) = handler.repository.update_agent_session(id, updates).await? else {
        return Ok(session_not_found(handler));
    };
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "session": session_dto(session)? }),
    ))
}

async fn handle_delete_session(handler: &HttpHandler, id: &str) -> HandlerResult {
    if handler
        .repository
        .get_agent_session_by_id(id)
        .await?
        .is_none()
    {
        return Ok(session_not_found(handler));
    }
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    if service.is_session_active(id) {
        if let Err(error) = service.stop_session(id).await {
            return Ok(map_agent_error(handler, error));
        }
    }
    handler.repository.delete_agent_session(id).await?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "success": true }),
    ))
}

async fn handle_list_messages(handler: &HttpHandler, uri: &Uri, id: &str) -> HandlerResult {
    if handler
        .repository
        .get_agent_session_by_id(id)
        .await?
        .is_none()
    {
        return Ok(session_not_found(handler));
    }
    let after_seq = query_parameter(uri, "afterSeq")
        .map(|value| parse_js_integer(&value))
        .transpose()
        .map_err(|()| invalid(handler, "apiError.invalidRequest"))?;
    let messages = handler
        .repository
        .list_agent_messages(id, after_seq)
        .await?
        .into_iter()
        .map(message_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "messages": messages }),
    ))
}

async fn handle_submit_message(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    id: &str,
    steer: bool,
) -> HandlerResult {
    let body = body_object(handler, request)?;
    let text = body
        .get("text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(invalid(handler, "apiError.agentMessageTextRequired"));
    }
    submit_text(handler, id, text, steer).await
}

async fn submit_text(handler: &HttpHandler, id: &str, text: &str, steer: bool) -> HandlerResult {
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    let result = match service.submit_user_message(id, text, steer).await {
        Ok(result) => result,
        Err(error) => return Ok(map_agent_error(handler, error)),
    };
    submit_result_response(handler, id, result).await
}

async fn handle_list_queued(handler: &HttpHandler, id: &str) -> HandlerResult {
    if handler
        .repository
        .get_agent_session_by_id(id)
        .await?
        .is_none()
    {
        return Ok(session_not_found(handler));
    }
    let queued = handler
        .repository
        .list_queued_agent_messages(id)
        .await?
        .into_iter()
        .map(queued_dto)
        .collect::<Vec<_>>();
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "queued": queued }),
    ))
}

async fn handle_enqueue(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    id: &str,
) -> HandlerResult {
    let body = body_object(handler, request)?;
    let text = body
        .get("text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(invalid(handler, "apiError.agentMessageTextRequired"));
    }
    let steer = optional_bool(handler, &body, "steer")?.unwrap_or(false);
    submit_text(handler, id, text, steer).await
}

async fn handle_edit_queued(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    item_id: &str,
) -> HandlerResult {
    let body = body_object(handler, request)?;
    let text = body
        .get("text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(invalid(handler, "apiError.agentMessageTextRequired"));
    }
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    match service.edit_queued_message(item_id, text).await {
        Ok(queued) => Ok(json(
            StatusCode::OK,
            &serde_json::json!({ "queued": queued_dto(queued) }),
        )),
        Err(error) => Ok(map_agent_error(handler, error)),
    }
}

async fn handle_withdraw_queued(handler: &HttpHandler, item_id: &str) -> HandlerResult {
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    match service.withdraw_queued_message(item_id).await {
        Ok(()) => Ok(json(
            StatusCode::OK,
            &serde_json::json!({ "success": true }),
        )),
        Err(error) => Ok(map_agent_error(handler, error)),
    }
}

async fn handle_stop_session(handler: &HttpHandler, id: &str) -> HandlerResult {
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    if let Err(error) = service.stop_session(id).await {
        return Ok(map_agent_error(handler, error));
    }
    let session = handler
        .repository
        .get_agent_session_by_id(id)
        .await?
        .map(session_dto)
        .transpose()?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "session": session }),
    ))
}

async fn handle_list_confirmations(handler: &HttpHandler, id: &str) -> HandlerResult {
    if handler
        .repository
        .get_agent_session_by_id(id)
        .await?
        .is_none()
    {
        return Ok(session_not_found(handler));
    }
    let confirmations = handler
        .repository
        .list_pending_agent_confirmations(id)
        .await?
        .into_iter()
        .map(confirmation_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json(
        StatusCode::OK,
        &serde_json::json!({ "confirmations": confirmations }),
    ))
}

async fn handle_decide_confirmation(
    handler: &HttpHandler,
    request: &Request<Bytes>,
    id: &str,
) -> HandlerResult {
    let body = body_object(handler, request)?;
    let Some(approved) = body.get("approved").and_then(JsonValue::as_bool) else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let reason = match body.get("reason") {
        None => None,
        Some(JsonValue::String(reason)) => Some(reason.clone()),
        Some(_) => return Err(invalid(handler, "apiError.invalidRequest")),
    };
    let Some(service) = handler.agent_service.as_deref() else {
        return Ok(agent_service_unavailable());
    };
    match service.resolve_confirmation(id, approved, reason).await {
        Ok(confirmation) => Ok(json(
            StatusCode::OK,
            &serde_json::json!({ "confirmation": confirmation_dto(confirmation)? }),
        )),
        Err(error) => Ok(map_agent_error(handler, error)),
    }
}

async fn submit_result_response(
    handler: &HttpHandler,
    session_id: &str,
    result: SubmitUserMessageResult,
) -> HandlerResult {
    match result {
        SubmitUserMessageResult::Message { id, seq } => {
            let after_seq = seq.checked_sub(1);
            let message = handler
                .repository
                .list_agent_messages(session_id, after_seq)
                .await?
                .into_iter()
                .find(|message| message.id == id)
                .ok_or(RepositoryError::MissingAfterWrite("agent message"))?;
            Ok(json(
                StatusCode::CREATED,
                &serde_json::json!({ "message": message_dto(message)? }),
            ))
        }
        SubmitUserMessageResult::Queued { id, .. } => {
            let queued = handler
                .repository
                .get_queued_agent_message_by_id(&id)
                .await?
                .ok_or(RepositoryError::MissingAfterWrite("queued agent message"))?;
            Ok(json(
                StatusCode::CREATED,
                &serde_json::json!({ "queued": queued_dto(queued) }),
            ))
        }
    }
}

fn session_dto(session: agent_sessions::Model) -> Result<AgentSessionDto, HandlerError> {
    let provider_hosted_tools = serde_json::from_str::<Vec<String>>(&session.provider_hosted_tools)
        .map_err(|error| RepositoryError::InvalidJson {
            field: "agent_sessions.provider_hosted_tools",
            message: error.to_string(),
        })?;
    Ok(AgentSessionDto {
        id: session.id,
        title: session.title,
        device_id: session.device_id,
        pane_id: session.pane_id,
        provider_id: session.provider_id,
        model_id: session.model_id,
        system_prompt: session.system_prompt,
        write_mode: session.write_mode,
        use_provider_web_search: session.use_provider_web_search != 0,
        provider_hosted_tools,
        allow_control_chars: session.allow_control_chars != 0,
        origin_pane_title: session.origin_pane_title,
        origin_process_name: session.origin_process_name,
        status: session.status,
        last_error: session.last_error,
        max_steps_per_turn: session.max_steps_per_turn,
        created_at: session.created_at,
        updated_at: session.updated_at,
    })
}

fn message_dto(message: agent_messages::Model) -> Result<AgentMessageDto, HandlerError> {
    let content =
        serde_json::from_str(&message.content).map_err(|error| RepositoryError::InvalidJson {
            field: "agent_messages.content",
            message: error.to_string(),
        })?;
    Ok(AgentMessageDto {
        id: message.id,
        session_id: message.session_id,
        seq: message.seq,
        role: message.role,
        content,
        created_at: message.created_at,
    })
}

fn queued_dto(queued: agent_queued_messages::Model) -> AgentQueuedMessageDto {
    AgentQueuedMessageDto {
        id: queued.id,
        session_id: queued.session_id,
        seq: queued.seq,
        text: queued.text,
        created_at: queued.created_at,
    }
}

fn confirmation_dto(
    confirmation: agent_confirmations::Model,
) -> Result<AgentConfirmationDto, HandlerError> {
    let input = serde_json::from_str(&confirmation.input_json).map_err(|error| {
        RepositoryError::InvalidJson {
            field: "agent_confirmations.input_json",
            message: error.to_string(),
        }
    })?;
    Ok(AgentConfirmationDto {
        id: confirmation.id,
        session_id: confirmation.session_id,
        tool_name: confirmation.tool_name,
        tool_call_id: confirmation.tool_call_id,
        input,
        status: confirmation.status,
        reason: confirmation.reason,
        decided_at: confirmation.decided_at,
        created_at: confirmation.created_at,
    })
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

fn parse_hosted_tools(
    handler: &HttpHandler,
    value: &JsonValue,
) -> Result<Vec<String>, HandlerError> {
    let Some(values) = value.as_array() else {
        return Err(invalid(handler, "apiError.invalidRequest"));
    };
    let mut seen = HashSet::new();
    let mut tools = Vec::with_capacity(values.len());
    for value in values {
        let Some(tool) = value.as_str() else {
            return Err(invalid(handler, "apiError.invalidRequest"));
        };
        if !HOSTED_TOOL_KEYS.contains(&tool) {
            return Err(HandlerError::InvalidRequest(translate_with(
                handler,
                "apiError.agentHostedToolUnknown",
                &[("name", tool)],
            )));
        }
        if seen.insert(tool.to_owned()) {
            tools.push(tool.to_owned());
        }
    }
    Ok(tools)
}

async fn require_responses_provider(
    handler: &HttpHandler,
    provider_id: Option<&str>,
    error_key: &'static str,
) -> Result<(), HandlerError> {
    let effective_provider_id = match provider_id {
        Some(provider_id) => Some(provider_id.to_owned()),
        None => {
            handler
                .repository
                .get_agent_settings()
                .await?
                .default_provider_id
        }
    };
    let provider = match effective_provider_id {
        Some(provider_id) => {
            handler
                .repository
                .get_llm_provider_by_id(&provider_id)
                .await?
        }
        None => None,
    };
    if provider.as_ref().map(|provider| provider.protocol.as_str()) != Some("openai-responses") {
        return Err(invalid(handler, error_key));
    }
    Ok(())
}

fn validate_max_steps(handler: &HttpHandler, value: &JsonValue) -> Result<i64, HandlerError> {
    let value = js_number_from_json(value).floor();
    if !value.is_finite() || value < MAX_STEPS_MIN as f64 || value > MAX_STEPS_MAX as f64 {
        return Err(invalid(handler, "apiError.agentMaxStepsInvalid"));
    }
    Ok(value as i64)
}

fn js_number_from_json(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Null => 0.0,
        JsonValue::Bool(value) => f64::from(u8::from(*value)),
        JsonValue::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        JsonValue::String(value) => js_number_from_str(value),
        JsonValue::Array(values) => {
            let primitive = values
                .iter()
                .map(js_json_string)
                .collect::<Vec<_>>()
                .join(",");
            js_number_from_str(&primitive)
        }
        JsonValue::Object(_) => f64::NAN,
    }
}

fn js_json_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::String(value) => value.clone(),
        JsonValue::Array(values) => values
            .iter()
            .map(js_json_string)
            .collect::<Vec<_>>()
            .join(","),
        JsonValue::Object(_) => "[object Object]".to_owned(),
    }
}

fn parse_js_integer(value: &str) -> Result<i64, ()> {
    let value = js_number_from_str(value);
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(());
    }
    if value >= i64::MAX as f64 {
        return Ok(i64::MAX);
    }
    if value <= i64::MIN as f64 {
        return Ok(i64::MIN);
    }
    Ok(value as i64)
}

fn js_number_from_str(value: &str) -> f64 {
    let value = value.trim_matches(is_javascript_whitespace);
    if value.is_empty() {
        return 0.0;
    }
    let (radix, digits) = if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        (16, digits)
    } else if let Some(digits) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        (2, digits)
    } else if let Some(digits) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        (8, digits)
    } else {
        return value.parse::<f64>().unwrap_or(f64::NAN);
    };
    if digits.is_empty() {
        return f64::NAN;
    }
    digits
        .chars()
        .try_fold(0.0, |number, digit| {
            digit
                .to_digit(radix)
                .map(|digit| number * f64::from(radix) + f64::from(digit))
                .ok_or(())
        })
        .unwrap_or(f64::NAN)
}

fn is_javascript_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn query_parameter(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(key)?;
        (key == name)
            .then(|| decode_query_component(value))
            .flatten()
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    percent_decode_str(&value.replace('+', " "))
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn map_agent_error(handler: &HttpHandler, error: AgentError) -> HttpResponse {
    let (status, message) = match error {
        AgentError::SessionNotFound => (
            StatusCode::NOT_FOUND,
            handler.translate("apiError.agentSessionNotFound"),
        ),
        AgentError::ConfirmationNotFound => (
            StatusCode::NOT_FOUND,
            handler.translate("apiError.agentConfirmationNotFound"),
        ),
        AgentError::QueuedMessageNotFound => (
            StatusCode::NOT_FOUND,
            handler.translate("apiError.agentQueuedMessageNotFound"),
        ),
        AgentError::SessionBusy => (
            StatusCode::CONFLICT,
            handler.translate("apiError.agentSessionBusy"),
        ),
        AgentError::AwaitingConfirmation => (
            StatusCode::CONFLICT,
            handler.translate("apiError.agentSessionAwaitingConfirmation"),
        ),
        AgentError::ConfirmationAlreadyDecided => (
            StatusCode::CONFLICT,
            handler.translate("apiError.agentConfirmationAlreadyDecided"),
        ),
        AgentError::SessionOrphaned => (
            StatusCode::CONFLICT,
            handler.translate("apiError.agentSessionOrphaned"),
        ),
        error => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    error_json(status, &message)
}

fn session_not_found(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::NOT_FOUND,
        &handler.translate("apiError.agentSessionNotFound"),
    )
}

fn agent_service_unavailable() -> HttpResponse {
    error_json(
        StatusCode::INTERNAL_SERVER_ERROR,
        "agent supervisor is unavailable",
    )
}

fn invalid(handler: &HttpHandler, key: &'static str) -> HandlerError {
    HandlerError::InvalidRequest(handler.translate(key))
}

fn translate_with(handler: &HttpHandler, key: &'static str, values: &[(&str, &str)]) -> String {
    let mut translated = handler.translate(key);
    for (name, value) in values {
        translated = translated.replace(&format!("{{{{{name}}}}}"), value);
    }
    translated
}
