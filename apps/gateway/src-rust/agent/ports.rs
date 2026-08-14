use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::database::repository::{
    AgentConfirmationDecision, AgentSessionUpdate, CreateAgentConfirmationInput, Repository,
};
use crate::entity::{
    agent_confirmations, agent_messages, agent_queued_messages, agent_sessions, devices,
};
use crate::llm::{LanguageModelEndpoint, ProviderRegistry};

use super::{
    AgentEnvironment, AgentEventEnvelope, AgentModelError, AgentNotification, AgentPortError,
    AgentRunControl, AgentStreamPart, AgentToolCall, AgentToolDefinition, AgentToolOutput,
    ModelTurnRequest, ToolAuthorization,
};

#[async_trait]
pub trait AgentStore: Send + Sync {
    async fn get_session(
        &self,
        session_id: &str,
    ) -> Result<Option<agent_sessions::Model>, AgentPortError>;
    async fn sessions_by_status(
        &self,
        status: &str,
    ) -> Result<Vec<agent_sessions::Model>, AgentPortError>;
    async fn update_session(
        &self,
        session_id: &str,
        update: AgentSessionUpdate,
    ) -> Result<Option<agent_sessions::Model>, AgentPortError>;
    async fn get_device(&self, device_id: &str) -> Result<Option<devices::Model>, AgentPortError>;
    async fn append_message(
        &self,
        session_id: &str,
        role: &str,
        content: Value,
    ) -> Result<agent_messages::Model, AgentPortError>;
    async fn list_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_messages::Model>, AgentPortError>;
    async fn max_message_seq(&self, session_id: &str) -> Result<i64, AgentPortError>;
    async fn enqueue_message(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentPortError>;
    async fn list_queued_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_queued_messages::Model>, AgentPortError>;
    async fn get_queued_message(
        &self,
        item_id: &str,
    ) -> Result<Option<agent_queued_messages::Model>, AgentPortError>;
    async fn update_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<Option<agent_queued_messages::Model>, AgentPortError>;
    async fn delete_queued_message(&self, item_id: &str) -> Result<(), AgentPortError>;
    async fn delete_all_queued_messages(&self, session_id: &str) -> Result<(), AgentPortError>;
    async fn drain_queued_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_messages::Model>, AgentPortError>;
    async fn create_confirmation(
        &self,
        input: CreateAgentConfirmationInput,
    ) -> Result<agent_confirmations::Model, AgentPortError>;
    async fn get_confirmation(
        &self,
        confirmation_id: &str,
    ) -> Result<Option<agent_confirmations::Model>, AgentPortError>;
    async fn pending_confirmations(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_confirmations::Model>, AgentPortError>;
    async fn decide_confirmation(
        &self,
        confirmation_id: &str,
        decision: AgentConfirmationDecision,
    ) -> Result<Option<agent_confirmations::Model>, AgentPortError>;
}

fn repository_error(error: impl std::fmt::Display) -> AgentPortError {
    AgentPortError::new(error.to_string())
}

#[async_trait]
impl AgentStore for Repository {
    async fn get_session(
        &self,
        session_id: &str,
    ) -> Result<Option<agent_sessions::Model>, AgentPortError> {
        self.get_agent_session_by_id(session_id)
            .await
            .map_err(repository_error)
    }

    async fn sessions_by_status(
        &self,
        status: &str,
    ) -> Result<Vec<agent_sessions::Model>, AgentPortError> {
        self.get_agent_sessions_by_status(status)
            .await
            .map_err(repository_error)
    }

    async fn update_session(
        &self,
        session_id: &str,
        update: AgentSessionUpdate,
    ) -> Result<Option<agent_sessions::Model>, AgentPortError> {
        self.update_agent_session(session_id, update)
            .await
            .map_err(repository_error)
    }

    async fn get_device(&self, device_id: &str) -> Result<Option<devices::Model>, AgentPortError> {
        self.get_device_by_id(device_id)
            .await
            .map_err(repository_error)
    }

    async fn append_message(
        &self,
        session_id: &str,
        role: &str,
        content: Value,
    ) -> Result<agent_messages::Model, AgentPortError> {
        self.append_agent_message(session_id, role, content)
            .await
            .map_err(repository_error)
    }

    async fn list_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_messages::Model>, AgentPortError> {
        self.list_agent_messages(session_id, None)
            .await
            .map_err(repository_error)
    }

    async fn max_message_seq(&self, session_id: &str) -> Result<i64, AgentPortError> {
        self.get_max_agent_message_seq(session_id)
            .await
            .map_err(repository_error)
    }

    async fn enqueue_message(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentPortError> {
        self.enqueue_agent_message(session_id, text)
            .await
            .map_err(repository_error)
    }

    async fn list_queued_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_queued_messages::Model>, AgentPortError> {
        self.list_queued_agent_messages(session_id)
            .await
            .map_err(repository_error)
    }

    async fn get_queued_message(
        &self,
        item_id: &str,
    ) -> Result<Option<agent_queued_messages::Model>, AgentPortError> {
        self.get_queued_agent_message_by_id(item_id)
            .await
            .map_err(repository_error)
    }

    async fn update_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<Option<agent_queued_messages::Model>, AgentPortError> {
        self.update_queued_agent_message(item_id, text)
            .await
            .map_err(repository_error)
    }

    async fn delete_queued_message(&self, item_id: &str) -> Result<(), AgentPortError> {
        self.delete_queued_agent_message(item_id)
            .await
            .map_err(repository_error)
    }

    async fn delete_all_queued_messages(&self, session_id: &str) -> Result<(), AgentPortError> {
        self.delete_all_queued_agent_messages(session_id)
            .await
            .map_err(repository_error)
    }

    async fn drain_queued_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_messages::Model>, AgentPortError> {
        self.drain_queued_agent_messages(session_id)
            .await
            .map_err(repository_error)
    }

    async fn create_confirmation(
        &self,
        input: CreateAgentConfirmationInput,
    ) -> Result<agent_confirmations::Model, AgentPortError> {
        self.create_agent_confirmation(input)
            .await
            .map_err(repository_error)
    }

    async fn get_confirmation(
        &self,
        confirmation_id: &str,
    ) -> Result<Option<agent_confirmations::Model>, AgentPortError> {
        self.get_agent_confirmation_by_id(confirmation_id)
            .await
            .map_err(repository_error)
    }

    async fn pending_confirmations(
        &self,
        session_id: &str,
    ) -> Result<Vec<agent_confirmations::Model>, AgentPortError> {
        self.list_pending_agent_confirmations(session_id)
            .await
            .map_err(repository_error)
    }

    async fn decide_confirmation(
        &self,
        confirmation_id: &str,
        decision: AgentConfirmationDecision,
    ) -> Result<Option<agent_confirmations::Model>, AgentPortError> {
        self.decide_agent_confirmation(confirmation_id, decision)
            .await
            .map_err(repository_error)
    }
}

#[async_trait]
pub trait AgentProviderResolver: Send + Sync {
    async fn resolve_endpoint(
        &self,
        provider_id: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<LanguageModelEndpoint, crate::llm::ProviderRegistryError>;
}

#[async_trait]
impl AgentProviderResolver for ProviderRegistry {
    async fn resolve_endpoint(
        &self,
        provider_id: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<LanguageModelEndpoint, crate::llm::ProviderRegistryError> {
        self.resolve_language_model(provider_id, model_id).await
    }
}

#[async_trait]
pub trait AgentEventSink: Send + Sync {
    async fn emit(&self, event: AgentEventEnvelope) -> Result<(), AgentPortError>;
}

#[async_trait]
pub trait AgentNotificationSink: Send + Sync {
    async fn notify(&self, notification: AgentNotification) -> Result<(), AgentPortError>;
}

#[async_trait]
pub trait AgentEnvironmentSource: Send + Sync {
    async fn collect(
        &self,
        device: Option<&devices::Model>,
    ) -> Result<AgentEnvironment, AgentPortError>;
}

#[async_trait]
pub trait AgentToolExecutor: Send + Sync {
    fn definitions(&self) -> Vec<AgentToolDefinition>;
    fn requires_confirmation(&self, tool_name: &str, input: &Value) -> bool;
    async fn execute(
        &self,
        call: AgentToolCall,
        authorization: ToolAuthorization,
    ) -> Result<AgentToolOutput, AgentPortError>;
}

#[async_trait]
pub trait AgentToolSession: Send + Sync {
    fn executor(&self) -> Arc<dyn AgentToolExecutor>;
    async fn terminal_is_terminated(&self) -> bool;
    async fn close(&self);
}

#[async_trait]
pub trait AgentToolFactory: Send + Sync {
    async fn create(
        &self,
        session: &agent_sessions::Model,
        endpoint: &LanguageModelEndpoint,
    ) -> Result<Box<dyn AgentToolSession>, AgentPortError>;
}

#[async_trait]
pub trait AgentStream: Send {
    async fn next_part(&mut self) -> Result<Option<AgentStreamPart>, AgentModelError>;
}

#[async_trait]
pub trait AgentModelDriver: Send + Sync {
    async fn start_turn(
        &self,
        request: ModelTurnRequest,
        tools: Arc<dyn AgentToolExecutor>,
    ) -> Result<Box<dyn AgentStream>, AgentModelError>;

    async fn generate_title(
        &self,
        endpoint: &LanguageModelEndpoint,
        prompt: &str,
    ) -> Result<String, AgentModelError>;
}

#[async_trait]
pub trait AgentClock: Send + Sync {
    async fn sleep(&self, duration: Duration);
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TokioAgentClock;

#[async_trait]
impl AgentClock for TokioAgentClock {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

#[async_trait]
pub trait AgentRunLauncher: Send + Sync {
    async fn run(
        &self,
        session_id: String,
        control: AgentRunControl,
    ) -> Result<super::AgentRunOutcome, super::AgentError>;

    fn in_progress(&self, session_id: &str) -> (String, String);
}
