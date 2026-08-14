use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::agent::{
    AgentModelDriver, AgentModelError, AgentRunControl, AgentStream, AgentStreamPart,
    AgentToolCall, AgentToolDefinition, AgentToolExecutor, AgentToolOutput, ModelTurnRequest,
    ToolAuthorization, ToolExecutionKind,
};

use super::model_message::{chat_messages, responses_input, wire_tools, ModelMessageError};
use super::openai_transport::{OpenAiHttpTransport, OpenAiTransportError};
use super::{LanguageModelEndpoint, LanguageModelEndpointKind};

const STREAM_CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Debug, Default)]
pub struct OpenAiAgentModelDriver {
    transport: OpenAiHttpTransport,
}

#[async_trait]
pub trait LanguageModelGenerator: Send + Sync {
    async fn generate_text(
        &self,
        request: TextGenerationRequest,
    ) -> Result<String, AgentModelError>;

    async fn generate_structured_json(
        &self,
        request: StructuredJsonRequest,
    ) -> Result<Value, AgentModelError>;
}

impl OpenAiAgentModelDriver {
    pub fn new(transport: OpenAiHttpTransport) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &OpenAiHttpTransport {
        &self.transport
    }

    pub async fn generate_text(
        &self,
        request: TextGenerationRequest,
    ) -> Result<String, AgentModelError> {
        self.generate(request, None).await
    }

    pub async fn generate_structured_json(
        &self,
        request: StructuredJsonRequest,
    ) -> Result<Value, AgentModelError> {
        let schema = JsonResponseFormat {
            name: request.name.clone(),
            description: request.description.clone(),
            schema: request.schema.clone(),
        };
        let text = self.generate(request.text, Some(schema)).await?;
        serde_json::from_str(&text).map_err(|_| {
            AgentModelError::new("language model returned invalid structured JSON", false)
        })
    }

    async fn generate(
        &self,
        request: TextGenerationRequest,
        response_format: Option<JsonResponseFormat>,
    ) -> Result<String, AgentModelError> {
        let body =
            generation_body(&request, response_format.as_ref()).map_err(model_message_error)?;
        let response = self
            .transport
            .post_json_with_retries(
                &request.endpoint.endpoint_url,
                request.endpoint.api_key.expose_secret(),
                &body,
                request.max_retries,
                None,
            )
            .await
            .map_err(|error| transport_model_error(&error, &request.endpoint))?;
        let payload = self
            .transport
            .read_json(response, None)
            .await
            .map_err(|error| transport_model_error(&error, &request.endpoint))?;
        generation_text(request.endpoint.kind, &payload)
    }
}

#[async_trait]
impl LanguageModelGenerator for OpenAiAgentModelDriver {
    async fn generate_text(
        &self,
        request: TextGenerationRequest,
    ) -> Result<String, AgentModelError> {
        OpenAiAgentModelDriver::generate_text(self, request).await
    }

    async fn generate_structured_json(
        &self,
        request: StructuredJsonRequest,
    ) -> Result<Value, AgentModelError> {
        OpenAiAgentModelDriver::generate_structured_json(self, request).await
    }
}

pub struct TextGenerationRequest {
    pub endpoint: LanguageModelEndpoint,
    pub system_prompt: String,
    pub messages: Vec<Value>,
    pub max_retries: u32,
}

impl TextGenerationRequest {
    pub fn from_prompt(endpoint: LanguageModelEndpoint, prompt: impl Into<String>) -> Self {
        Self {
            endpoint,
            system_prompt: String::new(),
            messages: vec![json!({"role":"user","content":prompt.into()})],
            max_retries: 2,
        }
    }
}

impl fmt::Debug for TextGenerationRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TextGenerationRequest")
            .field("endpoint", &self.endpoint)
            .field("system_prompt", &"[REDACTED]")
            .field("message_count", &self.messages.len())
            .field("max_retries", &self.max_retries)
            .finish()
    }
}

pub struct StructuredJsonRequest {
    pub text: TextGenerationRequest,
    pub schema: Value,
    pub name: String,
    pub description: Option<String>,
}

impl StructuredJsonRequest {
    pub fn from_prompt(
        endpoint: LanguageModelEndpoint,
        prompt: impl Into<String>,
        schema: Value,
    ) -> Self {
        Self {
            text: TextGenerationRequest::from_prompt(endpoint, prompt),
            schema,
            name: "response".to_owned(),
            description: None,
        }
    }
}

impl fmt::Debug for StructuredJsonRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StructuredJsonRequest")
            .field("text", &self.text)
            .field("schema", &self.schema)
            .field("name", &self.name)
            .field("description", &self.description)
            .finish()
    }
}

#[derive(Clone)]
struct JsonResponseFormat {
    name: String,
    description: Option<String>,
    schema: Value,
}

#[async_trait]
impl AgentModelDriver for OpenAiAgentModelDriver {
    async fn start_turn(
        &self,
        request: ModelTurnRequest,
        tools: Arc<dyn AgentToolExecutor>,
    ) -> Result<Box<dyn AgentStream>, AgentModelError> {
        if request.max_steps == 0 {
            return Err(AgentModelError::new(
                "language-model max steps must be greater than zero",
                false,
            ));
        }
        wire_tools(request.endpoint.kind, &request.tools).map_err(model_message_error)?;
        match request.endpoint.kind {
            LanguageModelEndpointKind::ChatCompletions => {
                chat_messages(&request.system_prompt, &request.messages)
                    .map_err(model_message_error)?;
            }
            LanguageModelEndpointKind::Responses => {
                responses_input(
                    &request.system_prompt,
                    &request.endpoint.model_id,
                    &request.messages,
                )
                .map_err(model_message_error)?;
            }
        }

        let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
        let transport = self.transport.clone();
        let task = tokio::spawn(async move {
            let endpoint = request.endpoint.clone();
            if let Err(failure) = run_agent_turn(&transport, request, tools, &sender).await {
                if failure.cancelled {
                    let _ = sender.send(Ok(AgentStreamPart::Abort)).await;
                } else {
                    let error = AgentModelError::new(failure.message, failure.retryable)
                        .sanitized_with_secret(Some(endpoint.api_key.expose_secret()));
                    let _ = sender.send(Err(error)).await;
                }
            }
        });
        Ok(Box::new(ChannelAgentStream {
            receiver,
            task: Some(task),
        }))
    }

    async fn generate_title(
        &self,
        endpoint: &LanguageModelEndpoint,
        prompt: &str,
    ) -> Result<String, AgentModelError> {
        let mut request = TextGenerationRequest::from_prompt(endpoint.clone(), prompt);
        request.max_retries = 1;
        self.generate_text(request).await
    }
}

struct ChannelAgentStream {
    receiver: mpsc::Receiver<Result<AgentStreamPart, AgentModelError>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ChannelAgentStream {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[async_trait]
impl AgentStream for ChannelAgentStream {
    async fn next_part(&mut self) -> Result<Option<AgentStreamPart>, AgentModelError> {
        match self.receiver.recv().await {
            Some(result) => result.map(Some),
            None => match self.task.take() {
                Some(task) => match task.await {
                    Ok(()) => Ok(None),
                    Err(error) if error.is_cancelled() => Ok(None),
                    Err(_) => Err(AgentModelError::new(
                        "language-model stream worker failed",
                        false,
                    )),
                },
                None => Ok(None),
            },
        }
    }
}

#[derive(Debug)]
struct DriverFailure {
    message: String,
    retryable: bool,
    cancelled: bool,
}

impl DriverFailure {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            cancelled: false,
        }
    }

    fn cancelled() -> Self {
        Self {
            message: "language-model request was cancelled".to_owned(),
            retryable: false,
            cancelled: true,
        }
    }
}

impl From<ModelMessageError> for DriverFailure {
    fn from(error: ModelMessageError) -> Self {
        Self::fatal(error.message())
    }
}

impl From<OpenAiTransportError> for DriverFailure {
    fn from(error: OpenAiTransportError) -> Self {
        Self {
            message: error.message().to_owned(),
            retryable: error.is_retryable(),
            cancelled: error.is_cancelled(),
        }
    }
}

async fn run_agent_turn(
    transport: &OpenAiHttpTransport,
    request: ModelTurnRequest,
    tools: Arc<dyn AgentToolExecutor>,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<(), DriverFailure> {
    if is_cancelled(&request.control) {
        return Err(DriverFailure::cancelled());
    }

    let mut response_messages = resume_local_approvals(&request, &tools, sender).await?;
    for step in 0..request.max_steps {
        let mut prompt_messages = request.messages.clone();
        prompt_messages.extend(response_messages.iter().cloned());
        let body = streaming_body(&request, &prompt_messages)?;
        let response = transport
            .post_json_with_retries(
                &request.endpoint.endpoint_url,
                request.endpoint.api_key.expose_secret(),
                &body,
                request.max_retries,
                Some(&request.control),
            )
            .await?;
        let parsed = match request.endpoint.kind {
            LanguageModelEndpointKind::ChatCompletions => {
                parse_chat_stream(
                    transport,
                    response,
                    &request.endpoint.provider_name,
                    &request.control,
                    sender,
                )
                .await?
            }
            LanguageModelEndpointKind::Responses => {
                parse_responses_stream(transport, response, &request.control, sender).await?
            }
        };
        let processed = process_step(parsed, &request, &tools, sender).await?;
        response_messages.extend(processed.messages);
        send_part(
            sender,
            AgentStreamPart::StepFinished {
                response_messages: response_messages.clone(),
            },
        )
        .await?;

        if processed.pending_approval
            || processed.local_call_count == 0
            || step + 1 >= request.max_steps
        {
            return Ok(());
        }
    }
    Ok(())
}

struct ProcessedStep {
    messages: Vec<Value>,
    local_call_count: usize,
    pending_approval: bool,
}

async fn process_step(
    parsed: ParsedStep,
    request: &ModelTurnRequest,
    tools: &Arc<dyn AgentToolExecutor>,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<ProcessedStep, DriverFailure> {
    let definitions = request
        .tools
        .iter()
        .map(|definition| (definition.name.as_str(), definition))
        .collect::<HashMap<_, _>>();
    let mut approval_after_call: HashMap<String, Value> = HashMap::new();
    let mut tool_results = Vec::new();
    let mut pending_approval = false;
    let mut local_call_count = 0;

    for parsed_call in &parsed.calls {
        send_part(sender, AgentStreamPart::ToolCall(parsed_call.call.clone())).await?;
        if parsed_call.provider_executed {
            if let Some(output) = &parsed_call.provider_output {
                send_part(
                    sender,
                    AgentStreamPart::ToolResult {
                        call: parsed_call.call.clone(),
                        output: output.clone(),
                    },
                )
                .await?;
            }
            continue;
        }

        local_call_count += 1;
        let definition = definitions
            .get(parsed_call.call.tool_name.as_str())
            .copied()
            .ok_or_else(|| DriverFailure::fatal("language model called an unknown tool"))?;
        if definition.execution != ToolExecutionKind::Local {
            return Err(DriverFailure::fatal(
                "language model returned a provider tool as a local function call",
            ));
        }
        validate_schema(&parsed_call.call.input, &definition.input_schema)
            .map_err(DriverFailure::fatal)?;
        if tools.requires_confirmation(&parsed_call.call.tool_name, &parsed_call.call.input) {
            let approval_id = uuid::Uuid::new_v4().to_string();
            approval_after_call.insert(
                parsed_call.call.tool_call_id.clone(),
                json!({
                    "type":"tool-approval-request",
                    "approvalId":approval_id,
                    "toolCallId":parsed_call.call.tool_call_id,
                }),
            );
            send_part(
                sender,
                AgentStreamPart::ApprovalRequest {
                    approval_id,
                    call: parsed_call.call.clone(),
                },
            )
            .await?;
            pending_approval = true;
            continue;
        }
        let result = execute_local_tool(
            tools,
            parsed_call.call.clone(),
            ToolAuthorization::Automatic,
            &request.control,
            sender,
        )
        .await?;
        tool_results.push(result);
    }

    let mut assistant_content =
        Vec::with_capacity(parsed.assistant_content.len() + approval_after_call.len());
    for part in parsed.assistant_content {
        let tool_call_id = part
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        assistant_content.push(part);
        if let Some(approval) = tool_call_id
            .as_deref()
            .and_then(|id| approval_after_call.remove(id))
        {
            assistant_content.push(approval);
        }
    }
    let mut messages = Vec::new();
    if !assistant_content.is_empty() {
        messages.push(json!({"role":"assistant","content":assistant_content}));
    }
    if !tool_results.is_empty() {
        messages.push(json!({"role":"tool","content":tool_results}));
    }
    Ok(ProcessedStep {
        messages,
        local_call_count,
        pending_approval,
    })
}

async fn execute_local_tool(
    tools: &Arc<dyn AgentToolExecutor>,
    call: AgentToolCall,
    authorization: ToolAuthorization,
    control: &AgentRunControl,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<Value, DriverFailure> {
    let execution = tools.execute(call.clone(), authorization);
    tokio::pin!(execution);
    let result = tokio::select! {
        result = &mut execution => result,
        _ = control.changed() => return Err(DriverFailure::cancelled()),
    };
    match result {
        Ok(output) => {
            send_part(
                sender,
                AgentStreamPart::ToolResult {
                    call: call.clone(),
                    output: output.clone(),
                },
            )
            .await?;
            Ok(tool_result_part(&call, &output))
        }
        Err(error) => {
            send_part(
                sender,
                AgentStreamPart::ToolError {
                    call: call.clone(),
                    message: error.message().to_owned(),
                },
            )
            .await?;
            Ok(json!({
                "type":"tool-result",
                "toolCallId":call.tool_call_id,
                "toolName":call.tool_name,
                "output":{"type":"error-text","value":error.message()},
            }))
        }
    }
}

async fn resume_local_approvals(
    request: &ModelTurnRequest,
    tools: &Arc<dyn AgentToolExecutor>,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<Vec<Value>, DriverFailure> {
    let actions = collect_local_approval_actions(&request.messages)?;
    if actions.is_empty() {
        return Ok(Vec::new());
    }
    let definitions = request
        .tools
        .iter()
        .map(|definition| (definition.name.as_str(), definition))
        .collect::<HashMap<_, _>>();
    let mut results = Vec::new();
    for action in actions {
        if action.approved {
            let definition = definitions
                .get(action.call.tool_name.as_str())
                .copied()
                .filter(|definition| definition.execution == ToolExecutionKind::Local);
            if let Some(definition) = definition
                .filter(|_| tools.requires_confirmation(&action.call.tool_name, &action.call.input))
            {
                validate_schema(&action.call.input, &definition.input_schema)
                    .map_err(DriverFailure::fatal)?;
                results.push(
                    execute_local_tool(
                        tools,
                        action.call,
                        ToolAuthorization::Approved {
                            confirmation_id: action.approval_id,
                        },
                        &request.control,
                        sender,
                    )
                    .await?,
                );
            } else {
                let reason = action.reason.or_else(|| {
                    Some(format!(
                        "Tool \"{}\" does not require approval",
                        action.call.tool_name
                    ))
                });
                results.push(denied_tool_result(action.call, reason, sender).await?);
            }
        } else {
            results.push(denied_tool_result(action.call, action.reason, sender).await?);
        }
    }
    Ok(vec![json!({"role":"tool","content":results})])
}

async fn denied_tool_result(
    call: AgentToolCall,
    reason: Option<String>,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<Value, DriverFailure> {
    send_part(
        sender,
        AgentStreamPart::ToolOutputDenied { call: call.clone() },
    )
    .await?;
    let mut output = json!({"type":"execution-denied"});
    if let Some(reason) = reason {
        output["reason"] = Value::String(reason);
    }
    Ok(json!({
        "type":"tool-result",
        "toolCallId":call.tool_call_id,
        "toolName":call.tool_name,
        "output":output,
    }))
}

struct ApprovalAction {
    approval_id: String,
    approved: bool,
    reason: Option<String>,
    call: AgentToolCall,
}

fn collect_local_approval_actions(
    messages: &[Value],
) -> Result<Vec<ApprovalAction>, DriverFailure> {
    let Some(last) = messages.last().and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    if last.get("role").and_then(Value::as_str) != Some("tool") {
        return Ok(Vec::new());
    }
    let Some(last_content) = last.get("content").and_then(Value::as_array) else {
        return Err(DriverFailure::fatal("invalid tool approval message"));
    };
    let mut calls = HashMap::new();
    let mut requests = HashMap::new();
    for message in messages {
        let Some(object) = message.as_object() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(parts) = object.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            let Some(part) = part.as_object() else {
                continue;
            };
            match part.get("type").and_then(Value::as_str) {
                Some("tool-call")
                    if !part
                        .get("providerExecuted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false) =>
                {
                    let Some(id) = part.get("toolCallId").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(name) = part.get("toolName").and_then(Value::as_str) else {
                        continue;
                    };
                    calls.insert(
                        id.to_owned(),
                        AgentToolCall {
                            tool_call_id: id.to_owned(),
                            tool_name: name.to_owned(),
                            input: part.get("input").cloned().unwrap_or_else(|| json!({})),
                        },
                    );
                }
                Some("tool-approval-request") => {
                    if let (Some(approval_id), Some(tool_call_id)) = (
                        part.get("approvalId").and_then(Value::as_str),
                        part.get("toolCallId").and_then(Value::as_str),
                    ) {
                        requests.insert(approval_id.to_owned(), tool_call_id.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    let completed = last_content
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool-result"))
        .filter_map(|part| part.get("toolCallId").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut actions = Vec::new();
    for part in last_content {
        if part.get("type").and_then(Value::as_str) != Some("tool-approval-response") {
            continue;
        }
        let approval_id = part
            .get("approvalId")
            .and_then(Value::as_str)
            .ok_or_else(|| DriverFailure::fatal("invalid tool approval response"))?;
        if !seen.insert(approval_id) {
            continue;
        }
        let tool_call_id = requests
            .get(approval_id)
            .ok_or_else(|| DriverFailure::fatal("tool approval request was not found"))?;
        if completed.contains(tool_call_id.as_str()) {
            continue;
        }
        let call = calls
            .get(tool_call_id)
            .cloned()
            .ok_or_else(|| DriverFailure::fatal("approved tool call was not found"))?;
        let approved = part
            .get("approved")
            .and_then(Value::as_bool)
            .ok_or_else(|| DriverFailure::fatal("invalid tool approval response"))?;
        actions.push(ApprovalAction {
            approval_id: approval_id.to_owned(),
            approved,
            reason: part
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
            call,
        });
    }
    Ok(actions)
}

fn tool_result_part(call: &AgentToolCall, output: &AgentToolOutput) -> Value {
    let tagged = match &output.value {
        Value::String(value) => json!({"type":"text","value":value}),
        value => json!({"type":"json","value":value}),
    };
    json!({
        "type":"tool-result",
        "toolCallId":call.tool_call_id,
        "toolName":call.tool_name,
        "output":tagged,
    })
}

async fn send_part(
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
    part: AgentStreamPart,
) -> Result<(), DriverFailure> {
    sender
        .send(Ok(part))
        .await
        .map_err(|_| DriverFailure::cancelled())
}

fn streaming_body(request: &ModelTurnRequest, messages: &[Value]) -> Result<Value, DriverFailure> {
    let tools = wire_tools(request.endpoint.kind, &request.tools)?;
    Ok(match request.endpoint.kind {
        LanguageModelEndpointKind::ChatCompletions => {
            let mut body = json!({
                "model":request.endpoint.model_id,
                "messages":chat_messages(&request.system_prompt, messages)?,
                "stream":true,
            });
            if !tools.is_empty() {
                body["tools"] = Value::Array(tools);
            }
            body
        }
        LanguageModelEndpointKind::Responses => {
            let mut body = json!({
                "model":request.endpoint.model_id,
                "input":responses_input(&request.system_prompt, &request.endpoint.model_id, messages)?,
                "stream":true,
                "store":false,
            });
            if !tools.is_empty() {
                body["tools"] = Value::Array(tools);
            }
            let include = responses_include(&request.endpoint.model_id, &request.tools);
            if !include.is_empty() {
                body["include"] = Value::Array(include);
            }
            body
        }
    })
}

fn generation_body(
    request: &TextGenerationRequest,
    response_format: Option<&JsonResponseFormat>,
) -> Result<Value, ModelMessageError> {
    Ok(match request.endpoint.kind {
        LanguageModelEndpointKind::ChatCompletions => {
            let mut body = json!({
                "model":request.endpoint.model_id,
                "messages":chat_messages(&request.system_prompt, &request.messages)?,
                "stream":false,
            });
            if response_format.is_some() {
                // The existing TypeScript registry leaves compatible-provider
                // structuredOutputs disabled, so AI SDK uses JSON object mode.
                body["response_format"] = json!({"type":"json_object"});
            }
            body
        }
        LanguageModelEndpointKind::Responses => {
            let mut body = json!({
                "model":request.endpoint.model_id,
                "input":responses_input(
                    &request.system_prompt,
                    &request.endpoint.model_id,
                    &request.messages,
                )?,
                "stream":false,
                "store":false,
            });
            if is_reasoning_model(&request.endpoint.model_id) {
                body["include"] = json!(["reasoning.encrypted_content"]);
            }
            if let Some(format) = response_format {
                body["text"] = json!({
                    "format":{
                        "type":"json_schema",
                        "strict":true,
                        "name":format.name,
                        "description":format.description,
                        "schema":format.schema,
                    },
                });
            }
            body
        }
    })
}

fn generation_text(
    kind: LanguageModelEndpointKind,
    payload: &Value,
) -> Result<String, AgentModelError> {
    match kind {
        LanguageModelEndpointKind::ChatCompletions => payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| AgentModelError::new("language model returned no text", false)),
        LanguageModelEndpointKind::Responses => {
            let mut text = String::new();
            if let Some(output) = payload.get("output").and_then(Value::as_array) {
                for item in output {
                    if item.get("type").and_then(Value::as_str) != Some("message") {
                        continue;
                    }
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                                if let Some(delta) = part.get("text").and_then(Value::as_str) {
                                    text.push_str(delta);
                                }
                            }
                        }
                    }
                }
            }
            if text.is_empty() {
                Err(AgentModelError::new(
                    "language model returned no text",
                    false,
                ))
            } else {
                Ok(text)
            }
        }
    }
}

fn responses_include(model_id: &str, tools: &[AgentToolDefinition]) -> Vec<Value> {
    let mut include = Vec::new();
    if is_reasoning_model(model_id) {
        include.push(Value::String("reasoning.encrypted_content".to_owned()));
    }
    if tools.iter().any(|tool| {
        tool.execution == ToolExecutionKind::ProviderHosted && tool.name == "web_search"
    }) {
        include.push(Value::String("web_search_call.action.sources".to_owned()));
    }
    if tools.iter().any(|tool| {
        tool.execution == ToolExecutionKind::ProviderHosted && tool.name == "code_interpreter"
    }) {
        include.push(Value::String("code_interpreter_call.outputs".to_owned()));
    }
    include
}

fn is_reasoning_model(model_id: &str) -> bool {
    model_id.starts_with("o1")
        || model_id.starts_with("o3")
        || model_id.starts_with("o4-mini")
        || (model_id.starts_with("gpt-5") && !model_id.starts_with("gpt-5-chat"))
}

struct ParsedStep {
    assistant_content: Vec<Value>,
    calls: Vec<ParsedCall>,
}

struct ParsedCall {
    call: AgentToolCall,
    provider_executed: bool,
    provider_output: Option<AgentToolOutput>,
}

#[derive(Default)]
struct ChatToolCall {
    id: String,
    name: String,
    arguments: String,
    thought_signature: Option<String>,
}

async fn parse_chat_stream(
    transport: &OpenAiHttpTransport,
    response: reqwest::Response,
    provider_name: &str,
    control: &AgentRunControl,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<ParsedStep, DriverFailure> {
    let mut reader = transport.sse_reader(response);
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls: BTreeMap<usize, ChatToolCall> = BTreeMap::new();
    while let Some(event) = reader.next_json(Some(control)).await? {
        if let Some(message) = event_error_message(&event) {
            return Err(DriverFailure::fatal(message));
        }
        let Some(delta) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
        else {
            continue;
        };
        if let Some(value) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            if !value.is_empty() {
                reasoning.push_str(value);
                send_part(
                    sender,
                    AgentStreamPart::ReasoningDelta {
                        message_id: "reasoning-0".to_owned(),
                        text: value.to_owned(),
                    },
                )
                .await?;
            }
        }
        if let Some(value) = delta.get("content").and_then(Value::as_str) {
            if !value.is_empty() {
                text.push_str(value);
                send_part(
                    sender,
                    AgentStreamPart::TextDelta {
                        message_id: "txt-0".to_owned(),
                        text: value.to_owned(),
                    },
                )
                .await?;
            }
        }
        if let Some(tool_deltas) = delta.get("tool_calls").and_then(Value::as_array) {
            for (fallback_index, tool_delta) in tool_deltas.iter().enumerate() {
                let index = tool_delta
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(fallback_index);
                let call = calls.entry(index).or_default();
                if let Some(id) = tool_delta.get("id").and_then(Value::as_str) {
                    call.id = id.to_owned();
                }
                if let Some(function) = tool_delta.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        call.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        call.arguments.push_str(arguments);
                    }
                }
                if let Some(signature) = tool_delta
                    .get("extra_content")
                    .and_then(|value| value.get("google"))
                    .and_then(|value| value.get("thought_signature"))
                    .and_then(Value::as_str)
                {
                    call.thought_signature = Some(signature.to_owned());
                }
            }
        }
    }
    let mut assistant_content = Vec::new();
    if !reasoning.is_empty() {
        assistant_content.push(json!({"type":"reasoning","text":reasoning}));
    }
    if !text.is_empty() {
        assistant_content.push(json!({"type":"text","text":text}));
    }
    let mut parsed_calls = Vec::new();
    for (_, call) in calls {
        if call.id.is_empty() || call.name.is_empty() {
            return Err(DriverFailure::fatal(
                "language model returned an incomplete tool call",
            ));
        }
        let input = if call.arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&call.arguments).map_err(|_| {
                DriverFailure::fatal("language model returned invalid tool arguments")
            })?
        };
        let agent_call = AgentToolCall {
            tool_call_id: call.id,
            tool_name: call.name,
            input,
        };
        let mut part = json!({
            "type":"tool-call",
            "toolCallId":agent_call.tool_call_id,
            "toolName":agent_call.tool_name,
            "input":agent_call.input,
        });
        if let Some(signature) = call.thought_signature {
            let mut provider_options = Map::new();
            provider_options.insert(
                provider_name
                    .split('.')
                    .next()
                    .unwrap_or(provider_name)
                    .trim()
                    .to_owned(),
                json!({"thoughtSignature":signature}),
            );
            part["providerOptions"] = Value::Object(provider_options);
        }
        assistant_content.push(part);
        parsed_calls.push(ParsedCall {
            call: agent_call,
            provider_executed: false,
            provider_output: None,
        });
    }
    Ok(ParsedStep {
        assistant_content,
        calls: parsed_calls,
    })
}

#[derive(Default)]
struct ResponseText {
    id: String,
    phase: Option<Value>,
    text: String,
    annotations: Vec<Value>,
}

#[derive(Default)]
struct ResponseReasoning {
    id: String,
    encrypted_content: Option<String>,
    summaries: BTreeMap<u64, String>,
}

#[derive(Default)]
struct ResponseFunction {
    id: String,
    call_id: String,
    name: String,
    arguments: String,
    namespace: Option<String>,
}

struct ResponseHosted {
    id: String,
    name: String,
    input: Value,
    output: Option<Value>,
}

enum ResponseItem {
    Text(ResponseText),
    Reasoning(ResponseReasoning),
    Function(ResponseFunction),
    Hosted(ResponseHosted),
    Ignored,
}

async fn parse_responses_stream(
    transport: &OpenAiHttpTransport,
    response: reqwest::Response,
    control: &AgentRunControl,
    sender: &mpsc::Sender<Result<AgentStreamPart, AgentModelError>>,
) -> Result<ParsedStep, DriverFailure> {
    let mut reader = transport.sse_reader(response);
    let mut items: BTreeMap<u64, ResponseItem> = BTreeMap::new();
    while let Some(event) = reader.next_json(Some(control)).await? {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "error" => {
                return Err(DriverFailure::fatal(
                    event_error_message(&event)
                        .unwrap_or_else(|| "language-model provider returned an error".to_owned()),
                ));
            }
            "response.failed" => {
                let message = event
                    .get("response")
                    .and_then(|value| value.get("error"))
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("language-model response failed");
                return Err(DriverFailure::fatal(message));
            }
            "response.output_item.added" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let item = event.get("item").unwrap_or(&Value::Null);
                items.insert(index, response_item_from_added(item));
            }
            "response.output_text.delta" => {
                let id = event
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let delta = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let item = response_item_by_id_mut(&mut items, id);
                if let Some(ResponseItem::Text(text)) = item {
                    text.text.push_str(delta);
                }
                if !delta.is_empty() {
                    send_part(
                        sender,
                        AgentStreamPart::TextDelta {
                            message_id: id.to_owned(),
                            text: delta.to_owned(),
                        },
                    )
                    .await?;
                }
            }
            "response.reasoning_summary_text.delta" => {
                let id = event
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let summary_index = event
                    .get("summary_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let delta = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let item = response_item_by_id_mut(&mut items, id);
                if let Some(ResponseItem::Reasoning(reasoning)) = item {
                    reasoning
                        .summaries
                        .entry(summary_index)
                        .or_default()
                        .push_str(delta);
                }
                if !delta.is_empty() {
                    send_part(
                        sender,
                        AgentStreamPart::ReasoningDelta {
                            message_id: format!("{id}:{summary_index}"),
                            text: delta.to_owned(),
                        },
                    )
                    .await?;
                }
            }
            "response.output_text.annotation.added" => {
                let id = event
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(annotation) = event.get("annotation") {
                    if let Some(ResponseItem::Text(text)) = response_item_by_id_mut(&mut items, id)
                    {
                        text.annotations.push(annotation.clone());
                    }
                }
            }
            "response.output_item.done" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let item = event.get("item").unwrap_or(&Value::Null);
                update_response_item(items.entry(index).or_insert(ResponseItem::Ignored), item);
            }
            _ => {}
        }
    }

    let mut assistant_content = Vec::new();
    let mut calls = Vec::new();
    for (_, item) in items {
        match item {
            ResponseItem::Text(text) => {
                let mut part = json!({
                    "type":"text",
                    "text":text.text,
                    "providerOptions":{"openai":{"itemId":text.id}},
                });
                if let Some(phase) = text.phase {
                    part["providerOptions"]["openai"]["phase"] = phase;
                }
                if !text.annotations.is_empty() {
                    part["providerOptions"]["openai"]["annotations"] =
                        Value::Array(text.annotations);
                }
                assistant_content.push(part);
            }
            ResponseItem::Reasoning(reasoning) => {
                for (_, summary) in reasoning.summaries {
                    let mut provider_options = json!({"itemId":reasoning.id});
                    if let Some(encrypted) = &reasoning.encrypted_content {
                        provider_options["reasoningEncryptedContent"] =
                            Value::String(encrypted.clone());
                    }
                    assistant_content.push(json!({
                        "type":"reasoning",
                        "text":summary,
                        "providerOptions":{"openai":provider_options},
                    }));
                }
            }
            ResponseItem::Function(function) => {
                let input = parse_tool_input(&function.arguments)?;
                let call = AgentToolCall {
                    tool_call_id: function.call_id,
                    tool_name: function.name,
                    input,
                };
                let mut options = json!({"itemId":function.id});
                if let Some(namespace) = function.namespace {
                    options["namespace"] = Value::String(namespace);
                }
                assistant_content.push(json!({
                    "type":"tool-call",
                    "toolCallId":call.tool_call_id,
                    "toolName":call.tool_name,
                    "input":call.input,
                    "providerOptions":{"openai":options},
                }));
                calls.push(ParsedCall {
                    call,
                    provider_executed: false,
                    provider_output: None,
                });
            }
            ResponseItem::Hosted(hosted) => {
                let call = AgentToolCall {
                    tool_call_id: hosted.id,
                    tool_name: hosted.name,
                    input: hosted.input,
                };
                assistant_content.push(json!({
                    "type":"tool-call",
                    "toolCallId":call.tool_call_id,
                    "toolName":call.tool_name,
                    "input":call.input,
                    "providerExecuted":true,
                }));
                let output_value = hosted.output.unwrap_or(Value::Null);
                assistant_content.push(json!({
                    "type":"tool-result",
                    "toolCallId":call.tool_call_id,
                    "toolName":call.tool_name,
                    "output":{"type":"json","value":output_value},
                }));
                calls.push(ParsedCall {
                    call,
                    provider_executed: true,
                    provider_output: Some(AgentToolOutput {
                        value: output_value,
                        is_error: false,
                        terminal_tool: false,
                        terminal_failed: false,
                    }),
                });
            }
            ResponseItem::Ignored => {}
        }
    }
    Ok(ParsedStep {
        assistant_content,
        calls,
    })
}

fn response_item_from_added(item: &Value) -> ResponseItem {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "message" => ResponseItem::Text(ResponseText {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            phase: item.get("phase").cloned().filter(|value| !value.is_null()),
            text: String::new(),
            annotations: Vec::new(),
        }),
        "reasoning" => {
            let mut reasoning = ResponseReasoning {
                id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                encrypted_content: item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                summaries: BTreeMap::new(),
            };
            reasoning.summaries.insert(0, String::new());
            ResponseItem::Reasoning(reasoning)
        }
        "function_call" => ResponseItem::Function(ResponseFunction {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            call_id: item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            arguments: item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            namespace: item
                .get("namespace")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        "web_search_call" => ResponseItem::Hosted(ResponseHosted {
            id: item_id(item),
            name: "web_search".to_owned(),
            input: json!({}),
            output: None,
        }),
        "image_generation_call" => ResponseItem::Hosted(ResponseHosted {
            id: item_id(item),
            name: "image_generation".to_owned(),
            input: json!({}),
            output: None,
        }),
        "code_interpreter_call" => ResponseItem::Hosted(ResponseHosted {
            id: item_id(item),
            name: "code_interpreter".to_owned(),
            input: json!({
                "code":item.get("code").cloned().unwrap_or(Value::String(String::new())),
                "containerId":item.get("container_id").cloned().unwrap_or(Value::Null),
            }),
            output: None,
        }),
        _ => ResponseItem::Ignored,
    }
}

fn update_response_item(state: &mut ResponseItem, item: &Value) {
    match state {
        ResponseItem::Text(text) => {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                text.id = id.to_owned();
            }
            if let Some(phase) = item.get("phase").filter(|value| !value.is_null()) {
                text.phase = Some(phase.clone());
            }
            if text.text.is_empty() {
                if let Some(content) = item.get("content").and_then(Value::as_array) {
                    for part in content {
                        if part.get("type").and_then(Value::as_str) == Some("output_text") {
                            if let Some(value) = part.get("text").and_then(Value::as_str) {
                                text.text.push_str(value);
                            }
                        }
                    }
                }
            }
        }
        ResponseItem::Reasoning(reasoning) => {
            if let Some(value) = item.get("encrypted_content").and_then(Value::as_str) {
                reasoning.encrypted_content = Some(value.to_owned());
            }
            if reasoning.summaries.values().all(String::is_empty) {
                if let Some(summaries) = item.get("summary").and_then(Value::as_array) {
                    for (index, summary) in summaries.iter().enumerate() {
                        if let Some(value) = summary.get("text").and_then(Value::as_str) {
                            reasoning.summaries.insert(index as u64, value.to_owned());
                        }
                    }
                }
            }
        }
        ResponseItem::Function(function) => {
            if let Some(value) = item.get("id").and_then(Value::as_str) {
                function.id = value.to_owned();
            }
            if let Some(value) = item.get("call_id").and_then(Value::as_str) {
                function.call_id = value.to_owned();
            }
            if let Some(value) = item.get("name").and_then(Value::as_str) {
                function.name = value.to_owned();
            }
            if let Some(value) = item.get("arguments").and_then(Value::as_str) {
                function.arguments = value.to_owned();
            }
            if let Some(value) = item.get("namespace").and_then(Value::as_str) {
                function.namespace = Some(value.to_owned());
            }
        }
        ResponseItem::Hosted(hosted) => match hosted.name.as_str() {
            "web_search" => hosted.output = Some(map_web_search_output(item.get("action"))),
            "image_generation" => {
                hosted.output = Some(json!({
                    "result":item.get("result").cloned().unwrap_or(Value::Null),
                }));
            }
            "code_interpreter" => {
                hosted.input = json!({
                    "code":item.get("code").cloned().unwrap_or(Value::String(String::new())),
                    "containerId":item.get("container_id").cloned().unwrap_or(Value::Null),
                });
                hosted.output = Some(json!({
                    "outputs":item.get("outputs").cloned().unwrap_or_else(|| json!([])),
                }));
            }
            _ => {}
        },
        ResponseItem::Ignored => {
            let replacement = response_item_from_added(item);
            if !matches!(replacement, ResponseItem::Ignored) {
                *state = replacement;
                update_response_item(state, item);
            }
        }
    }
}

fn response_item_by_id_mut<'a>(
    items: &'a mut BTreeMap<u64, ResponseItem>,
    id: &str,
) -> Option<&'a mut ResponseItem> {
    items.values_mut().find(|item| match item {
        ResponseItem::Text(item) => item.id == id,
        ResponseItem::Reasoning(item) => item.id == id,
        ResponseItem::Function(item) => item.id == id || item.call_id == id,
        ResponseItem::Hosted(item) => item.id == id,
        ResponseItem::Ignored => false,
    })
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn map_web_search_output(action: Option<&Value>) -> Value {
    let Some(action) = action else {
        return json!({});
    };
    match action.get("type").and_then(Value::as_str) {
        Some("search") => {
            let mut output = json!({"action":{"type":"search"}});
            if let Some(query) = action.get("query") {
                output["action"]["query"] = query.clone();
            }
            if let Some(queries) = action.get("queries") {
                output["action"]["queries"] = queries.clone();
            }
            if let Some(sources) = action.get("sources") {
                output["sources"] = sources.clone();
            }
            output
        }
        Some("open_page") => json!({
            "action":{"type":"openPage","url":action.get("url").cloned().unwrap_or(Value::Null)},
        }),
        Some("find_in_page") => json!({
            "action":{
                "type":"findInPage",
                "url":action.get("url").cloned().unwrap_or(Value::Null),
                "pattern":action.get("pattern").cloned().unwrap_or(Value::Null),
            },
        }),
        _ => json!({}),
    }
}

fn parse_tool_input(arguments: &str) -> Result<Value, DriverFailure> {
    if arguments.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(arguments)
        .map_err(|_| DriverFailure::fatal("language model returned invalid tool arguments"))
}

fn event_error_message(event: &Value) -> Option<String> {
    event
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| event.get("message").and_then(Value::as_str))
        .map(str::to_owned)
}

fn is_cancelled(control: &AgentRunControl) -> bool {
    !matches!(
        control.directive(),
        crate::agent::AgentRunDirective::Continue
    )
}

fn model_message_error(error: ModelMessageError) -> AgentModelError {
    AgentModelError::new(error.message(), false)
}

fn transport_model_error(
    error: &OpenAiTransportError,
    endpoint: &LanguageModelEndpoint,
) -> AgentModelError {
    AgentModelError::new(error.message(), error.is_retryable())
        .sanitized_with_secret(Some(endpoint.api_key.expose_secret()))
}

fn validate_schema(value: &Value, schema: &Value) -> Result<(), String> {
    if let Some(types) = schema.get("type") {
        let matches = match types {
            Value::String(kind) => value_matches_type(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| value_matches_type(value, kind)),
            _ => false,
        };
        if !matches {
            return Err("language model returned tool input with an invalid type".to_owned());
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err("language model returned tool input outside the allowed enum".to_owned());
        }
    }
    if let (Some(object), Some(required)) = (
        value.as_object(),
        schema.get("required").and_then(Value::as_array),
    ) {
        for field in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(field) {
                return Err("language model omitted a required tool input field".to_owned());
            }
        }
    }
    if let Some(object) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false)
            && object
                .keys()
                .any(|key| properties.is_none_or(|properties| !properties.contains_key(key)))
        {
            return Err("language model returned an unknown tool input field".to_owned());
        }
        if let Some(properties) = properties {
            for (key, property_schema) in properties {
                if let Some(value) = object.get(key) {
                    validate_schema(value, property_schema)?;
                }
            }
        }
    }
    if let Some(array) = value.as_array() {
        if let Some(items) = schema.get("items") {
            for item in array {
                validate_schema(item, items)?;
            }
        }
    }
    if let Some(value) = value.as_str() {
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| value.chars().count() < minimum as usize)
        {
            return Err("language model returned a tool string that is too short".to_owned());
        }
        if schema
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| value.chars().count() > maximum as usize)
        {
            return Err("language model returned a tool string that is too long".to_owned());
        }
    }
    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|minimum| number < minimum)
            || schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|maximum| number > maximum)
        {
            return Err(
                "language model returned a tool number outside the allowed range".to_owned(),
            );
        }
    }
    Ok(())
}

fn value_matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value.as_f64().is_some_and(|value| value.fract() == 0.0)
        }
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::agent::{AgentPortError, AgentStopReason};

    use super::*;

    #[derive(Default)]
    struct TestTools {
        confirmation_required: bool,
        executions: Mutex<Vec<(AgentToolCall, ToolAuthorization)>>,
    }

    #[async_trait]
    impl AgentToolExecutor for TestTools {
        fn definitions(&self) -> Vec<AgentToolDefinition> {
            vec![local_definition(self.confirmation_required)]
        }

        fn requires_confirmation(&self, tool_name: &str, _input: &Value) -> bool {
            self.confirmation_required && tool_name == "echo"
        }

        async fn execute(
            &self,
            call: AgentToolCall,
            authorization: ToolAuthorization,
        ) -> Result<AgentToolOutput, AgentPortError> {
            self.executions
                .lock()
                .expect("execution lock")
                .push((call.clone(), authorization));
            Ok(AgentToolOutput {
                value: json!({"echo":call.input.get("value").cloned().unwrap_or(Value::Null)}),
                is_error: false,
                terminal_tool: false,
                terminal_failed: false,
            })
        }
    }

    fn local_definition(confirmation_required: bool) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "echo".to_owned(),
            description: "Echo one value.".to_owned(),
            input_schema: json!({
                "type":"object",
                "required":["value"],
                "properties":{"value":{"type":"string"}},
                "additionalProperties":false,
            }),
            execution: ToolExecutionKind::Local,
            requires_confirmation: confirmation_required,
        }
    }

    struct ScriptedResponse {
        status: u16,
        content_type: &'static str,
        body: String,
        retry_after: Option<u64>,
    }

    impl ScriptedResponse {
        fn sse(events: impl IntoIterator<Item = Value>) -> Self {
            let mut body = String::new();
            for event in events {
                body.push_str("data: ");
                body.push_str(&serde_json::to_string(&event).expect("serialize SSE event"));
                body.push_str("\n\n");
            }
            body.push_str("data: [DONE]\n\n");
            Self {
                status: 200,
                content_type: "text/event-stream",
                body,
                retry_after: None,
            }
        }

        fn json(status: u16, body: Value) -> Self {
            Self {
                status,
                content_type: "application/json",
                body: serde_json::to_string(&body).expect("serialize JSON response"),
                retry_after: None,
            }
        }
    }

    async fn scripted_server(
        responses: Vec<ScriptedResponse>,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind scripted provider");
        let address = listener.local_addr().expect("provider address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.expect("accept provider request");
                let request = read_http_request(&mut stream).await;
                captured.lock().expect("request lock").push(request);
                let reason = match response.status {
                    200 => "OK",
                    429 => "Too Many Requests",
                    _ => "Error",
                };
                let retry_after = response
                    .retry_after
                    .map_or_else(String::new, |seconds| format!("Retry-After: {seconds}\r\n"));
                let head = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                    response.status,
                    reason,
                    response.content_type,
                    response.body.len(),
                    retry_after,
                );
                stream.write_all(head.as_bytes()).await.expect("write head");
                stream
                    .write_all(response.body.as_bytes())
                    .await
                    .expect("write body");
            }
        });
        (format!("http://{address}/v1"), requests, task)
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let mut expected_len = None;
        loop {
            let read = stream
                .read(&mut buffer)
                .await
                .expect("read provider request");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if expected_len.is_none() {
                if let Some(header_end) = find_bytes(&request, b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':').and_then(|(name, value)| {
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                        })
                        .unwrap_or(0);
                    expected_len = Some(header_end + 4 + content_length);
                }
            }
            if expected_len.is_some_and(|expected| request.len() >= expected) {
                break;
            }
        }
        String::from_utf8(request).expect("UTF-8 test request")
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn request_json(request: &str) -> Value {
        let (_, body) = request.split_once("\r\n\r\n").expect("request body");
        serde_json::from_str(body).expect("request JSON")
    }

    async fn collect_stream(mut stream: Box<dyn AgentStream>) -> Vec<AgentStreamPart> {
        let mut parts = Vec::new();
        while let Some(part) = stream.next_part().await.expect("stream part") {
            parts.push(part);
        }
        parts
    }

    #[tokio::test]
    async fn chat_stream_executes_tools_and_persists_cumulative_multi_step_messages() {
        let first = ScriptedResponse::sse([
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\"value\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"one\"}"}}]},"finish_reason":"tool_calls"}]}),
        ]);
        let second = ScriptedResponse::sse([
            json!({"choices":[{"delta":{"reasoning_content":"checked "}}]}),
            json!({"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}),
        ]);
        let (base_url, requests, server) = scripted_server(vec![first, second]).await;
        let endpoint = local_endpoint(
            LanguageModelEndpointKind::ChatCompletions,
            "model",
            &base_url,
        );
        let tools = Arc::new(TestTools::default());
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: "system".to_owned(),
            messages: vec![json!({"role":"user","content":"use echo"})],
            tools: tools.definitions(),
            max_steps: 4,
            max_retries: 0,
            responses_store: false,
            control: AgentRunControl::default(),
        };
        let stream = OpenAiAgentModelDriver::default()
            .start_turn(request, tools.clone())
            .await
            .expect("start turn");
        let parts = collect_stream(stream).await;
        server.await.expect("provider server");

        let step_messages = parts
            .iter()
            .filter_map(|part| match part {
                AgentStreamPart::StepFinished { response_messages } => {
                    Some(response_messages.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(step_messages.len(), 2);
        assert_eq!(step_messages[0].len(), 2);
        assert_eq!(step_messages[1].len(), 3);
        assert_eq!(step_messages[0][0]["content"][0]["toolCallId"], "call_1");
        assert_eq!(step_messages[0][1]["content"][0]["output"]["type"], "json");
        assert_eq!(tools.executions.lock().expect("execution lock").len(), 1);

        let captured = requests.lock().expect("request lock");
        assert_eq!(captured.len(), 2);
        assert!(captured[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer secret"));
        let second_body = request_json(&captured[1]);
        assert_eq!(second_body["messages"][2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(second_body["messages"][3]["tool_call_id"], "call_1");
    }

    #[tokio::test]
    async fn responses_stream_persists_reasoning_metadata_and_hosted_tool_results() {
        let response = ScriptedResponse::sse([
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":null,"summary":[]}}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"analysis"}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"ciphertext","summary":[{"type":"summary_text","text":"analysis"}]}}),
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","phase":"final_answer","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"answer"}),
            json!({"type":"response.output_text.annotation.added","item_id":"msg_1","output_index":1,"content_index":0,"annotation":{"type":"url_citation","url":"https://example.test","title":"Example","start_index":0,"end_index":6}}),
            json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","phase":"final_answer","content":[{"type":"output_text","text":"answer","annotations":[]}]}}),
            json!({"type":"response.output_item.added","output_index":2,"item":{"type":"image_generation_call","id":"ig_1","status":"in_progress"}}),
            json!({"type":"response.output_item.done","output_index":2,"item":{"type":"image_generation_call","id":"ig_1","status":"completed","result":"image-base64"}}),
            json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{}}}),
        ]);
        let (base_url, requests, server) = scripted_server(vec![response]).await;
        let endpoint = local_endpoint(LanguageModelEndpointKind::Responses, "gpt-5.4", &base_url);
        let tools: Arc<dyn AgentToolExecutor> = Arc::new(TestTools::default());
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: "system".to_owned(),
            messages: vec![json!({"role":"user","content":"make image"})],
            tools: vec![AgentToolDefinition {
                name: "image_generation".to_owned(),
                description: "image".to_owned(),
                input_schema: json!({"type":"object"}),
                execution: ToolExecutionKind::ProviderHosted,
                requires_confirmation: false,
            }],
            max_steps: 4,
            max_retries: 0,
            responses_store: false,
            control: AgentRunControl::default(),
        };
        let stream = OpenAiAgentModelDriver::default()
            .start_turn(request, tools)
            .await
            .expect("start turn");
        let parts = collect_stream(stream).await;
        server.await.expect("provider server");
        let messages = parts
            .iter()
            .find_map(|part| match part {
                AgentStreamPart::StepFinished { response_messages } => Some(response_messages),
                _ => None,
            })
            .expect("step messages");
        let content = messages[0]["content"]
            .as_array()
            .expect("assistant content");
        assert_eq!(content[0]["providerOptions"]["openai"]["itemId"], "rs_1");
        assert_eq!(
            content[0]["providerOptions"]["openai"]["reasoningEncryptedContent"],
            "ciphertext"
        );
        assert_eq!(content[1]["providerOptions"]["openai"]["itemId"], "msg_1");
        assert_eq!(
            content[1]["providerOptions"]["openai"]["annotations"][0]["url"],
            "https://example.test"
        );
        assert_eq!(content[2]["providerExecuted"], true);
        assert_eq!(content[3]["output"]["value"]["result"], "image-base64");
        assert!(parts
            .iter()
            .any(|part| matches!(part, AgentStreamPart::ToolResult { .. })));

        let captured = requests.lock().expect("request lock");
        let body = request_json(&captured[0]);
        assert_eq!(body["store"], false);
        assert_eq!(body["tools"][0]["type"], "image_generation");
        assert!(body["include"]
            .as_array()
            .expect("include array")
            .contains(&json!("reasoning.encrypted_content")));
    }

    #[tokio::test]
    async fn denied_approval_becomes_a_tool_result_without_execution() {
        let response = ScriptedResponse::sse([
            json!({"choices":[{"delta":{"content":"understood"},"finish_reason":"stop"}]}),
        ]);
        let (base_url, requests, server) = scripted_server(vec![response]).await;
        let endpoint = local_endpoint(
            LanguageModelEndpointKind::ChatCompletions,
            "model",
            &base_url,
        );
        let tools = Arc::new(TestTools {
            confirmation_required: true,
            ..TestTools::default()
        });
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: String::new(),
            messages: vec![
                json!({"role":"assistant","content":[
                    {"type":"tool-call","toolCallId":"call_1","toolName":"echo","input":{"value":"blocked"}},
                    {"type":"tool-approval-request","approvalId":"approval_1","toolCallId":"call_1"}
                ]}),
                json!({"role":"tool","content":[
                    {"type":"tool-approval-response","approvalId":"approval_1","approved":false,"reason":"not now"}
                ]}),
            ],
            tools: tools.definitions(),
            max_steps: 1,
            max_retries: 0,
            responses_store: false,
            control: AgentRunControl::default(),
        };
        let stream = OpenAiAgentModelDriver::default()
            .start_turn(request, tools.clone())
            .await
            .expect("start turn");
        let parts = collect_stream(stream).await;
        server.await.expect("provider server");
        assert!(tools.executions.lock().expect("execution lock").is_empty());
        assert!(parts
            .iter()
            .any(|part| matches!(part, AgentStreamPart::ToolOutputDenied { .. })));
        let messages = parts
            .iter()
            .find_map(|part| match part {
                AgentStreamPart::StepFinished { response_messages } => Some(response_messages),
                _ => None,
            })
            .expect("step messages");
        assert_eq!(
            messages[0]["content"][0]["output"]["type"],
            "execution-denied"
        );
        assert_eq!(messages[0]["content"][0]["output"]["reason"], "not now");

        let captured = requests.lock().expect("request lock");
        let body = request_json(&captured[0]);
        assert_eq!(body["messages"][1]["content"], "not now");
    }

    #[tokio::test]
    async fn approved_tool_is_revalidated_executed_once_and_added_before_the_next_step() {
        let response = ScriptedResponse::sse([
            json!({"choices":[{"delta":{"content":"completed"},"finish_reason":"stop"}]}),
        ]);
        let (base_url, requests, server) = scripted_server(vec![response]).await;
        let endpoint = local_endpoint(
            LanguageModelEndpointKind::ChatCompletions,
            "model",
            &base_url,
        );
        let tools = Arc::new(TestTools {
            confirmation_required: true,
            ..TestTools::default()
        });
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: String::new(),
            messages: vec![
                json!({"role":"assistant","content":[
                    {"type":"tool-call","toolCallId":"call_1","toolName":"echo","input":{"value":"approved"}},
                    {"type":"tool-approval-request","approvalId":"approval_1","toolCallId":"call_1"}
                ]}),
                json!({"role":"tool","content":[
                    {"type":"tool-approval-response","approvalId":"approval_1","approved":true}
                ]}),
            ],
            tools: tools.definitions(),
            max_steps: 1,
            max_retries: 0,
            responses_store: false,
            control: AgentRunControl::default(),
        };
        let stream = OpenAiAgentModelDriver::default()
            .start_turn(request, tools.clone())
            .await
            .expect("start turn");
        let parts = collect_stream(stream).await;
        server.await.expect("provider server");

        let executions = tools.executions.lock().expect("execution lock");
        assert_eq!(executions.len(), 1);
        assert!(matches!(
            &executions[0].1,
            ToolAuthorization::Approved { confirmation_id } if confirmation_id == "approval_1"
        ));
        drop(executions);
        let messages = parts
            .iter()
            .find_map(|part| match part {
                AgentStreamPart::StepFinished { response_messages } => Some(response_messages),
                _ => None,
            })
            .expect("step messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "tool");
        assert_eq!(messages[0]["content"][0]["toolCallId"], "call_1");
        assert_eq!(messages[1]["role"], "assistant");

        let captured = requests.lock().expect("request lock");
        let body = request_json(&captured[0]);
        assert_eq!(body["messages"][1]["content"], "{\"echo\":\"approved\"}");
    }

    #[tokio::test]
    async fn model_requests_retry_retryable_status_before_exposing_output() {
        let mut retry = ScriptedResponse::json(429, json!({"error":{"message":"busy"}}));
        retry.retry_after = Some(0);
        let success = ScriptedResponse::json(
            200,
            json!({"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}),
        );
        let (base_url, requests, server) = scripted_server(vec![retry, success]).await;
        let endpoint = local_endpoint(
            LanguageModelEndpointKind::ChatCompletions,
            "model",
            &base_url,
        );
        let mut request = TextGenerationRequest::from_prompt(endpoint, "hello");
        request.max_retries = 1;
        let text = OpenAiAgentModelDriver::default()
            .generate_text(request)
            .await
            .expect("retried generation");
        server.await.expect("provider server");
        assert_eq!(text, "ok");
        assert_eq!(requests.lock().expect("request lock").len(), 2);
    }

    #[tokio::test]
    async fn agent_control_cancels_a_request_waiting_for_response_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind hanging provider");
        let address = listener.local_addr().expect("provider address");
        let (accepted_sender, accepted_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept request");
            let _ = accepted_sender.send(());
            let _ = release_receiver.await;
        });
        let base_url = format!("http://{address}/v1");
        let endpoint = local_endpoint(
            LanguageModelEndpointKind::ChatCompletions,
            "model",
            &base_url,
        );
        let control = AgentRunControl::default();
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: String::new(),
            messages: vec![json!({"role":"user","content":"wait"})],
            tools: Vec::new(),
            max_steps: 1,
            max_retries: 0,
            responses_store: false,
            control: control.clone(),
        };
        let mut stream = OpenAiAgentModelDriver::default()
            .start_turn(request, Arc::new(TestTools::default()))
            .await
            .expect("start turn");
        accepted_receiver.await.expect("request accepted");
        control.request_stop(AgentStopReason::Manual);
        let part = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next_part())
            .await
            .expect("cancel timeout")
            .expect("cancel stream")
            .expect("abort part");
        assert!(matches!(part, AgentStreamPart::Abort));
        let _ = release_sender.send(());
        server.await.expect("hanging provider server");
    }

    #[test]
    fn responses_wire_is_stateless_and_requests_hosted_outputs() {
        let endpoint = endpoint(LanguageModelEndpointKind::Responses, "gpt-5.4");
        let request = ModelTurnRequest {
            endpoint,
            system_prompt: "system".to_owned(),
            messages: vec![json!({"role":"user","content":"hello"})],
            tools: vec![AgentToolDefinition {
                name: "code_interpreter".to_owned(),
                description: "code".to_owned(),
                input_schema: json!({"type":"object"}),
                execution: ToolExecutionKind::ProviderHosted,
                requires_confirmation: false,
            }],
            max_steps: 2,
            max_retries: 3,
            responses_store: false,
            control: AgentRunControl::default(),
        };
        let body = streaming_body(&request, &request.messages).unwrap();
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert!(body["include"]
            .as_array()
            .unwrap()
            .contains(&json!("reasoning.encrypted_content")));
        assert!(body["include"]
            .as_array()
            .unwrap()
            .contains(&json!("code_interpreter_call.outputs")));
        assert_eq!(body["tools"][0]["container"]["type"], "auto");
    }

    #[test]
    fn collect_approval_response_once_and_skip_completed_calls() {
        let messages = vec![
            json!({"role":"assistant","content":[
                {"type":"tool-call","toolCallId":"c1","toolName":"send_input","input":{"text":"x"}},
                {"type":"tool-approval-request","approvalId":"a1","toolCallId":"c1"},
                {"type":"tool-call","toolCallId":"c2","toolName":"send_input","input":{"text":"y"}},
                {"type":"tool-approval-request","approvalId":"a2","toolCallId":"c2"}
            ]}),
            json!({"role":"tool","content":[
                {"type":"tool-approval-response","approvalId":"a1","approved":false,"reason":"no"},
                {"type":"tool-approval-response","approvalId":"a1","approved":false,"reason":"duplicate"},
                {"type":"tool-approval-response","approvalId":"a2","approved":true},
                {"type":"tool-result","toolCallId":"c2","toolName":"send_input","output":{"type":"text","value":"done"}}
            ]}),
        ];
        let actions = collect_local_approval_actions(&messages).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].approval_id, "a1");
        assert!(!actions[0].approved);
        assert_eq!(actions[0].reason.as_deref(), Some("no"));
    }

    #[test]
    fn structured_generation_matches_each_provider_response_format() {
        let schema = JsonResponseFormat {
            name: "watch_judge".to_owned(),
            description: None,
            schema: json!({"type":"object"}),
        };
        let chat = TextGenerationRequest::from_prompt(
            endpoint(LanguageModelEndpointKind::ChatCompletions, "model"),
            "prompt",
        );
        let chat_body = generation_body(&chat, Some(&schema)).unwrap();
        assert_eq!(chat_body["response_format"]["type"], "json_object");
        let responses = TextGenerationRequest::from_prompt(
            endpoint(LanguageModelEndpointKind::Responses, "gpt-5.4"),
            "prompt",
        );
        let responses_body = generation_body(&responses, Some(&schema)).unwrap();
        assert_eq!(responses_body["store"], false);
        assert_eq!(responses_body["text"]["format"]["strict"], true);
    }

    #[test]
    fn non_stream_text_extraction_matches_both_provider_response_shapes() {
        let chat = generation_text(
            LanguageModelEndpointKind::ChatCompletions,
            &json!({
                "choices":[{"message":{"role":"assistant","content":"chat text"}}]
            }),
        )
        .expect("chat text");
        assert_eq!(chat, "chat text");

        let responses = generation_text(
            LanguageModelEndpointKind::Responses,
            &json!({
                "output":[
                    {"type":"reasoning","id":"rs_1","summary":[]},
                    {"type":"message","id":"msg_1","content":[
                        {"type":"output_text","text":"response "},
                        {"type":"refusal","refusal":"ignored"},
                        {"type":"output_text","text":"text"}
                    ]}
                ]
            }),
        )
        .expect("responses text");
        assert_eq!(responses, "response text");
    }

    fn endpoint(kind: LanguageModelEndpointKind, model_id: &str) -> LanguageModelEndpoint {
        let base_url = "https://example.test/v1".to_owned();
        LanguageModelEndpoint {
            provider_id: "provider".to_owned(),
            provider_name: "provider".to_owned(),
            model_id: model_id.to_owned(),
            kind,
            endpoint_url: format!(
                "{base_url}{}",
                match kind {
                    LanguageModelEndpointKind::ChatCompletions => "/chat/completions",
                    LanguageModelEndpointKind::Responses => "/responses",
                }
            ),
            base_url,
            api_key: super::super::SecretString::new("secret"),
        }
    }

    fn local_endpoint(
        kind: LanguageModelEndpointKind,
        model_id: &str,
        base_url: &str,
    ) -> LanguageModelEndpoint {
        let suffix = match kind {
            LanguageModelEndpointKind::ChatCompletions => "/chat/completions",
            LanguageModelEndpointKind::Responses => "/responses",
        };
        LanguageModelEndpoint {
            provider_id: "provider".to_owned(),
            provider_name: "provider".to_owned(),
            model_id: model_id.to_owned(),
            kind,
            base_url: base_url.to_owned(),
            endpoint_url: format!("{base_url}{suffix}"),
            api_key: super::super::SecretString::new("secret"),
        }
    }
}
