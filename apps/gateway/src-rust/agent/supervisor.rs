use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::database::repository::{AgentConfirmationDecision, AgentSessionUpdate};
use crate::entity::{agent_confirmations, agent_messages, agent_queued_messages, agent_sessions};

use super::{
    redact_json_strings, redact_secrets, secret_kinds, AgentError, AgentEvent, AgentEventEnvelope,
    AgentEventSink, AgentNotification, AgentNotificationSink, AgentNotificationTranslation,
    AgentRunControl, AgentRunDirective, AgentRunLauncher, AgentRunOutcome, AgentSessionCoordinator,
    AgentStopReason, AgentStore, AgentSubscriptionSync, AgentSyncSnapshot, PendingConfirmation,
    QueuedMessageSummary, SubmitUserMessageResult,
};

#[derive(Clone)]
struct ActiveRun {
    control: AgentRunControl,
    generation: u64,
    abort_handle: tokio::task::AbortHandle,
}

pub struct AgentSupervisorDependencies {
    pub store: Arc<dyn AgentStore>,
    pub launcher: Arc<dyn AgentRunLauncher>,
    pub events: Arc<dyn AgentEventSink>,
    pub notifications: Arc<dyn AgentNotificationSink>,
    pub coordinator: Arc<AgentSessionCoordinator>,
}

pub struct AgentSupervisor {
    dependencies: AgentSupervisorDependencies,
    active_runs: Arc<Mutex<HashMap<String, ActiveRun>>>,
    run_finished: Arc<tokio::sync::Notify>,
    next_generation: AtomicU64,
    started: Arc<AtomicBool>,
    stop_timeout: Duration,
}

impl AgentSupervisor {
    pub fn new(dependencies: AgentSupervisorDependencies) -> Self {
        Self {
            dependencies,
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            run_finished: Arc::new(tokio::sync::Notify::new()),
            next_generation: AtomicU64::new(0),
            started: Arc::new(AtomicBool::new(false)),
            stop_timeout: Duration::from_secs(5),
        }
    }

    pub fn with_stop_timeout(mut self, timeout: Duration) -> Self {
        self.stop_timeout = timeout;
        self
    }

    pub fn is_session_active(&self, session_id: &str) -> bool {
        self.active_runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(session_id)
    }

    pub async fn start(&self) -> Result<(), AgentError> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        for session in self
            .dependencies
            .store
            .sessions_by_status("running")
            .await?
        {
            let cancelled = self
                .cancel_pending_confirmations(&session.id, "invalidated after restart")
                .await?;
            if cancelled > 0 {
                let _ = self.append_approval_responses_if_ready(&session.id).await?;
            }
            self.start_run(&session.id);
        }
        for session in self
            .dependencies
            .store
            .sessions_by_status("waiting_confirmation")
            .await?
        {
            if !self
                .dependencies
                .store
                .pending_confirmations(&session.id)
                .await?
                .is_empty()
            {
                continue;
            }
            if self.append_approval_responses_if_ready(&session.id).await? {
                self.start_run(&session.id);
            } else {
                self.dependencies
                    .store
                    .update_session(
                        &session.id,
                        AgentSessionUpdate {
                            status: Some("idle".to_owned()),
                            ..AgentSessionUpdate::default()
                        },
                    )
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn stop(&self) {
        self.started.store(false, Ordering::Release);
        let targets = self
            .active_runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(session_id, active)| {
                active.control.request_stop(AgentStopReason::Shutdown);
                (session_id.clone(), active.generation)
            })
            .collect::<Vec<_>>();
        if tokio::time::timeout(self.stop_timeout, self.wait_for_runs(&targets))
            .await
            .is_ok()
        {
            return;
        }

        let hard_aborted = self.abort_runs(&targets);
        self.wait_for_runs(&targets).await;
        for session_id in hard_aborted {
            let _ = self
                .dependencies
                .store
                .update_session(
                    &session_id,
                    AgentSessionUpdate {
                        status: Some("running".to_owned()),
                        ..AgentSessionUpdate::default()
                    },
                )
                .await;
        }
    }

    pub async fn sync_snapshot(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<AgentSubscriptionSync, AgentError> {
        let Some(session) = self.dependencies.store.get_session(session_id).await? else {
            return Ok(AgentSubscriptionSync {
                generation,
                snapshot: None,
            });
        };
        let (in_progress_text, in_progress_reasoning) =
            self.dependencies.launcher.in_progress(session_id);
        let confirmations = self
            .dependencies
            .store
            .pending_confirmations(session_id)
            .await?
            .into_iter()
            .map(pending_confirmation)
            .collect();
        let queued_messages = queue_summaries(
            self.dependencies
                .store
                .list_queued_messages(session_id)
                .await?,
        );
        Ok(AgentSubscriptionSync {
            generation,
            snapshot: Some(AgentSyncSnapshot {
                status: session.status,
                last_error: session.last_error.map(|error| redact_secrets(&error).text),
                in_progress_text,
                in_progress_reasoning,
                pending_confirmations: confirmations,
                queued_messages,
                last_message_seq: self.dependencies.store.max_message_seq(session_id).await?,
            }),
        })
    }

    pub async fn submit_user_message(
        &self,
        session_id: &str,
        text: &str,
        steer: bool,
    ) -> Result<SubmitUserMessageResult, AgentError> {
        let session_lock = self.dependencies.coordinator.session_lock(session_id);
        let _guard = session_lock.lock().await;
        let session = self.session_and_device(session_id).await?;
        let active = {
            self.active_runs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(session_id)
                .cloned()
        };
        if let Some(active) = active {
            let queued = self
                .dependencies
                .store
                .enqueue_message(session_id, text)
                .await?;
            self.broadcast_queue(session_id).await?;
            self.warn_if_credential(&session, None, text).await;
            if steer {
                active.control.request_steer();
            }
            return Ok(SubmitUserMessageResult::Queued {
                id: queued.id,
                seq: queued.seq,
            });
        }

        if session.status == "waiting_confirmation" {
            if !self
                .dependencies
                .store
                .pending_confirmations(session_id)
                .await?
                .is_empty()
            {
                return Err(AgentError::AwaitingConfirmation);
            }
            let _ = self.append_approval_responses_if_ready(session_id).await?;
        }
        let record = self
            .dependencies
            .store
            .append_message(session_id, "user", json!({"role":"user","content":text}))
            .await?;
        self.emit(
            session_id,
            AgentEvent::MessagePersisted {
                message_id: record.id.clone(),
                seq: record.seq,
                role: record.role,
            },
        )
        .await;
        self.warn_if_credential(&session, Some(record.id.clone()), text)
            .await;
        self.start_run(session_id);
        Ok(SubmitUserMessageResult::Message {
            id: record.id,
            seq: record.seq,
        })
    }

    pub async fn edit_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentError> {
        let Some(existing) = self.dependencies.store.get_queued_message(item_id).await? else {
            return Err(AgentError::QueuedMessageNotFound);
        };
        let session_lock = self
            .dependencies
            .coordinator
            .session_lock(&existing.session_id);
        let _guard = session_lock.lock().await;
        let Some(updated) = self
            .dependencies
            .store
            .update_queued_message(item_id, text)
            .await?
        else {
            return Err(AgentError::QueuedMessageNotFound);
        };
        self.broadcast_queue(&existing.session_id).await?;
        Ok(updated)
    }

    pub async fn withdraw_queued_message(&self, item_id: &str) -> Result<(), AgentError> {
        let Some(existing) = self.dependencies.store.get_queued_message(item_id).await? else {
            return Err(AgentError::QueuedMessageNotFound);
        };
        let session_lock = self
            .dependencies
            .coordinator
            .session_lock(&existing.session_id);
        let _guard = session_lock.lock().await;
        let Some(existing) = self.dependencies.store.get_queued_message(item_id).await? else {
            return Err(AgentError::QueuedMessageNotFound);
        };
        self.dependencies
            .store
            .delete_queued_message(item_id)
            .await?;
        self.broadcast_queue(&existing.session_id).await?;
        Ok(())
    }

    pub async fn stop_session(&self, session_id: &str) -> Result<(), AgentError> {
        if self
            .dependencies
            .store
            .get_session(session_id)
            .await?
            .is_none()
        {
            return Err(AgentError::SessionNotFound);
        }
        let session_lock = self.dependencies.coordinator.session_lock(session_id);
        let guard = session_lock.lock().await;
        let active = {
            self.active_runs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(session_id)
                .cloned()
        };
        if let Some(active) = active {
            active.control.request_stop(AgentStopReason::Manual);
            let target = [(session_id.to_owned(), active.generation)];
            drop(guard);
            if tokio::time::timeout(self.stop_timeout, self.wait_for_runs(&target))
                .await
                .is_err()
                && !self.abort_runs(&target).is_empty()
            {
                self.wait_for_runs(&target).await;
                self.mark_session_stopped(session_id).await?;
            }
            return Ok(());
        }

        if self
            .cancel_pending_confirmations(session_id, "stopped by user")
            .await?
            > 0
        {
            let _ = self.append_approval_responses_if_ready(session_id).await?;
        }
        self.mark_session_stopped(session_id).await
    }

    pub async fn stop_sessions_for_device(
        &self,
        device_id: &str,
        reason: AgentStopReason,
    ) -> Result<(), AgentError> {
        let mut sessions = self
            .dependencies
            .store
            .sessions_by_status("running")
            .await?;
        sessions.extend(
            self.dependencies
                .store
                .sessions_by_status("waiting_confirmation")
                .await?,
        );
        for session in sessions
            .into_iter()
            .filter(|session| session.device_id.as_deref() == Some(device_id))
        {
            if let Some(active) = self
                .active_runs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&session.id)
                .cloned()
            {
                active.control.request_stop(reason);
                continue;
            }
            let message = "terminal connection lost: pane/device unavailable";
            self.dependencies
                .store
                .update_session(
                    &session.id,
                    AgentSessionUpdate {
                        status: Some("error".to_owned()),
                        last_error: Some(Some(message.to_owned())),
                        ..AgentSessionUpdate::default()
                    },
                )
                .await?;
            self.emit(
                &session.id,
                AgentEvent::Status {
                    status: "error".to_owned(),
                    last_error: Some(message.to_owned()),
                },
            )
            .await;
        }
        Ok(())
    }

    pub async fn resolve_confirmation(
        &self,
        confirmation_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> Result<agent_confirmations::Model, AgentError> {
        let Some(confirmation) = self
            .dependencies
            .store
            .get_confirmation(confirmation_id)
            .await?
        else {
            return Err(AgentError::ConfirmationNotFound);
        };
        let session_lock = self
            .dependencies
            .coordinator
            .session_lock(&confirmation.session_id);
        let _guard = session_lock.lock().await;
        let Some(decided) = self
            .dependencies
            .store
            .decide_confirmation(
                confirmation_id,
                AgentConfirmationDecision {
                    status: if approved { "approved" } else { "denied" }.to_owned(),
                    reason,
                },
            )
            .await?
        else {
            return Err(AgentError::ConfirmationAlreadyDecided);
        };
        self.emit(
            &decided.session_id,
            AgentEvent::ConfirmationResolved {
                confirmation_id: decided.id.clone(),
                status: decided.status.clone(),
                reason: decided
                    .reason
                    .as_deref()
                    .map(|reason| redact_secrets(reason).text),
            },
        )
        .await;
        if !self.is_session_active(&decided.session_id)
            && self
                .dependencies
                .store
                .pending_confirmations(&decided.session_id)
                .await?
                .is_empty()
            && self
                .append_approval_responses_if_ready(&decided.session_id)
                .await?
        {
            self.start_run(&decided.session_id);
        }
        Ok(decided)
    }

    async fn session_and_device(
        &self,
        session_id: &str,
    ) -> Result<agent_sessions::Model, AgentError> {
        let Some(session) = self.dependencies.store.get_session(session_id).await? else {
            return Err(AgentError::SessionNotFound);
        };
        let Some(device_id) = session.device_id.as_deref() else {
            return Err(AgentError::SessionOrphaned);
        };
        if self
            .dependencies
            .store
            .get_device(device_id)
            .await?
            .is_none()
        {
            return Err(AgentError::SessionOrphaned);
        }
        Ok(session)
    }

    async fn cancel_pending_confirmations(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<usize, AgentError> {
        let pending = self
            .dependencies
            .store
            .pending_confirmations(session_id)
            .await?;
        for confirmation in &pending {
            if let Some(decided) = self
                .dependencies
                .store
                .decide_confirmation(
                    &confirmation.id,
                    AgentConfirmationDecision {
                        status: "cancelled".to_owned(),
                        reason: Some(reason.to_owned()),
                    },
                )
                .await?
            {
                self.emit(
                    session_id,
                    AgentEvent::ConfirmationResolved {
                        confirmation_id: decided.id,
                        status: "cancelled".to_owned(),
                        reason: decided.reason,
                    },
                )
                .await;
            }
        }
        Ok(pending.len())
    }

    async fn append_approval_responses_if_ready(
        &self,
        session_id: &str,
    ) -> Result<bool, AgentError> {
        let messages = self.dependencies.store.list_messages(session_id).await?;
        let Some(last_assistant_index) = messages
            .iter()
            .rposition(|message| message.role == "assistant")
        else {
            return Ok(false);
        };
        let assistant = parse_message(&messages[last_assistant_index])?;
        let Some(content) = assistant.get("content").and_then(Value::as_array) else {
            return Ok(false);
        };
        let requests = content
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(Value::as_str) != Some("tool-approval-request") {
                    return None;
                }
                Some(ApprovalRequestRef {
                    approval_id: part.get("approvalId")?.as_str()?.to_owned(),
                    tool_call_id: part.get("toolCallId")?.as_str()?.to_owned(),
                })
            })
            .collect::<Vec<_>>();
        if requests.is_empty() {
            return Ok(false);
        }

        let (responded_approvals, resolved_tool_calls) =
            resolved_approval_ids(&messages[last_assistant_index + 1..])?;
        let mut parts = Vec::new();
        for request in requests {
            if responded_approvals.contains(&request.approval_id) {
                continue;
            }
            let confirmation = self
                .dependencies
                .store
                .get_confirmation(&request.approval_id)
                .await?;
            let tool_call_id = confirmation
                .as_ref()
                .map_or(request.tool_call_id.as_str(), |confirmation| {
                    confirmation.tool_call_id.as_str()
                });
            if resolved_tool_calls.contains(tool_call_id) {
                continue;
            }
            let Some(confirmation) = confirmation else {
                return Ok(false);
            };
            match confirmation.status.as_str() {
                "pending" => return Ok(false),
                "cancelled" => parts.push(json!({
                    "type":"tool-result",
                    "toolCallId":confirmation.tool_call_id,
                    "toolName":confirmation.tool_name,
                    "output":{
                        "type":"execution-denied",
                        "reason":confirmation.reason.unwrap_or_else(|| "cancelled".to_owned()),
                    },
                })),
                "approved" => parts.push(json!({
                    "type":"tool-approval-response",
                    "approvalId":request.approval_id,
                    "approved":true,
                })),
                "denied" => parts.push(json!({
                    "type":"tool-approval-response",
                    "approvalId":request.approval_id,
                    "approved":false,
                    "reason":confirmation.reason,
                })),
                _ => return Ok(false),
            }
        }
        if parts.is_empty() {
            return Ok(true);
        }
        let record = self
            .dependencies
            .store
            .append_message(session_id, "tool", json!({"role":"tool","content":parts}))
            .await?;
        self.emit(
            session_id,
            AgentEvent::MessagePersisted {
                message_id: record.id,
                seq: record.seq,
                role: record.role,
            },
        )
        .await;
        Ok(true)
    }

    fn start_run(&self, session_id: &str) {
        let mut active_runs = self
            .active_runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.started.load(Ordering::Acquire) || active_runs.contains_key(session_id) {
            return;
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let control = AgentRunControl::default();
        let (start_sender, start_receiver) = oneshot::channel();
        let run_session_id = session_id.to_owned();
        let launcher = self.dependencies.launcher.clone();
        let store = self.dependencies.store.clone();
        let events = self.dependencies.events.clone();
        let notifications = self.dependencies.notifications.clone();
        let coordinator = self.dependencies.coordinator.clone();
        let started = self.started.clone();
        let run_control = control.clone();
        let run_task = tokio::spawn(async move {
            if start_receiver.await.is_err() {
                return None;
            }
            loop {
                let outcome =
                    AssertUnwindSafe(launcher.run(run_session_id.clone(), run_control.clone()))
                        .catch_unwind()
                        .await;
                let session_lock = coordinator.session_lock(&run_session_id);
                let guard = session_lock.lock_owned().await;
                let should_continue = matches!(outcome, Ok(Ok(AgentRunOutcome::Idle)))
                    && started.load(Ordering::Acquire)
                    && !matches!(run_control.directive(), AgentRunDirective::Stop(_))
                    && store
                        .list_queued_messages(&run_session_id)
                        .await
                        .is_ok_and(|queued| !queued.is_empty());
                if should_continue {
                    drop(guard);
                    continue;
                }
                if !matches!(
                    run_control.directive(),
                    AgentRunDirective::Stop(AgentStopReason::Shutdown)
                ) {
                    match outcome {
                        Ok(Err(error)) => {
                            record_run_failure(
                                store.as_ref(),
                                events.as_ref(),
                                notifications.as_ref(),
                                &run_session_id,
                                &error.to_string(),
                            )
                            .await;
                        }
                        Err(_) => {
                            record_run_failure(
                                store.as_ref(),
                                events.as_ref(),
                                notifications.as_ref(),
                                &run_session_id,
                                "agent run task panicked",
                            )
                            .await;
                        }
                        Ok(Ok(_)) => {}
                    }
                }
                return Some(guard);
            }
        });
        let abort_handle = run_task.abort_handle();
        active_runs.insert(
            session_id.to_owned(),
            ActiveRun {
                control: control.clone(),
                generation,
                abort_handle,
            },
        );
        drop(active_runs);

        let session_id = session_id.to_owned();
        let coordinator = self.dependencies.coordinator.clone();
        let active_runs = self.active_runs.clone();
        let run_finished = self.run_finished.clone();
        tokio::spawn(async move {
            let completion_guard = match run_task.await {
                Ok(Some(guard)) => guard,
                Ok(None) | Err(_) => coordinator.session_lock(&session_id).lock_owned().await,
            };
            let mut active_runs = active_runs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if active_runs
                .get(&session_id)
                .is_some_and(|active| active.generation == generation)
            {
                active_runs.remove(&session_id);
            }
            drop(active_runs);
            drop(completion_guard);
            run_finished.notify_waiters();
        });
        let _ = start_sender.send(());
    }

    async fn wait_for_runs(&self, targets: &[(String, u64)]) {
        loop {
            let notified = self.run_finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let finished = {
                let active_runs = self
                    .active_runs
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                targets.iter().all(|(session_id, generation)| {
                    active_runs
                        .get(session_id)
                        .is_none_or(|active| active.generation != *generation)
                })
            };
            if finished {
                return;
            }
            notified.await;
        }
    }

    fn abort_runs(&self, targets: &[(String, u64)]) -> Vec<String> {
        let active_runs = self
            .active_runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        targets
            .iter()
            .filter_map(|(session_id, generation)| {
                let active = active_runs
                    .get(session_id)
                    .filter(|active| active.generation == *generation)?;
                active.abort_handle.abort();
                Some(session_id.clone())
            })
            .collect()
    }

    async fn mark_session_stopped(&self, session_id: &str) -> Result<(), AgentError> {
        self.dependencies
            .store
            .update_session(
                session_id,
                AgentSessionUpdate {
                    status: Some("stopped".to_owned()),
                    last_error: Some(None),
                    ..AgentSessionUpdate::default()
                },
            )
            .await?;
        self.emit(
            session_id,
            AgentEvent::Status {
                status: "stopped".to_owned(),
                last_error: None,
            },
        )
        .await;
        Ok(())
    }

    async fn broadcast_queue(&self, session_id: &str) -> Result<(), AgentError> {
        let queued = queue_summaries(
            self.dependencies
                .store
                .list_queued_messages(session_id)
                .await?,
        );
        self.emit(session_id, AgentEvent::QueueUpdated { queued })
            .await;
        Ok(())
    }

    async fn warn_if_credential(
        &self,
        session: &agent_sessions::Model,
        message_id: Option<String>,
        text: &str,
    ) {
        let types = secret_kinds(text);
        if types.is_empty() {
            return;
        }
        if message_id.is_some() {
            self.emit(
                &session.id,
                AgentEvent::CredentialWarning {
                    message_id,
                    types: types.clone(),
                },
            )
            .await;
        }
        let _ = self
            .dependencies
            .notifications
            .notify(AgentNotification {
                event_type: "agent_credential_warning".to_owned(),
                translation: AgentNotificationTranslation::CredentialWarning {
                    session_title: session.title.clone(),
                    types: types.clone(),
                },
                session_id: session.id.clone(),
                session_title: session.title.clone(),
                device_id: session.device_id.clone(),
                pane_id: session.pane_id.clone(),
                message: format!("Credential-like content detected ({})", types.join(", ")),
                tool_name: None,
                confirmation_id: None,
            })
            .await;
    }

    async fn emit(&self, session_id: &str, event: AgentEvent) {
        let _ = self
            .dependencies
            .events
            .emit(AgentEventEnvelope {
                session_id: session_id.to_owned(),
                seq: 0,
                event,
            })
            .await;
    }
}

async fn record_run_failure(
    store: &dyn AgentStore,
    events: &dyn AgentEventSink,
    notifications: &dyn AgentNotificationSink,
    session_id: &str,
    message: &str,
) {
    let message = redact_secrets(message).text;
    let session = match store.get_session(session_id).await {
        Ok(Some(session)) => session,
        Ok(None) => {
            tracing::error!(session_id, %message, "agent run failed after its session disappeared");
            return;
        }
        Err(error) => {
            tracing::error!(session_id, %message, %error, "agent run failed and its session could not be loaded");
            return;
        }
    };
    match store
        .update_session(
            session_id,
            AgentSessionUpdate {
                status: Some("error".to_owned()),
                last_error: Some(Some(message.clone())),
                ..AgentSessionUpdate::default()
            },
        )
        .await
    {
        Ok(Some(_)) => {
            let status_event = AgentEventEnvelope {
                session_id: session_id.to_owned(),
                seq: 0,
                event: AgentEvent::Status {
                    status: "error".to_owned(),
                    last_error: Some(message.clone()),
                },
            };
            if let Err(error) = events.emit(status_event).await {
                tracing::error!(session_id, %error, "failed to publish agent failure status");
            }
            let error_event = AgentEventEnvelope {
                session_id: session_id.to_owned(),
                seq: 0,
                event: AgentEvent::Error {
                    message: message.clone(),
                },
            };
            if let Err(error) = events.emit(error_event).await {
                tracing::error!(session_id, %error, "failed to publish agent failure event");
            }
        }
        Ok(None) => {
            tracing::error!(session_id, %message, "agent run failed after its session disappeared");
            return;
        }
        Err(error) => {
            tracing::error!(session_id, %message, %error, "failed to persist agent run failure");
            return;
        }
    }
    if let Err(error) = notifications
        .notify(AgentNotification {
            event_type: "agent_error".to_owned(),
            translation: AgentNotificationTranslation::Error {
                title: session.title.clone(),
                error: message.clone(),
            },
            session_id: session.id,
            session_title: session.title,
            device_id: session.device_id,
            pane_id: session.pane_id,
            message: format!("Agent error: {message}"),
            tool_name: None,
            confirmation_id: None,
        })
        .await
    {
        tracing::error!(session_id, %error, "failed to publish agent failure notification");
    }
}

struct ApprovalRequestRef {
    approval_id: String,
    tool_call_id: String,
}

fn parse_message(message: &agent_messages::Model) -> Result<Value, AgentError> {
    serde_json::from_str(&message.content)
        .map_err(|_| AgentError::InvalidPersistedData("invalid agent message JSON".to_owned()))
}

fn resolved_approval_ids(
    messages: &[agent_messages::Model],
) -> Result<(HashSet<String>, HashSet<String>), AgentError> {
    let mut approvals = HashSet::new();
    let mut tool_calls = HashSet::new();
    for message in messages.iter().filter(|message| message.role == "tool") {
        let value = parse_message(message)?;
        let Some(content) = value.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("tool-approval-response") => {
                    if let Some(id) = part.get("approvalId").and_then(Value::as_str) {
                        approvals.insert(id.to_owned());
                    }
                }
                Some("tool-result") => {
                    if let Some(id) = part.get("toolCallId").and_then(Value::as_str) {
                        tool_calls.insert(id.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    Ok((approvals, tool_calls))
}

fn pending_confirmation(confirmation: agent_confirmations::Model) -> PendingConfirmation {
    let input = serde_json::from_str(&confirmation.input_json).unwrap_or(Value::Null);
    PendingConfirmation {
        confirmation_id: confirmation.id,
        tool_call_id: confirmation.tool_call_id,
        tool_name: confirmation.tool_name,
        input: redact_json_strings(&input),
        created_at: confirmation.created_at,
    }
}

fn queue_summaries(mut queued: Vec<agent_queued_messages::Model>) -> Vec<QueuedMessageSummary> {
    queued.sort_by_key(|item| item.seq);
    queued
        .into_iter()
        .map(|item| QueuedMessageSummary {
            id: item.id,
            seq: item.seq,
            text: redact_secrets(&item.text).text,
            created_at: item.created_at,
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    CancelPendingAndRestart,
    KeepWaiting,
    RepairThenRestart,
    FallBackToIdle,
}

pub fn recovery_action(
    status: &str,
    pending_confirmations: usize,
    approval_chain_repairable: bool,
) -> RecoveryAction {
    match status {
        "running" => RecoveryAction::CancelPendingAndRestart,
        "waiting_confirmation" if pending_confirmations > 0 => RecoveryAction::KeepWaiting,
        "waiting_confirmation" if approval_chain_repairable => RecoveryAction::RepairThenRestart,
        _ => RecoveryAction::FallBackToIdle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use futures_util::poll;
    use tokio::sync::Semaphore;

    use crate::agent::AgentPortError;
    use crate::entity::devices;

    #[derive(Default)]
    struct TestStoreState {
        session: Option<agent_sessions::Model>,
        device: Option<devices::Model>,
        messages: Vec<agent_messages::Model>,
        queued: Vec<agent_queued_messages::Model>,
        next_id: i64,
    }

    struct TestStore {
        state: Mutex<TestStoreState>,
    }

    impl TestStore {
        fn new(status: &str) -> Self {
            Self {
                state: Mutex::new(TestStoreState {
                    session: Some(agent_sessions::Model {
                        id: "session".to_owned(),
                        title: "Session".to_owned(),
                        device_id: Some("device".to_owned()),
                        pane_id: Some("pane".to_owned()),
                        provider_id: None,
                        model_id: "model".to_owned(),
                        system_prompt: None,
                        write_mode: "confirm".to_owned(),
                        use_provider_web_search: 0,
                        provider_hosted_tools: "[]".to_owned(),
                        allow_control_chars: 0,
                        origin_pane_title: None,
                        origin_process_name: None,
                        status: status.to_owned(),
                        last_error: None,
                        max_steps_per_turn: 20,
                        created_at: "now".to_owned(),
                        updated_at: "now".to_owned(),
                    }),
                    device: Some(devices::Model {
                        id: "device".to_owned(),
                        name: "Device".to_owned(),
                        r#type: "local".to_owned(),
                        host: None,
                        port: None,
                        username: None,
                        ssh_config_ref: None,
                        session: None,
                        auth_mode: "none".to_owned(),
                        password_enc: None,
                        private_key_enc: None,
                        private_key_passphrase_enc: None,
                        default_working_dir: None,
                        sort_order: 0,
                        created_at: "now".to_owned(),
                        updated_at: "now".to_owned(),
                    }),
                    ..TestStoreState::default()
                }),
            }
        }

        fn session_status(&self) -> String {
            self.state
                .lock()
                .expect("test store")
                .session
                .as_ref()
                .expect("test session")
                .status
                .clone()
        }

        fn session_error(&self) -> Option<String> {
            self.state
                .lock()
                .expect("test store")
                .session
                .as_ref()
                .expect("test session")
                .last_error
                .clone()
        }

        fn queue_is_empty(&self) -> bool {
            self.state.lock().expect("test store").queued.is_empty()
        }

        fn user_texts(&self) -> Vec<String> {
            self.state
                .lock()
                .expect("test store")
                .messages
                .iter()
                .filter(|message| message.role == "user")
                .filter_map(|message| {
                    serde_json::from_str::<Value>(&message.content)
                        .ok()?
                        .get("content")?
                        .as_str()
                        .map(str::to_owned)
                })
                .collect()
        }

        fn append_message_locked(
            state: &mut TestStoreState,
            session_id: &str,
            role: &str,
            content: Value,
        ) -> agent_messages::Model {
            state.next_id += 1;
            let message = agent_messages::Model {
                id: format!("message-{}", state.next_id),
                session_id: session_id.to_owned(),
                seq: state.messages.len() as i64 + 1,
                role: role.to_owned(),
                content: content.to_string(),
                created_at: "now".to_owned(),
            };
            state.messages.push(message.clone());
            message
        }
    }

    #[async_trait]
    impl AgentStore for TestStore {
        async fn get_session(
            &self,
            session_id: &str,
        ) -> Result<Option<agent_sessions::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .session
                .clone()
                .filter(|session| session.id == session_id))
        }

        async fn sessions_by_status(
            &self,
            status: &str,
        ) -> Result<Vec<agent_sessions::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .session
                .clone()
                .filter(|session| session.status == status)
                .into_iter()
                .collect())
        }

        async fn update_session(
            &self,
            session_id: &str,
            update: AgentSessionUpdate,
        ) -> Result<Option<agent_sessions::Model>, AgentPortError> {
            let mut state = self.state.lock().expect("test store");
            let Some(session) = state
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return Ok(None);
            };
            if let Some(status) = update.status {
                session.status = status;
            }
            if let Some(last_error) = update.last_error {
                session.last_error = last_error;
            }
            Ok(Some(session.clone()))
        }

        async fn get_device(
            &self,
            device_id: &str,
        ) -> Result<Option<devices::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .device
                .clone()
                .filter(|device| device.id == device_id))
        }

        async fn append_message(
            &self,
            session_id: &str,
            role: &str,
            content: Value,
        ) -> Result<agent_messages::Model, AgentPortError> {
            Ok(Self::append_message_locked(
                &mut self.state.lock().expect("test store"),
                session_id,
                role,
                content,
            ))
        }

        async fn list_messages(
            &self,
            session_id: &str,
        ) -> Result<Vec<agent_messages::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .messages
                .iter()
                .filter(|message| message.session_id == session_id)
                .cloned()
                .collect())
        }

        async fn max_message_seq(&self, session_id: &str) -> Result<i64, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .messages
                .iter()
                .filter(|message| message.session_id == session_id)
                .map(|message| message.seq)
                .max()
                .unwrap_or(0))
        }

        async fn enqueue_message(
            &self,
            session_id: &str,
            text: &str,
        ) -> Result<agent_queued_messages::Model, AgentPortError> {
            let mut state = self.state.lock().expect("test store");
            state.next_id += 1;
            let queued = agent_queued_messages::Model {
                id: format!("queued-{}", state.next_id),
                session_id: session_id.to_owned(),
                seq: state.queued.len() as i64 + 1,
                text: text.to_owned(),
                created_at: "now".to_owned(),
            };
            state.queued.push(queued.clone());
            Ok(queued)
        }

        async fn list_queued_messages(
            &self,
            session_id: &str,
        ) -> Result<Vec<agent_queued_messages::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .queued
                .iter()
                .filter(|queued| queued.session_id == session_id)
                .cloned()
                .collect())
        }

        async fn get_queued_message(
            &self,
            item_id: &str,
        ) -> Result<Option<agent_queued_messages::Model>, AgentPortError> {
            Ok(self
                .state
                .lock()
                .expect("test store")
                .queued
                .iter()
                .find(|queued| queued.id == item_id)
                .cloned())
        }

        async fn update_queued_message(
            &self,
            item_id: &str,
            text: &str,
        ) -> Result<Option<agent_queued_messages::Model>, AgentPortError> {
            let mut state = self.state.lock().expect("test store");
            let Some(queued) = state.queued.iter_mut().find(|queued| queued.id == item_id) else {
                return Ok(None);
            };
            queued.text = text.to_owned();
            Ok(Some(queued.clone()))
        }

        async fn delete_queued_message(&self, item_id: &str) -> Result<(), AgentPortError> {
            self.state
                .lock()
                .expect("test store")
                .queued
                .retain(|queued| queued.id != item_id);
            Ok(())
        }

        async fn delete_all_queued_messages(&self, session_id: &str) -> Result<(), AgentPortError> {
            self.state
                .lock()
                .expect("test store")
                .queued
                .retain(|queued| queued.session_id != session_id);
            Ok(())
        }

        async fn drain_queued_messages(
            &self,
            session_id: &str,
        ) -> Result<Vec<agent_messages::Model>, AgentPortError> {
            let mut state = self.state.lock().expect("test store");
            let mut queued = Vec::new();
            state.queued.retain(|item| {
                if item.session_id == session_id {
                    queued.push(item.clone());
                    false
                } else {
                    true
                }
            });
            queued.sort_by_key(|item| item.seq);
            Ok(queued
                .into_iter()
                .map(|item| {
                    Self::append_message_locked(
                        &mut state,
                        session_id,
                        "user",
                        json!({"role":"user","content":item.text}),
                    )
                })
                .collect())
        }

        async fn create_confirmation(
            &self,
            _input: crate::database::repository::CreateAgentConfirmationInput,
        ) -> Result<agent_confirmations::Model, AgentPortError> {
            Err(AgentPortError::new("unused in test"))
        }

        async fn get_confirmation(
            &self,
            _confirmation_id: &str,
        ) -> Result<Option<agent_confirmations::Model>, AgentPortError> {
            Ok(None)
        }

        async fn pending_confirmations(
            &self,
            _session_id: &str,
        ) -> Result<Vec<agent_confirmations::Model>, AgentPortError> {
            Ok(Vec::new())
        }

        async fn decide_confirmation(
            &self,
            _confirmation_id: &str,
            _decision: AgentConfirmationDecision,
        ) -> Result<Option<agent_confirmations::Model>, AgentPortError> {
            Ok(None)
        }
    }

    struct NoopSink;

    #[async_trait]
    impl AgentEventSink for NoopSink {
        async fn emit(&self, _event: AgentEventEnvelope) -> Result<(), AgentPortError> {
            Ok(())
        }
    }

    #[async_trait]
    impl AgentNotificationSink for NoopSink {
        async fn notify(&self, _notification: AgentNotification) -> Result<(), AgentPortError> {
            Ok(())
        }
    }

    struct HangingLauncher {
        started: Arc<Semaphore>,
        dropped: Arc<AtomicBool>,
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[async_trait]
    impl AgentRunLauncher for HangingLauncher {
        async fn run(
            &self,
            _session_id: String,
            _control: AgentRunControl,
        ) -> Result<AgentRunOutcome, AgentError> {
            let _drop_flag = DropFlag(self.dropped.clone());
            self.started.add_permits(1);
            std::future::pending().await
        }

        fn in_progress(&self, _session_id: &str) -> (String, String) {
            (String::new(), String::new())
        }
    }

    struct CompletionRaceLauncher {
        store: Arc<TestStore>,
        calls: AtomicUsize,
        first_started: Arc<Semaphore>,
        release_first: Arc<Semaphore>,
        second_started: Arc<Semaphore>,
    }

    struct FailingLauncher {
        panic: bool,
    }

    #[async_trait]
    impl AgentRunLauncher for FailingLauncher {
        async fn run(
            &self,
            _session_id: String,
            _control: AgentRunControl,
        ) -> Result<AgentRunOutcome, AgentError> {
            if self.panic {
                panic!("launcher panic must be contained");
            }
            Err(AgentPortError::new("launcher failed").into())
        }

        fn in_progress(&self, _session_id: &str) -> (String, String) {
            (String::new(), String::new())
        }
    }

    #[async_trait]
    impl AgentRunLauncher for CompletionRaceLauncher {
        async fn run(
            &self,
            session_id: String,
            _control: AgentRunControl,
        ) -> Result<AgentRunOutcome, AgentError> {
            match self.calls.fetch_add(1, Ordering::AcqRel) + 1 {
                1 => {
                    self.first_started.add_permits(1);
                    let _permit = self
                        .release_first
                        .acquire()
                        .await
                        .expect("release first run");
                    Ok(AgentRunOutcome::Idle)
                }
                2 => {
                    self.store.drain_queued_messages(&session_id).await?;
                    self.second_started.add_permits(1);
                    Ok(AgentRunOutcome::Stopped)
                }
                call => panic!("unexpected run attempt {call}"),
            }
        }

        fn in_progress(&self, _session_id: &str) -> (String, String) {
            (String::new(), String::new())
        }
    }

    fn supervisor(
        store: Arc<TestStore>,
        launcher: Arc<dyn AgentRunLauncher>,
        stop_timeout: Duration,
    ) -> AgentSupervisor {
        AgentSupervisor::new(AgentSupervisorDependencies {
            store,
            launcher,
            events: Arc::new(NoopSink),
            notifications: Arc::new(NoopSink),
            coordinator: Arc::new(AgentSessionCoordinator::default()),
        })
        .with_stop_timeout(stop_timeout)
    }

    fn queued(id: &str, seq: i64, text: &str) -> agent_queued_messages::Model {
        agent_queued_messages::Model {
            id: id.to_owned(),
            session_id: "session".to_owned(),
            seq,
            text: text.to_owned(),
            created_at: format!("time-{seq}"),
        }
    }

    #[test]
    fn recovery_policy_preserves_pending_approval_and_repairs_crash_windows() {
        assert_eq!(
            recovery_action("running", 1, false),
            RecoveryAction::CancelPendingAndRestart
        );
        assert_eq!(
            recovery_action("waiting_confirmation", 1, false),
            RecoveryAction::KeepWaiting
        );
        assert_eq!(
            recovery_action("waiting_confirmation", 0, true),
            RecoveryAction::RepairThenRestart
        );
        assert_eq!(
            recovery_action("waiting_confirmation", 0, false),
            RecoveryAction::FallBackToIdle
        );
    }

    #[test]
    fn queued_messages_are_ordered_and_event_text_is_redacted() {
        let summaries = queue_summaries(vec![
            queued("b", 2, "later"),
            queued("a", 1, "sk-abcdefghijklmnop"),
        ]);
        assert_eq!(
            summaries.iter().map(|item| item.seq).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(summaries[0].text, "[REDACTED:token]");
    }

    #[test]
    fn approval_resolution_scanner_ignores_already_completed_calls() {
        let messages = vec![agent_messages::Model {
            id: "m".to_owned(),
            session_id: "s".to_owned(),
            seq: 1,
            role: "tool".to_owned(),
            content: json!({"role":"tool","content":[
                {"type":"tool-approval-response","approvalId":"approval"},
                {"type":"tool-result","toolCallId":"call"}
            ]})
            .to_string(),
            created_at: "now".to_owned(),
        }];
        let (approvals, tool_calls) = resolved_approval_ids(&messages).expect("valid messages");
        assert!(approvals.contains("approval"));
        assert!(tool_calls.contains("call"));
    }

    #[tokio::test]
    async fn stop_timeout_aborts_the_worker_and_waits_for_cleanup() {
        let store = Arc::new(TestStore::new("running"));
        let started = Arc::new(Semaphore::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let launcher = Arc::new(HangingLauncher {
            started: started.clone(),
            dropped: dropped.clone(),
        });
        let supervisor = supervisor(store.clone(), launcher, Duration::from_millis(10));

        supervisor.start().await.expect("start supervisor");
        let _started_permit = tokio::time::timeout(Duration::from_secs(1), started.acquire())
            .await
            .expect("worker started")
            .expect("semaphore open");
        supervisor.stop().await;

        assert!(dropped.load(Ordering::Acquire));
        assert!(!supervisor.is_session_active("session"));
        assert_eq!(store.session_status(), "running");
    }

    #[tokio::test]
    async fn idle_completion_hands_a_racing_queued_message_to_the_same_generation() {
        let store = Arc::new(TestStore::new("idle"));
        let first_started = Arc::new(Semaphore::new(0));
        let release_first = Arc::new(Semaphore::new(0));
        let second_started = Arc::new(Semaphore::new(0));
        let launcher = Arc::new(CompletionRaceLauncher {
            store: store.clone(),
            calls: AtomicUsize::new(0),
            first_started: first_started.clone(),
            release_first: release_first.clone(),
            second_started: second_started.clone(),
        });
        let supervisor = Arc::new(supervisor(
            store.clone(),
            launcher.clone(),
            Duration::from_secs(1),
        ));
        supervisor.start().await.expect("start supervisor");
        supervisor.start_run("session");
        let _first_started_permit = first_started.acquire().await.expect("first run started");

        let session_lock = supervisor.dependencies.coordinator.session_lock("session");
        let guard = session_lock.lock().await;
        let submit = supervisor.submit_user_message("session", "raced", false);
        tokio::pin!(submit);
        assert!(poll!(submit.as_mut()).is_pending());
        release_first.add_permits(1);
        drop(guard);

        assert!(matches!(
            submit.await.expect("submit queued message"),
            SubmitUserMessageResult::Queued { .. }
        ));
        let _second_started_permit =
            tokio::time::timeout(Duration::from_secs(1), second_started.acquire())
                .await
                .expect("handoff run started")
                .expect("semaphore open");
        supervisor.wait_for_runs(&[("session".to_owned(), 1)]).await;

        assert_eq!(launcher.calls.load(Ordering::Acquire), 2);
        assert_eq!(supervisor.next_generation.load(Ordering::Acquire), 1);
        assert!(store.queue_is_empty());
        assert_eq!(store.user_texts(), ["raced"]);
    }

    #[tokio::test]
    async fn unexpected_run_errors_and_panics_leave_a_persisted_terminal_state() {
        for (panic, expected_error) in [
            (false, "launcher failed"),
            (true, "agent run task panicked"),
        ] {
            let store = Arc::new(TestStore::new("idle"));
            let supervisor = supervisor(
                store.clone(),
                Arc::new(FailingLauncher { panic }),
                Duration::from_secs(1),
            );
            supervisor.start().await.expect("start supervisor");
            supervisor.start_run("session");
            supervisor.wait_for_runs(&[("session".to_owned(), 1)]).await;

            assert_eq!(store.session_status(), "error");
            assert_eq!(store.session_error().as_deref(), Some(expected_error));
            assert!(!supervisor.is_session_active("session"));
        }
    }
}
