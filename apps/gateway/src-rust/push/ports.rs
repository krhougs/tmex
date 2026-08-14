use async_trait::async_trait;
use std::collections::HashMap;
use tmex_protocol::DeviceEvent;

use crate::agent::{AgentStopReason, AgentSupervisor};
use crate::database::repository::{
    DeviceRuntimeStatusUpdate, Repository, RepositorySiteSettingsDefaults,
};
use crate::entity::{devices, site_settings};
use crate::events::{EventDraft, EventNotifier, EventType};
use crate::i18n::GatewayI18n;
use crate::telegram::{TelegramOutgoingMessage, TelegramService};

#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
#[error("{message}")]
pub struct PushError {
    pub message: String,
}

impl PushError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait PushStore: Send + Sync {
    async fn list_devices(&self) -> Result<Vec<devices::Model>, PushError>;

    async fn get_device(&self, device_id: &str) -> Result<Option<devices::Model>, PushError>;

    async fn site_settings(&self) -> Result<site_settings::Model, PushError>;

    async fn persist_connection_alert(
        &self,
        device_id: &str,
        timestamp: String,
        message: String,
        error_type: String,
    ) -> Result<(), PushError>;
}

#[derive(Clone)]
pub struct RepositoryPushStore {
    repository: Repository,
    defaults: RepositorySiteSettingsDefaults,
}

impl RepositoryPushStore {
    pub fn new(repository: Repository, defaults: RepositorySiteSettingsDefaults) -> Self {
        Self {
            repository,
            defaults,
        }
    }
}

#[async_trait]
impl PushStore for RepositoryPushStore {
    async fn list_devices(&self) -> Result<Vec<devices::Model>, PushError> {
        self.repository
            .get_all_devices()
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn get_device(&self, device_id: &str) -> Result<Option<devices::Model>, PushError> {
        self.repository
            .get_device_by_id(device_id)
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn site_settings(&self) -> Result<site_settings::Model, PushError> {
        self.repository
            .get_site_settings(&self.defaults)
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn persist_connection_alert(
        &self,
        device_id: &str,
        timestamp: String,
        message: String,
        error_type: String,
    ) -> Result<(), PushError> {
        self.repository
            .update_device_runtime_status(
                device_id,
                DeviceRuntimeStatusUpdate {
                    last_seen_at: Some(Some(timestamp)),
                    last_error: Some(Some(message)),
                    last_error_type: Some(Some(error_type)),
                    ..DeviceRuntimeStatusUpdate::default()
                },
            )
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }
}

pub trait PushTranslator: Send + Sync {
    fn translate(&self, key: &str, parameters: &[(&str, String)], default: Option<&str>) -> String;
}

impl PushTranslator for GatewayI18n {
    fn translate(&self, key: &str, parameters: &[(&str, String)], default: Option<&str>) -> String {
        let parameters = parameters
            .iter()
            .map(|(name, value)| (*name, value.clone()))
            .collect::<HashMap<_, _>>();
        let translated = self.translate_with(key, &parameters);
        if translated == key {
            default.unwrap_or(key).to_owned()
        } else {
            translated
        }
    }
}

pub trait DeviceEventBroadcaster: Send + Sync {
    fn broadcast(&self, event: DeviceEvent) -> Result<(), PushError>;
}

#[async_trait]
pub trait PushEventSink: Send + Sync {
    async fn emit(&self, event_type: EventType, draft: EventDraft) -> Result<(), PushError>;
}

#[async_trait]
impl PushEventSink for EventNotifier {
    async fn emit(&self, event_type: EventType, draft: EventDraft) -> Result<(), PushError> {
        self.notify(event_type, draft)
            .await
            .map(|_| ())
            .map_err(|error| PushError::new(error.to_string()))
    }
}

#[async_trait]
pub trait PushTelegramSender: Send + Sync {
    async fn send_text(&self, text: String) -> Result<(), PushError>;
}

#[async_trait]
impl PushTelegramSender for TelegramService {
    async fn send_text(&self, text: String) -> Result<(), PushError> {
        self.send_to_authorized_chats(TelegramOutgoingMessage::text(text))
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }
}

#[async_trait]
pub trait PushDeviceCloseSink: Send + Sync {
    async fn device_closed(&self, device_id: &str) -> Result<(), PushError>;
}

#[async_trait]
impl PushDeviceCloseSink for AgentSupervisor {
    async fn device_closed(&self, device_id: &str) -> Result<(), PushError> {
        self.stop_sessions_for_device(device_id, AgentStopReason::PaneLost)
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }
}

pub(crate) fn device_event(
    device_id: &str,
    error_type: &str,
    message: &str,
    raw_message: &str,
) -> DeviceEvent {
    DeviceEvent {
        device_id: device_id.to_owned(),
        event_type: 3,
        error_type: Some(error_type.to_owned()),
        message: Some(message.to_owned()),
        raw_message: Some(raw_message.to_owned()),
    }
}
