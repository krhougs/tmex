use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tmex_protocol::{StateSnapshot, WatchEvent};

use crate::events::{EventDraft, EventType};

pub type WatchFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
pub type WatchIntervalCallback = Arc<dyn Fn() -> WatchFuture + Send + Sync + 'static>;

pub trait WatchSchedule: Send + Sync {
    fn cancel(&self);
}

pub trait WatchSubscription: Send + Sync {
    fn detach(&self);
}

pub trait WatchDeviceListener: Send + Sync {
    fn on_snapshot(&self, snapshot: StateSnapshot);
    fn on_close(&self);
}

#[async_trait]
pub trait WatchDevice: Send + Sync {
    async fn connect(&self) -> Result<(), WatchRuntimeError>;

    async fn capture_pane_text(&self, pane_id: &str) -> Result<String, WatchRuntimeError>;

    fn subscribe(
        &self,
        listener: Arc<dyn WatchDeviceListener>,
    ) -> Result<Arc<dyn WatchSubscription>, WatchRuntimeError>;

    fn request_snapshot(&self) -> Result<(), WatchRuntimeError>;

    fn custom_name(&self, _kind: WatchTmuxEntityKind, _native_id: &str) -> Option<String> {
        None
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WatchTmuxEntityKind {
    Window,
    Pane,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WatchLlmOperation {
    Confirm,
    Summary,
    Judge,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchLlmRequest {
    pub operation: WatchLlmOperation,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub prompt: String,
    pub max_retries: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchLlmResponse {
    Confirm { confirmed: bool, reason: String },
    Summary { summary: String },
    Judge { matched: bool, reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchMessage {
    MatchTriggered {
        name: String,
        text: String,
    },
    UnchangedTriggered {
        name: String,
        value: String,
        minutes: i64,
    },
    LlmTriggered {
        name: String,
        reason: String,
    },
    SummaryTriggered {
        name: String,
        summary: String,
    },
    UnconfirmedSuffix,
    ModelUnavailable {
        name: String,
        message: String,
    },
    RuleError {
        name: String,
        count: i64,
        message: String,
    },
    PaneGone {
        name: String,
        pane_id: String,
    },
}

impl WatchMessage {
    pub fn fallback_english(&self) -> String {
        match self {
            Self::MatchTriggered { name, text } => {
                format!("Watch \"{name}\" matched: {text}")
            }
            Self::UnchangedTriggered {
                name,
                value,
                minutes,
            } => format!(
                "Watch \"{name}\" value \"{value}\" has been unchanged for {minutes} minutes"
            ),
            Self::LlmTriggered { name, reason } => {
                format!("Watch \"{name}\" condition met: {reason}")
            }
            Self::SummaryTriggered { name, summary } => {
                format!("Watch \"{name}\": {summary}")
            }
            Self::UnconfirmedSuffix => " (model unavailable, not LLM-confirmed)".to_owned(),
            Self::ModelUnavailable { name, message } => {
                format!("Watch \"{name}\" model call failed: {message}")
            }
            Self::RuleError {
                name,
                count,
                message,
            } => format!(
                "Watch \"{name}\" failed {count} times in a row and has been disabled: {message}"
            ),
            Self::PaneGone { name, pane_id } => format!(
                "Watch \"{name}\" pane ({pane_id}) was destroyed; the rule has been removed"
            ),
        }
    }
}

#[async_trait]
pub trait WatchRuntime: Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>;

    fn schedule_interval(
        &self,
        interval: Duration,
        callback: WatchIntervalCallback,
    ) -> Result<Arc<dyn WatchSchedule>, WatchRuntimeError>;

    fn spawn(&self, future: WatchFuture);

    async fn acquire_device(
        &self,
        device_id: &str,
    ) -> Result<Arc<dyn WatchDevice>, WatchRuntimeError>;

    async fn release_device(
        &self,
        device_id: &str,
        device: Arc<dyn WatchDevice>,
    ) -> Result<(), WatchRuntimeError>;

    async fn generate(
        &self,
        request: WatchLlmRequest,
    ) -> Result<WatchLlmResponse, WatchRuntimeError>;

    async fn notify(
        &self,
        event_type: EventType,
        event: EventDraft,
    ) -> Result<(), WatchRuntimeError>;

    fn broadcast(&self, event: WatchEvent) -> Result<(), WatchRuntimeError>;

    fn device_closed(&self, _device_id: &str) -> Result<(), WatchRuntimeError> {
        Ok(())
    }

    fn format_message(&self, message: &WatchMessage) -> String {
        message.fallback_english()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct WatchRuntimeError {
    message: String,
}

impl WatchRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<&str> for WatchRuntimeError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

impl From<String> for WatchRuntimeError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}
