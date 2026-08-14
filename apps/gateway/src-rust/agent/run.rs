use std::collections::HashMap;
use std::future::pending;
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::time::Instant;

use crate::database::repository::{AgentSessionUpdate, CreateAgentConfirmationInput};
use crate::entity::{agent_messages, agent_sessions};

use super::{
    build_agent_system_prompt, build_title_generation_prompt, redact_json_strings,
    redact_outbound_messages, redact_secrets, AgentClock, AgentEnvironmentSource, AgentError,
    AgentEvent, AgentEventEnvelope, AgentEventSink, AgentModelError, AgentNotification,
    AgentNotificationSink, AgentNotificationTranslation, AgentProviderResolver, AgentRunConfig,
    AgentRunControl, AgentRunDirective, AgentRunLauncher, AgentRunOutcome, AgentStopReason,
    AgentSystemPromptContext, AgentToolFactory, AgentToolSession, AgentWriteMode, ModelTurnRequest,
    PendingConfirmation, DEFAULT_AGENT_SESSION_TITLE,
};
use crate::agent::{AgentStore, AgentStreamPart};

const TERMINAL_FAILURE_LIMIT: usize = 2;
const EVENT_STREAM_HOLD_MAX_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct AgentSessionCoordinator {
    locks: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

impl AgentSessionCoordinator {
    pub fn session_lock(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(session_id.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

pub struct AgentRunDependencies {
    pub store: Arc<dyn AgentStore>,
    pub providers: Arc<dyn AgentProviderResolver>,
    pub model: Arc<dyn super::AgentModelDriver>,
    pub tools: Arc<dyn AgentToolFactory>,
    pub environment: Arc<dyn AgentEnvironmentSource>,
    pub events: Arc<dyn AgentEventSink>,
    pub notifications: Arc<dyn AgentNotificationSink>,
    pub clock: Arc<dyn AgentClock>,
    pub coordinator: Arc<AgentSessionCoordinator>,
}

#[derive(Clone, Default)]
struct InProgressTurn {
    text: String,
    reasoning: String,
}

pub struct AgentRunService {
    dependencies: AgentRunDependencies,
    config: AgentRunConfig,
    in_progress: Arc<Mutex<HashMap<String, InProgressTurn>>>,
}

impl AgentRunService {
    pub fn new(dependencies: AgentRunDependencies, config: AgentRunConfig) -> Self {
        Self {
            dependencies,
            config,
            in_progress: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn coordinator(&self) -> Arc<AgentSessionCoordinator> {
        self.dependencies.coordinator.clone()
    }

    async fn run_session(
        &self,
        session_id: String,
        control: AgentRunControl,
    ) -> Result<AgentRunOutcome, AgentError> {
        let Some(mut session) = self.dependencies.store.get_session(&session_id).await? else {
            return Err(AgentError::SessionNotFound);
        };
        let mut worker = RunWorker {
            service: self,
            session_id,
            control,
            event_seq: 0,
            text_buffer: String::new(),
            reasoning_buffer: String::new(),
            pending_text: EventDeltaBuffer::default(),
            pending_reasoning: EventDeltaBuffer::default(),
            terminal_failure_streak: 0,
            terminal_fatal: None,
        };
        worker.set_status("running", None).await?;
        worker.drain_queue().await?;

        let endpoint = match self
            .dependencies
            .providers
            .resolve_endpoint(session.provider_id.as_deref(), Some(&session.model_id))
            .await
        {
            Ok(endpoint) => endpoint,
            Err(error) => {
                return worker.finish_error(&session, &error.to_string()).await;
            }
        };
        let tool_session = match self.dependencies.tools.create(&session, &endpoint).await {
            Ok(tools) => tools,
            Err(error) => return worker.finish_error(&session, error.message()).await,
        };

        let outcome = worker
            .execute_loop(&mut session, endpoint, tool_session.as_ref())
            .await;
        tool_session.close().await;
        self.in_progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&worker.session_id);
        outcome
    }
}

#[async_trait]
impl AgentRunLauncher for AgentRunService {
    async fn run(
        &self,
        session_id: String,
        control: AgentRunControl,
    ) -> Result<AgentRunOutcome, AgentError> {
        self.run_session(session_id, control).await
    }

    fn in_progress(&self, session_id: &str) -> (String, String) {
        self.in_progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .map(|progress| {
                (
                    redact_secrets(&progress.text).text,
                    redact_secrets(&progress.reasoning).text,
                )
            })
            .unwrap_or_default()
    }
}

enum RunOnceResult {
    Steer,
    Finished(AgentRunOutcome),
}

struct RunWorker<'a> {
    service: &'a AgentRunService,
    session_id: String,
    control: AgentRunControl,
    event_seq: u64,
    text_buffer: String,
    reasoning_buffer: String,
    pending_text: EventDeltaBuffer,
    pending_reasoning: EventDeltaBuffer,
    terminal_failure_streak: usize,
    terminal_fatal: Option<String>,
}

impl RunWorker<'_> {
    async fn execute_loop(
        &mut self,
        session: &mut agent_sessions::Model,
        endpoint: crate::llm::LanguageModelEndpoint,
        tool_session: &dyn AgentToolSession,
    ) -> Result<AgentRunOutcome, AgentError> {
        let mut attempt = 0usize;
        loop {
            match self.control.directive() {
                AgentRunDirective::Stop(reason) => {
                    return self.finish_stopped(session, reason).await
                }
                AgentRunDirective::Steer => self.control.clear_steer(),
                AgentRunDirective::Continue => {}
            }
            let result = self.run_once(session, endpoint.clone(), tool_session).await;
            match result {
                Ok(RunOnceResult::Steer) => {
                    attempt = 0;
                    self.control.clear_steer();
                    self.drain_queue().await?;
                }
                Ok(RunOnceResult::Finished(outcome)) => return Ok(outcome),
                Err(AgentError::Model(error))
                    if error.is_retryable() && attempt < self.service.config.retry_delays.len() =>
                {
                    let delay = self.service.config.retry_delays[attempt];
                    attempt += 1;
                    self.service.dependencies.clock.sleep(delay).await;
                }
                Err(error) => {
                    let message = match &error {
                        AgentError::Model(error) => error.message(),
                        AgentError::Port(error) => error.message(),
                        _ => "agent turn failed",
                    };
                    return self.finish_error(session, message).await;
                }
            }
        }
    }

    async fn run_once(
        &mut self,
        session: &mut agent_sessions::Model,
        endpoint: crate::llm::LanguageModelEndpoint,
        tool_session: &dyn AgentToolSession,
    ) -> Result<RunOnceResult, AgentError> {
        let messages = self
            .service
            .dependencies
            .store
            .list_messages(&self.session_id)
            .await?;
        let messages = parse_message_values(&messages)?;
        let messages =
            apply_message_window(&messages, self.service.config.message_window_char_budget);
        let messages = redact_outbound_messages(&messages);
        let device = match session.device_id.as_deref() {
            Some(device_id) => {
                self.service
                    .dependencies
                    .store
                    .get_device(device_id)
                    .await?
            }
            None => None,
        };
        let environment = self
            .service
            .dependencies
            .environment
            .collect(device.as_ref())
            .await?;
        let write_mode =
            AgentWriteMode::parse(&session.write_mode).unwrap_or(AgentWriteMode::Confirm);
        let system_prompt = build_agent_system_prompt(AgentSystemPromptContext {
            pane_id: session.pane_id.as_deref(),
            write_mode,
            custom_system_prompt: session.system_prompt.as_deref(),
            environment: &environment,
        });
        let executor = tool_session.executor();
        let request = ModelTurnRequest {
            endpoint: endpoint.clone(),
            system_prompt,
            messages,
            tools: executor.definitions(),
            max_steps: super::validate_max_steps(session.max_steps_per_turn).unwrap_or(1),
            max_retries: self.service.config.llm_max_retries,
            responses_store: false,
            control: self.control.clone(),
        };
        let mut stream = self
            .service
            .dependencies
            .model
            .start_turn(request, executor)
            .await
            .map_err(|error| {
                AgentError::Model(
                    error.sanitized_with_secret(Some(endpoint.api_key.expose_secret())),
                )
            })?;

        self.reset_progress();
        let mut persisted_response_count = 0usize;
        let mut approvals = Vec::new();
        let mut aborted = false;
        let mut stream_error = None;
        let mut last_part_at = Instant::now();
        let mut flush_at: Option<Instant> = None;

        loop {
            let idle_deadline = last_part_at + self.service.config.stream_idle_timeout;
            let flush_deadline = flush_at;
            tokio::select! {
                directive = self.control.changed() => {
                    match directive {
                        AgentRunDirective::Steer | AgentRunDirective::Stop(_) => break,
                        AgentRunDirective::Continue => {}
                    }
                }
                _ = tokio::time::sleep_until(idle_deadline) => {
                    stream_error = Some(AgentModelError::new("language-model stream stalled", false));
                    break;
                }
                _ = async {
                    match flush_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => pending::<()>().await,
                    }
                } => {
                    self.flush_delta_events(false).await;
                    flush_at = self.has_pending_deltas().then(|| {
                        Instant::now() + self.service.config.delta_flush_interval
                    });
                }
                next = stream.next_part() => {
                    last_part_at = Instant::now();
                    let Some(part) = next.map_err(|error| {
                        AgentError::Model(error.sanitized_with_secret(Some(endpoint.api_key.expose_secret())))
                    })? else {
                        break;
                    };
                    match part {
                        AgentStreamPart::TextDelta { message_id, text } => {
                            self.text_buffer.push_str(&text);
                            let previous = self.pending_text.push(message_id, text);
                            if let Some((message_id, delta)) = previous {
                                self.emit(AgentEvent::TextDelta { message_id, delta }).await;
                            }
                            self.publish_progress();
                            flush_at.get_or_insert_with(|| Instant::now() + self.service.config.delta_flush_interval);
                            if self.pending_delta_bytes() >= self.service.config.delta_flush_max_bytes {
                                self.flush_delta_events(false).await;
                                flush_at = self.has_pending_deltas().then(|| Instant::now() + self.service.config.delta_flush_interval);
                            }
                        }
                        AgentStreamPart::ReasoningDelta { message_id, text } => {
                            self.reasoning_buffer.push_str(&text);
                            let previous = self.pending_reasoning.push(message_id, text);
                            if let Some((message_id, delta)) = previous {
                                self.emit(AgentEvent::ReasoningDelta { message_id, delta }).await;
                            }
                            self.publish_progress();
                            flush_at.get_or_insert_with(|| Instant::now() + self.service.config.delta_flush_interval);
                            if self.pending_delta_bytes() >= self.service.config.delta_flush_max_bytes {
                                self.flush_delta_events(false).await;
                                flush_at = self.has_pending_deltas().then(|| Instant::now() + self.service.config.delta_flush_interval);
                            }
                        }
                        AgentStreamPart::ToolCall(call) => {
                            self.flush_delta_events(false).await;
                            self.emit(AgentEvent::ToolCall {
                                tool_call_id: call.tool_call_id,
                                tool_name: call.tool_name,
                                input: redact_json_strings(&call.input),
                            }).await;
                        }
                        AgentStreamPart::ToolResult { call, output } => {
                            self.flush_delta_events(false).await;
                            if output.terminal_tool {
                                if output.terminal_failed {
                                    self.terminal_failure_streak += 1;
                                    if self.terminal_failure_streak >= TERMINAL_FAILURE_LIMIT {
                                        self.terminal_fatal = Some(format!(
                                            "terminal tool failed {} times in a row, aborting run",
                                            self.terminal_failure_streak
                                        ));
                                    }
                                } else {
                                    self.terminal_failure_streak = 0;
                                }
                            }
                            self.emit(AgentEvent::ToolResult {
                                tool_call_id: call.tool_call_id,
                                tool_name: call.tool_name,
                                output: redact_json_strings(&output.value),
                                is_error: output.is_error,
                            }).await;
                            if self.terminal_fatal.is_some() {
                                break;
                            }
                        }
                        AgentStreamPart::ToolError { call, message } => {
                            self.flush_delta_events(false).await;
                            if is_terminal_tool(&call.tool_name) {
                                self.terminal_failure_streak += 1;
                                if self.terminal_failure_streak >= TERMINAL_FAILURE_LIMIT {
                                    self.terminal_fatal = Some(format!(
                                        "terminal tool failed {} times in a row, aborting run",
                                        self.terminal_failure_streak
                                    ));
                                }
                            }
                            self.emit(AgentEvent::ToolResult {
                                tool_call_id: call.tool_call_id,
                                tool_name: call.tool_name,
                                output: json!(redact_secrets(&message).text),
                                is_error: true,
                            }).await;
                            if self.terminal_fatal.is_some() {
                                break;
                            }
                        }
                        AgentStreamPart::ToolOutputDenied { call } => {
                            self.flush_delta_events(false).await;
                            self.emit(AgentEvent::ToolResult {
                                tool_call_id: call.tool_call_id,
                                tool_name: call.tool_name,
                                output: json!("execution denied by user"),
                                is_error: true,
                            }).await;
                        }
                        AgentStreamPart::ApprovalRequest { approval_id, call } => {
                            approvals.push(PendingApproval {
                                approval_id,
                                tool_call_id: call.tool_call_id,
                                tool_name: call.tool_name,
                                input: call.input,
                            });
                        }
                        AgentStreamPart::StepFinished { response_messages } => {
                            for message in response_messages.iter().skip(persisted_response_count) {
                                let role = message.get("role").and_then(Value::as_str)
                                    .ok_or_else(|| AgentError::InvalidPersistedData("model response is missing role".to_owned()))?;
                                let record = self.service.dependencies.store
                                    .append_message(&self.session_id, role, message.clone()).await?;
                                self.emit(AgentEvent::MessagePersisted {
                                    message_id: record.id,
                                    seq: record.seq,
                                    role: record.role,
                                }).await;
                            }
                            persisted_response_count = response_messages.len();
                            self.flush_delta_events(true).await;
                            self.reset_progress();
                            if self.has_queued_messages().await? {
                                self.control.request_steer();
                            }
                            if tool_session.terminal_is_terminated().await {
                                self.terminal_fatal = Some("terminal connection lost during run".to_owned());
                                break;
                            }
                        }
                        AgentStreamPart::Error { message, retryable } => {
                            stream_error = Some(AgentModelError::new(message, retryable)
                                .sanitized_with_secret(Some(endpoint.api_key.expose_secret())));
                        }
                        AgentStreamPart::Abort => aborted = true,
                    }
                }
            }
        }

        self.flush_delta_events(true).await;
        if let Some(message) = self.terminal_fatal.clone() {
            return Ok(RunOnceResult::Finished(
                self.finish_error(session, &message).await?,
            ));
        }
        match self.control.directive() {
            AgentRunDirective::Stop(reason) => {
                return Ok(RunOnceResult::Finished(
                    self.finish_stopped(session, reason).await?,
                ));
            }
            AgentRunDirective::Steer => return Ok(RunOnceResult::Steer),
            AgentRunDirective::Continue => {}
        }
        if aborted {
            return Ok(RunOnceResult::Finished(
                self.finish_stopped(session, AgentStopReason::Manual)
                    .await?,
            ));
        }
        if let Some(error) = stream_error {
            return Err(AgentError::Model(error));
        }
        if !approvals.is_empty() {
            return Ok(RunOnceResult::Finished(
                self.finish_waiting_confirmation(session, approvals).await?,
            ));
        }
        if self.has_queued_messages().await? {
            return Ok(RunOnceResult::Steer);
        }

        self.maybe_generate_title(session, &endpoint).await;
        self.set_status("idle", None).await?;
        let last_message_seq = self
            .service
            .dependencies
            .store
            .max_message_seq(&self.session_id)
            .await?;
        self.emit(AgentEvent::TurnFinished {
            session_status: "idle".to_owned(),
            last_message_seq,
        })
        .await;
        if self.service.config.notify_turn_finished {
            let title = session.title.clone();
            self.notify(
                "agent_turn_finished",
                session,
                format!("Agent turn finished: {title}"),
                AgentNotificationTranslation::TurnFinished { title },
                None,
                None,
            )
            .await;
        }
        Ok(RunOnceResult::Finished(AgentRunOutcome::Idle))
    }

    async fn has_queued_messages(&self) -> Result<bool, AgentError> {
        Ok(!self
            .service
            .dependencies
            .store
            .list_queued_messages(&self.session_id)
            .await?
            .is_empty())
    }

    async fn drain_queue(&mut self) -> Result<(), AgentError> {
        let session_lock = self
            .service
            .dependencies
            .coordinator
            .session_lock(&self.session_id);
        let _guard = session_lock.lock().await;
        let records = self
            .service
            .dependencies
            .store
            .drain_queued_messages(&self.session_id)
            .await?;
        if records.is_empty() {
            return Ok(());
        }
        self.emit_with_seq(0, AgentEvent::QueueUpdated { queued: Vec::new() })
            .await;
        for record in records {
            self.emit(AgentEvent::MessagePersisted {
                message_id: record.id,
                seq: record.seq,
                role: record.role,
            })
            .await;
        }
        Ok(())
    }

    async fn finish_waiting_confirmation(
        &mut self,
        session: &agent_sessions::Model,
        approvals: Vec<PendingApproval>,
    ) -> Result<AgentRunOutcome, AgentError> {
        for approval in approvals {
            let confirmation = self
                .service
                .dependencies
                .store
                .create_confirmation(CreateAgentConfirmationInput {
                    id: Some(approval.approval_id),
                    session_id: self.session_id.clone(),
                    tool_name: approval.tool_name,
                    tool_call_id: approval.tool_call_id,
                    input_json: approval.input,
                })
                .await?;
            let input = serde_json::from_str(&confirmation.input_json).unwrap_or(Value::Null);
            self.emit(AgentEvent::ConfirmationRequest(PendingConfirmation {
                confirmation_id: confirmation.id.clone(),
                tool_call_id: confirmation.tool_call_id.clone(),
                tool_name: confirmation.tool_name.clone(),
                input: redact_json_strings(&input),
                created_at: confirmation.created_at.clone(),
            }))
            .await;
            let title = session.title.clone();
            let tool_name = confirmation.tool_name.clone();
            self.notify(
                "agent_confirmation_pending",
                session,
                format!("Agent confirmation pending: {tool_name}"),
                AgentNotificationTranslation::ConfirmationPending {
                    title,
                    tool_name: tool_name.clone(),
                },
                Some(confirmation.tool_name),
                Some(confirmation.id),
            )
            .await;
        }
        self.set_status("waiting_confirmation", None).await?;
        Ok(AgentRunOutcome::WaitingConfirmation)
    }

    async fn finish_stopped(
        &mut self,
        session: &agent_sessions::Model,
        reason: AgentStopReason,
    ) -> Result<AgentRunOutcome, AgentError> {
        self.persist_truncated_text().await;
        match reason {
            AgentStopReason::Shutdown => Ok(AgentRunOutcome::Interrupted),
            AgentStopReason::PaneLost => {
                self.finish_error(session, "terminal connection lost: pane/device unavailable")
                    .await
            }
            AgentStopReason::Manual => {
                self.set_status("stopped", None).await?;
                let last_message_seq = self
                    .service
                    .dependencies
                    .store
                    .max_message_seq(&self.session_id)
                    .await?;
                self.emit(AgentEvent::TurnFinished {
                    session_status: "stopped".to_owned(),
                    last_message_seq,
                })
                .await;
                Ok(AgentRunOutcome::Stopped)
            }
        }
    }

    async fn finish_error(
        &mut self,
        session: &agent_sessions::Model,
        message: &str,
    ) -> Result<AgentRunOutcome, AgentError> {
        self.persist_truncated_text().await;
        let message = redact_secrets(message).text;
        self.set_status("error", Some(message.clone())).await?;
        self.emit(AgentEvent::Error {
            message: message.clone(),
        })
        .await;
        self.notify(
            "agent_error",
            session,
            format!("Agent error: {message}"),
            AgentNotificationTranslation::Error {
                title: session.title.clone(),
                error: message.clone(),
            },
            None,
            None,
        )
        .await;
        Ok(AgentRunOutcome::Error)
    }

    async fn persist_truncated_text(&mut self) {
        if self.text_buffer.is_empty() {
            self.reasoning_buffer.clear();
            self.publish_progress();
            return;
        }
        if let Ok(record) = self
            .service
            .dependencies
            .store
            .append_message(
                &self.session_id,
                "assistant",
                json!({
                    "role":"assistant",
                    "content":[{"type":"text","text":self.text_buffer}],
                    "truncated":true,
                }),
            )
            .await
        {
            self.emit(AgentEvent::MessagePersisted {
                message_id: record.id,
                seq: record.seq,
                role: record.role,
            })
            .await;
        }
        self.reset_progress();
    }

    async fn maybe_generate_title(
        &mut self,
        session: &mut agent_sessions::Model,
        endpoint: &crate::llm::LanguageModelEndpoint,
    ) {
        if session.title != DEFAULT_AGENT_SESSION_TITLE {
            return;
        }
        let Ok(messages) = self
            .service
            .dependencies
            .store
            .list_messages(&self.session_id)
            .await
        else {
            return;
        };
        let Some(user_text) = messages
            .iter()
            .find(|message| message.role == "user")
            .and_then(|message| serde_json::from_str::<Value>(&message.content).ok())
            .and_then(|message| message_text(&message))
            .filter(|text| !text.trim().is_empty())
        else {
            return;
        };
        let Ok(raw) = self
            .service
            .dependencies
            .model
            .generate_title(endpoint, &build_title_generation_prompt(&user_text))
            .await
        else {
            return;
        };
        let title = truncate_utf16(
            raw.trim().trim_matches(|character| {
                matches!(character, '"' | '\'' | '「' | '」' | '『' | '』')
            }),
            80,
        );
        if title.is_empty() {
            return;
        }
        if self
            .service
            .dependencies
            .store
            .update_session(
                &self.session_id,
                AgentSessionUpdate {
                    title: Some(title.clone()),
                    ..AgentSessionUpdate::default()
                },
            )
            .await
            .is_ok()
        {
            session.title = title;
            self.emit(AgentEvent::Status {
                status: session.status.clone(),
                last_error: session.last_error.clone(),
            })
            .await;
        }
    }

    async fn set_status(
        &mut self,
        status: &str,
        last_error: Option<String>,
    ) -> Result<(), AgentError> {
        self.service
            .dependencies
            .store
            .update_session(
                &self.session_id,
                AgentSessionUpdate {
                    status: Some(status.to_owned()),
                    last_error: Some(last_error.clone()),
                    ..AgentSessionUpdate::default()
                },
            )
            .await?;
        self.emit(AgentEvent::Status {
            status: status.to_owned(),
            last_error,
        })
        .await;
        Ok(())
    }

    async fn notify(
        &self,
        event_type: &str,
        session: &agent_sessions::Model,
        message: String,
        translation: AgentNotificationTranslation,
        tool_name: Option<String>,
        confirmation_id: Option<String>,
    ) {
        let _ = self
            .service
            .dependencies
            .notifications
            .notify(AgentNotification {
                event_type: event_type.to_owned(),
                translation,
                session_id: self.session_id.clone(),
                session_title: session.title.clone(),
                device_id: session.device_id.clone(),
                pane_id: session.pane_id.clone(),
                message: redact_secrets(&message).text,
                tool_name,
                confirmation_id,
            })
            .await;
    }

    async fn emit(&mut self, event: AgentEvent) {
        self.event_seq = self.event_seq.saturating_add(1);
        self.emit_with_seq(self.event_seq, event).await;
    }

    async fn emit_with_seq(&self, seq: u64, event: AgentEvent) {
        let _ = self
            .service
            .dependencies
            .events
            .emit(AgentEventEnvelope {
                session_id: self.session_id.clone(),
                seq,
                event,
            })
            .await;
    }

    fn reset_progress(&mut self) {
        self.text_buffer.clear();
        self.reasoning_buffer.clear();
        self.pending_text.clear();
        self.pending_reasoning.clear();
        self.publish_progress();
    }

    fn publish_progress(&self) {
        self.service
            .in_progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                self.session_id.clone(),
                InProgressTurn {
                    text: self.text_buffer.clone(),
                    reasoning: self.reasoning_buffer.clone(),
                },
            );
    }

    fn has_pending_deltas(&self) -> bool {
        !self.pending_text.is_empty() || !self.pending_reasoning.is_empty()
    }

    fn pending_delta_bytes(&self) -> usize {
        self.pending_text.len() + self.pending_reasoning.len()
    }

    async fn flush_delta_events(&mut self, final_flush: bool) {
        if let Some((message_id, delta)) = self.pending_text.take_safe(final_flush) {
            self.emit(AgentEvent::TextDelta { message_id, delta }).await;
        }
        if let Some((message_id, delta)) = self.pending_reasoning.take_safe(final_flush) {
            self.emit(AgentEvent::ReasoningDelta { message_id, delta })
                .await;
        }
    }
}

#[derive(Default)]
struct EventDeltaBuffer {
    message_id: String,
    text: String,
}

impl EventDeltaBuffer {
    fn push(&mut self, message_id: String, text: String) -> Option<(String, String)> {
        let previous = if !self.text.is_empty() && self.message_id != message_id {
            self.take_before_message_change()
        } else {
            None
        };
        self.message_id = message_id;
        self.text.push_str(&text);
        previous
    }

    fn take_before_message_change(&mut self) -> Option<(String, String)> {
        let message_id = self.message_id.clone();
        let mut delta = self
            .take_safe(true)
            .map_or_else(String::new, |(_, delta)| delta);
        if !self.text.is_empty() {
            self.text.clear();
            delta.push_str("[REDACTED:stream-content]");
        }
        (!delta.is_empty()).then_some((message_id, delta))
    }

    fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    fn len(&self) -> usize {
        self.text.len()
    }

    fn clear(&mut self) {
        self.message_id.clear();
        self.text.clear();
    }

    fn take_safe(&mut self, final_flush: bool) -> Option<(String, String)> {
        if self.text.is_empty() {
            return None;
        }
        let mut cut = if final_flush {
            self.text.len()
        } else {
            self.text
                .char_indices()
                .rev()
                .find(|(_, character)| character.is_whitespace())
                .map_or(0, |(index, character)| index + character.len_utf8())
        };
        if let Some(begin) = self.text[..cut].rfind("-----BEGIN") {
            let after = &self.text[begin..];
            if !after.contains("-----END") {
                cut = begin;
            }
        }
        if cut == 0 {
            if self.text.len() <= EVENT_STREAM_HOLD_MAX_BYTES {
                return None;
            }
            let message_id = self.message_id.clone();
            self.text.clear();
            return Some((message_id, "[REDACTED:stream-content]".to_owned()));
        }
        let raw = self.text[..cut].to_owned();
        self.text.drain(..cut);
        let redacted = redact_secrets(&raw).text;
        (!redacted.is_empty()).then(|| (self.message_id.clone(), redacted))
    }
}

struct PendingApproval {
    approval_id: String,
    tool_call_id: String,
    tool_name: String,
    input: Value,
}

fn parse_message_values(messages: &[agent_messages::Model]) -> Result<Vec<Value>, AgentError> {
    messages
        .iter()
        .map(|message| {
            serde_json::from_str(&message.content).map_err(|_| {
                AgentError::InvalidPersistedData("invalid agent message JSON".to_owned())
            })
        })
        .collect()
}

pub fn apply_message_window(messages: &[Value], char_budget: usize) -> Vec<Value> {
    let sizes = messages
        .iter()
        .map(|message| {
            serde_json::to_string(message)
                .unwrap_or_default()
                .encode_utf16()
                .count()
        })
        .collect::<Vec<_>>();
    if sizes.iter().sum::<usize>() <= char_budget {
        return messages.to_vec();
    }
    let mut suffix_size = 0usize;
    let mut last_user = None;
    let mut best_user = None;
    for index in (0..messages.len()).rev() {
        suffix_size = suffix_size.saturating_add(sizes[index]);
        if messages[index].get("role").and_then(Value::as_str) == Some("user") {
            last_user.get_or_insert(index);
            if suffix_size <= char_budget {
                best_user = Some(index);
            }
        }
    }
    let Some(start) = best_user.or(last_user) else {
        return messages.to_vec();
    };
    messages[start..].to_vec()
}

fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut units = 0usize;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > limit {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

fn is_terminal_tool(name: &str) -> bool {
    matches!(
        name,
        "read_screen" | "send_input" | "get_pane_info" | "run_command"
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn message_window_only_cuts_at_user_boundary() {
        let messages = vec![
            json!({"role":"user","content":"old"}),
            json!({"role":"assistant","content":"x".repeat(100)}),
            json!({"role":"tool","content":"y".repeat(100)}),
            json!({"role":"user","content":"new"}),
            json!({"role":"assistant","content":"answer"}),
        ];
        let window = apply_message_window(&messages, 100);
        assert_eq!(
            window.first().and_then(|value| value["content"].as_str()),
            Some("new")
        );
        assert_eq!(window.len(), 2);

        let no_user = vec![json!({"role":"assistant","content":"x".repeat(100)})];
        assert_eq!(apply_message_window(&no_user, 1), no_user);
    }

    #[test]
    fn delta_message_id_change_returns_the_old_event_before_buffering_the_new_id() {
        let mut buffer = EventDeltaBuffer::default();
        assert_eq!(buffer.push("old".to_owned(), "first".to_owned()), None);
        assert_eq!(
            buffer.push("new".to_owned(), "second".to_owned()),
            Some(("old".to_owned(), "first".to_owned()))
        );
        assert_eq!(
            buffer.take_safe(true),
            Some(("new".to_owned(), "second".to_owned()))
        );

        assert_eq!(
            buffer.push(
                "secret".to_owned(),
                "prefix -----BEGIN PRIVATE KEY\nbody".to_owned()
            ),
            None
        );
        assert_eq!(
            buffer.push("after-secret".to_owned(), "safe".to_owned()),
            Some((
                "secret".to_owned(),
                "prefix [REDACTED:stream-content]".to_owned()
            ))
        );
    }
}
