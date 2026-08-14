use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::llm::LanguageModelEndpoint;

pub const DEFAULT_AGENT_SESSION_TITLE: &str = "New Session";
pub const MESSAGE_WINDOW_CHAR_BUDGET: usize = 200_000;
pub const HOSTED_TOOL_KEYS: [&str; 2] = ["image_generation", "code_interpreter"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentWriteMode {
    Confirm,
    Auto,
}

impl AgentWriteMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "confirm" => Some(Self::Confirm),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirm => "confirm",
            Self::Auto => "auto",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStopReason {
    Manual,
    Shutdown,
    PaneLost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRunOutcome {
    Idle,
    WaitingConfirmation,
    Stopped,
    Interrupted,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRunDirective {
    Continue,
    Steer,
    Stop(AgentStopReason),
}

#[derive(Default)]
struct AgentRunControlInner {
    state: AtomicU8,
    changed: tokio::sync::Notify,
}

#[derive(Clone, Default)]
pub struct AgentRunControl {
    inner: Arc<AgentRunControlInner>,
}

impl AgentRunControl {
    const RUNNING: u8 = 0;
    const STEER: u8 = 1;
    const STOP_MANUAL: u8 = 2;
    const STOP_SHUTDOWN: u8 = 3;
    const STOP_PANE_LOST: u8 = 4;

    pub fn request_steer(&self) {
        let changed = self.inner.state.compare_exchange(
            Self::RUNNING,
            Self::STEER,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if changed.is_ok() {
            self.inner.changed.notify_waiters();
        }
    }

    pub fn clear_steer(&self) {
        let _ = self.inner.state.compare_exchange(
            Self::STEER,
            Self::RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub fn request_stop(&self, reason: AgentStopReason) {
        let target = match reason {
            AgentStopReason::Manual => Self::STOP_MANUAL,
            AgentStopReason::Shutdown => Self::STOP_SHUTDOWN,
            AgentStopReason::PaneLost => Self::STOP_PANE_LOST,
        };
        loop {
            let current = self.inner.state.load(Ordering::Acquire);
            if current >= Self::STOP_MANUAL {
                return;
            }
            if self
                .inner
                .state
                .compare_exchange(current, target, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                self.inner.changed.notify_waiters();
                return;
            }
        }
    }

    pub fn directive(&self) -> AgentRunDirective {
        match self.inner.state.load(Ordering::Acquire) {
            Self::STEER => AgentRunDirective::Steer,
            Self::STOP_MANUAL => AgentRunDirective::Stop(AgentStopReason::Manual),
            Self::STOP_SHUTDOWN => AgentRunDirective::Stop(AgentStopReason::Shutdown),
            Self::STOP_PANE_LOST => AgentRunDirective::Stop(AgentStopReason::PaneLost),
            _ => AgentRunDirective::Continue,
        }
    }

    pub async fn changed(&self) -> AgentRunDirective {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let directive = self.directive();
            if directive != AgentRunDirective::Continue {
                return directive;
            }
            notified.await;
        }
    }
}

impl fmt::Debug for AgentRunControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentRunControl")
            .field("directive", &self.directive())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct PendingConfirmation {
    pub confirmation_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    pub created_at: String,
}

impl fmt::Debug for PendingConfirmation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingConfirmation")
            .field("confirmation_id", &self.confirmation_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("tool_name", &self.tool_name)
            .field("input", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct QueuedMessageSummary {
    pub id: String,
    pub seq: i64,
    pub text: String,
    pub created_at: String,
}

impl fmt::Debug for QueuedMessageSummary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("QueuedMessageSummary")
            .field("id", &self.id)
            .field("seq", &self.seq)
            .field("text", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AgentSyncSnapshot {
    pub status: String,
    pub last_error: Option<String>,
    pub in_progress_text: String,
    pub in_progress_reasoning: String,
    pub pending_confirmations: Vec<PendingConfirmation>,
    pub queued_messages: Vec<QueuedMessageSummary>,
    pub last_message_seq: i64,
}

impl fmt::Debug for AgentSyncSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentSyncSnapshot")
            .field("status", &self.status)
            .field("last_error", &self.last_error)
            .field("in_progress_text", &"[REDACTED]")
            .field("in_progress_reasoning", &"[REDACTED]")
            .field(
                "pending_confirmation_count",
                &self.pending_confirmations.len(),
            )
            .field("queued_message_count", &self.queued_messages.len())
            .field("last_message_seq", &self.last_message_seq)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AgentSubscriptionSync {
    pub generation: u64,
    pub snapshot: Option<AgentSyncSnapshot>,
}

impl fmt::Debug for AgentSubscriptionSync {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentSubscriptionSync")
            .field("generation", &self.generation)
            .field("has_snapshot", &self.snapshot.is_some())
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub enum AgentEvent {
    Status {
        status: String,
        last_error: Option<String>,
    },
    TextDelta {
        message_id: String,
        delta: String,
    },
    ReasoningDelta {
        message_id: String,
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: Value,
    },
    ToolError {
        tool_call_id: String,
        tool_name: String,
        output: Value,
    },
    ConfirmationRequest(PendingConfirmation),
    ConfirmationResolved {
        confirmation_id: String,
        status: String,
        reason: Option<String>,
    },
    MessagePersisted {
        message_id: String,
        seq: i64,
        role: String,
    },
    QueueUpdated {
        queued: Vec<QueuedMessageSummary>,
    },
    CredentialWarning {
        message_id: Option<String>,
        types: Vec<String>,
    },
    TurnFinished {
        session_status: String,
        last_message_seq: i64,
    },
    Error {
        message: String,
    },
}

impl fmt::Debug for AgentEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Status { .. } => "Status",
            Self::ToolResult { .. } => "ToolResult",
            Self::ToolError { .. } => "ToolError",
            Self::TextDelta { .. } => "TextDelta",
            Self::ReasoningDelta { .. } => "ReasoningDelta",
            Self::ToolCall { .. } => "ToolCall",
            Self::ConfirmationRequest(_) => "ConfirmationRequest",
            Self::ConfirmationResolved { .. } => "ConfirmationResolved",
            Self::MessagePersisted { .. } => "MessagePersisted",
            Self::QueueUpdated { .. } => "QueueUpdated",
            Self::CredentialWarning { .. } => "CredentialWarning",
            Self::TurnFinished { .. } => "TurnFinished",
            Self::Error { .. } => "Error",
        };
        formatter.write_str(name)
    }
}

#[derive(Clone, PartialEq)]
pub struct AgentEventEnvelope {
    pub session_id: String,
    pub seq: u64,
    pub event: AgentEvent,
}

impl fmt::Debug for AgentEventEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentEventEnvelope")
            .field("session_id", &self.session_id)
            .field("seq", &self.seq)
            .field("event", &self.event)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEnvironment {
    pub device_name: Option<String>,
    pub device_type: Option<String>,
    pub host: Option<String>,
    pub username: Option<String>,
    pub port: Option<i64>,
    pub tmux_session: Option<String>,
    pub timezone: String,
    pub now_iso: String,
    pub gateway_os: Option<String>,
    pub gateway_shell: Option<String>,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub locale: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolExecutionKind {
    Local,
    ProviderHosted,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub execution: ToolExecutionKind,
    pub requires_confirmation: bool,
}

#[derive(Clone, PartialEq)]
pub struct AgentToolCall {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
}

impl fmt::Debug for AgentToolCall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentToolCall")
            .field("tool_call_id", &self.tool_call_id)
            .field("tool_name", &self.tool_name)
            .field("input", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolAuthorization {
    ReadOnly,
    Automatic,
    Approved { confirmation_id: String },
}

#[derive(Clone, PartialEq)]
pub struct AgentToolOutput {
    pub value: Value,
    pub is_error: bool,
    pub terminal_tool: bool,
    pub terminal_failed: bool,
}

impl fmt::Debug for AgentToolOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentToolOutput")
            .field("value", &"[REDACTED]")
            .field("is_error", &self.is_error)
            .field("terminal_tool", &self.terminal_tool)
            .field("terminal_failed", &self.terminal_failed)
            .finish()
    }
}

pub struct ModelTurnRequest {
    pub endpoint: LanguageModelEndpoint,
    pub system_prompt: String,
    pub messages: Vec<Value>,
    pub tools: Vec<AgentToolDefinition>,
    pub max_steps: u32,
    pub max_retries: u32,
    pub responses_store: bool,
    pub control: AgentRunControl,
}

impl fmt::Debug for ModelTurnRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelTurnRequest")
            .field("endpoint", &self.endpoint)
            .field("system_prompt", &"[REDACTED]")
            .field("message_count", &self.messages.len())
            .field("tools", &self.tools)
            .field("max_steps", &self.max_steps)
            .field("max_retries", &self.max_retries)
            .field("responses_store", &self.responses_store)
            .field("control", &self.control)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub enum AgentStreamPart {
    TextDelta {
        message_id: String,
        text: String,
    },
    ReasoningDelta {
        message_id: String,
        text: String,
    },
    ToolCall(AgentToolCall),
    ToolResult {
        call: AgentToolCall,
        output: AgentToolOutput,
    },
    ToolError {
        call: AgentToolCall,
        message: String,
    },
    ToolOutputDenied {
        call: AgentToolCall,
    },
    ApprovalRequest {
        approval_id: String,
        call: AgentToolCall,
    },
    StepFinished {
        response_messages: Vec<Value>,
    },
    Error {
        message: String,
        retryable: bool,
    },
    Abort,
}

impl fmt::Debug for AgentStreamPart {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::TextDelta { .. } => "TextDelta",
            Self::ReasoningDelta { .. } => "ReasoningDelta",
            Self::ToolCall(_) => "ToolCall",
            Self::ToolResult { .. } => "ToolResult",
            Self::ToolError { .. } => "ToolError",
            Self::ToolOutputDenied { .. } => "ToolOutputDenied",
            Self::ApprovalRequest { .. } => "ApprovalRequest",
            Self::StepFinished { .. } => "StepFinished",
            Self::Error { .. } => "Error",
            Self::Abort => "Abort",
        };
        formatter.write_str(name)
    }
}

#[derive(Clone, Debug)]
pub struct AgentRunConfig {
    pub delta_flush_interval: Duration,
    pub delta_flush_max_bytes: usize,
    pub retry_delays: Vec<Duration>,
    pub llm_max_retries: u32,
    pub stream_idle_timeout: Duration,
    pub notify_turn_finished: bool,
    pub message_window_char_budget: usize,
}

impl Default for AgentRunConfig {
    fn default() -> Self {
        Self {
            delta_flush_interval: Duration::from_millis(40),
            delta_flush_max_bytes: 2_048,
            retry_delays: vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
            ],
            llm_max_retries: 3,
            stream_idle_timeout: Duration::from_secs(90),
            notify_turn_finished: true,
            message_window_char_budget: MESSAGE_WINDOW_CHAR_BUDGET,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum AgentNotificationTranslation {
    TurnFinished {
        title: String,
    },
    ConfirmationPending {
        title: String,
        tool_name: String,
    },
    Error {
        title: String,
        error: String,
    },
    CredentialWarning {
        session_title: String,
        types: Vec<String>,
    },
}

impl fmt::Debug for AgentNotificationTranslation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TurnFinished { title } => formatter
                .debug_struct("TurnFinished")
                .field("title", title)
                .finish(),
            Self::ConfirmationPending { title, tool_name } => formatter
                .debug_struct("ConfirmationPending")
                .field("title", title)
                .field("tool_name", tool_name)
                .finish(),
            Self::Error { title, .. } => formatter
                .debug_struct("Error")
                .field("title", title)
                .field("error", &"[REDACTED]")
                .finish(),
            Self::CredentialWarning {
                session_title,
                types,
            } => formatter
                .debug_struct("CredentialWarning")
                .field("session_title", session_title)
                .field("types", types)
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct AgentNotification {
    pub event_type: String,
    pub translation: AgentNotificationTranslation,
    pub session_id: String,
    pub session_title: String,
    pub device_id: Option<String>,
    pub pane_id: Option<String>,
    pub message: String,
    pub tool_name: Option<String>,
    pub confirmation_id: Option<String>,
}

impl fmt::Debug for AgentNotification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentNotification")
            .field("event_type", &self.event_type)
            .field("translation", &self.translation)
            .field("session_id", &self.session_id)
            .field("session_title", &self.session_title)
            .field("device_id", &self.device_id)
            .field("pane_id", &self.pane_id)
            .field("message", &"[REDACTED]")
            .field("tool_name", &self.tool_name)
            .field("confirmation_id", &self.confirmation_id)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmitUserMessageResult {
    Message { id: String, seq: i64 },
    Queued { id: String, seq: i64 },
}

pub fn validate_max_steps(value: i64) -> Option<u32> {
    (1..=100).contains(&value).then_some(value as u32)
}
