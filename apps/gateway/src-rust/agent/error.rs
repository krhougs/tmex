use std::fmt;

use super::{redact_known_secret, redact_secrets};

#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AgentPortError {
    message: String,
}

impl AgentPortError {
    pub fn new(message: impl AsRef<str>) -> Self {
        Self {
            message: redact_secrets(message.as_ref()).text,
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for AgentPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentPortError")
            .field("message", &self.message)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AgentModelError {
    message: String,
    retryable: bool,
}

impl AgentModelError {
    pub fn new(message: impl AsRef<str>, retryable: bool) -> Self {
        Self {
            message: redact_secrets(message.as_ref()).text,
            retryable,
        }
    }

    pub fn sanitized_with_secret(&self, secret: Option<&str>) -> Self {
        Self {
            message: redact_known_secret(&self.message, secret),
            retryable: self.retryable,
        }
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for AgentModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentModelError")
            .field("message", &self.message)
            .field("retryable", &self.retryable)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("agent session not found")]
    SessionNotFound,
    #[error("agent session is busy")]
    SessionBusy,
    #[error("agent session is awaiting confirmation")]
    AwaitingConfirmation,
    #[error("agent confirmation not found")]
    ConfirmationNotFound,
    #[error("agent confirmation was already decided")]
    ConfirmationAlreadyDecided,
    #[error("agent session is orphaned")]
    SessionOrphaned,
    #[error("queued agent message not found")]
    QueuedMessageNotFound,
    #[error("invalid persisted agent data: {0}")]
    InvalidPersistedData(String),
    #[error(transparent)]
    Port(#[from] AgentPortError),
    #[error(transparent)]
    Provider(#[from] crate::llm::ProviderRegistryError),
    #[error(transparent)]
    Model(#[from] AgentModelError),
}
