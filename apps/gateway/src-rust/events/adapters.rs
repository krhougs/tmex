use std::collections::HashSet;

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};

use crate::database::repository::{Repository, RepositorySiteSettingsDefaults};

use super::{
    EventClock, EventError, EventSettings, EventSettingsProvider, EventType, WebhookConfigProvider,
    WebhookEndpoint, WebhookPushSettings, WebhookRequest, WebhookResponse, WebhookTransport,
};

#[derive(Clone)]
pub struct RepositoryEventConfig {
    repository: Repository,
    defaults: RepositorySiteSettingsDefaults,
}

impl RepositoryEventConfig {
    pub fn new(repository: Repository, defaults: RepositorySiteSettingsDefaults) -> Self {
        Self {
            repository,
            defaults,
        }
    }

    async fn site_settings(&self) -> Result<crate::entity::site_settings::Model, EventError> {
        self.repository
            .get_site_settings(&self.defaults)
            .await
            .map_err(|error| EventError::new(error.to_string()))
    }
}

#[async_trait]
impl EventSettingsProvider for RepositoryEventConfig {
    async fn event_settings(&self) -> Result<EventSettings, EventError> {
        let settings = self.site_settings().await?;
        let disabled_notification_channels =
            serde_json::from_str::<Vec<String>>(&settings.disabled_notification_channels)
                .unwrap_or_default()
                .into_iter()
                .collect::<HashSet<_>>();
        Ok(EventSettings {
            bell_throttle_seconds: settings.bell_throttle_seconds.max(0) as u64,
            notification_throttle_seconds: settings.notification_throttle_seconds.max(0) as u64,
            disabled_notification_channels,
        })
    }
}

#[async_trait]
impl WebhookConfigProvider for RepositoryEventConfig {
    async fn push_settings(&self) -> Result<WebhookPushSettings, EventError> {
        let settings = self.site_settings().await?;
        Ok(WebhookPushSettings {
            enable_bell_push: settings.enable_bell_push != 0,
            enable_notification_push: settings.enable_notification_push != 0,
        })
    }

    async fn webhook_endpoints(&self) -> Result<Vec<WebhookEndpoint>, EventError> {
        self.repository
            .get_all_webhook_endpoints()
            .await
            .map_err(|error| EventError::new(error.to_string()))
            .map(|endpoints| {
                endpoints
                    .into_iter()
                    .map(|endpoint| WebhookEndpoint {
                        id: endpoint.id,
                        enabled: endpoint.enabled != 0,
                        url: endpoint.url,
                        secret: endpoint.secret,
                        event_mask: serde_json::from_str::<Vec<String>>(&endpoint.event_mask)
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|value| EventType::parse(&value))
                            .collect(),
                    })
                    .collect()
            })
    }
}

#[derive(Clone, Default)]
pub struct SystemEventClock;

impl EventClock for SystemEventClock {
    fn now_millis(&self) -> u64 {
        Utc::now().timestamp_millis().max(0) as u64
    }

    fn now_iso(&self) -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }
}

#[derive(Clone, Default)]
pub struct ReqwestWebhookTransport {
    client: reqwest::Client,
}

impl ReqwestWebhookTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl WebhookTransport for ReqwestWebhookTransport {
    async fn send(&self, request: WebhookRequest) -> Result<WebhookResponse, EventError> {
        let mut builder = self.client.post(&request.url);
        for (name, value) in request.headers {
            builder = builder.header(&name, &value);
        }
        let response = builder
            .body(request.body)
            .send()
            .await
            .map_err(|error| EventError::new(error.to_string()))?;
        Ok(WebhookResponse {
            status: response.status().as_u16(),
        })
    }
}
