use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::{EventError, EventType, NotificationChannel, WebhookEvent};

const WEBHOOK_REFRESH_MILLIS: u64 = 60_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebhookEndpoint {
    pub id: String,
    pub enabled: bool,
    pub url: String,
    pub secret: String,
    pub event_mask: Vec<EventType>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WebhookPushSettings {
    pub enable_bell_push: bool,
    pub enable_notification_push: bool,
}

#[async_trait]
pub trait WebhookConfigProvider: Send + Sync {
    async fn push_settings(&self) -> Result<WebhookPushSettings, EventError>;

    async fn webhook_endpoints(&self) -> Result<Vec<WebhookEndpoint>, EventError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebhookRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebhookResponse {
    pub status: u16,
}

#[async_trait]
pub trait WebhookTransport: Send + Sync {
    async fn send(&self, request: WebhookRequest) -> Result<WebhookResponse, EventError>;
}

#[derive(Default)]
struct WebhookCache {
    endpoints: Vec<WebhookEndpoint>,
    last_refresh_millis: u64,
    initialized: bool,
}

pub struct WebhookChannel {
    config: Arc<dyn WebhookConfigProvider>,
    transport: Arc<dyn WebhookTransport>,
    now_millis: Arc<dyn Fn() -> u64 + Send + Sync>,
    cache: Mutex<WebhookCache>,
}

impl WebhookChannel {
    pub fn new(
        config: Arc<dyn WebhookConfigProvider>,
        transport: Arc<dyn WebhookTransport>,
        now_millis: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            config,
            transport,
            now_millis,
            cache: Mutex::new(WebhookCache::default()),
        }
    }

    async fn endpoints(&self) -> Result<Vec<WebhookEndpoint>, EventError> {
        let now = (self.now_millis)();
        let refresh = {
            let cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            !cache.initialized
                || now.saturating_sub(cache.last_refresh_millis) >= WEBHOOK_REFRESH_MILLIS
        };
        if refresh {
            let endpoints = self
                .config
                .webhook_endpoints()
                .await?
                .into_iter()
                .filter(|endpoint| endpoint.enabled)
                .collect();
            let mut cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            cache.endpoints = endpoints;
            cache.last_refresh_millis = now;
            cache.initialized = true;
        }
        Ok(self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .endpoints
            .clone())
    }

    async fn deliver(
        transport: Arc<dyn WebhookTransport>,
        endpoint: WebhookEndpoint,
        event: Arc<WebhookEvent>,
        body: Vec<u8>,
    ) -> Result<(), EventError> {
        let signature = webhook_hmac_hex(endpoint.secret.as_bytes(), &body)?;
        let request = WebhookRequest {
            url: endpoint.url.clone(),
            headers: vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("X-Tmex-Signature".to_owned(), format!("sha256={signature}")),
                ("X-Tmex-Event".to_owned(), event.event_type.to_string()),
                ("X-Tmex-Timestamp".to_owned(), event.timestamp.clone()),
            ],
            body,
        };
        match transport.send(request).await {
            Ok(response) if (200..300).contains(&response.status) => {}
            Ok(response) => tracing::error!(
                url = %endpoint.url,
                status = response.status,
                "webhook returned a non-success status"
            ),
            Err(error) => tracing::error!(
                url = %endpoint.url,
                %error,
                "failed to send webhook"
            ),
        }
        Ok(())
    }
}

#[async_trait]
impl NotificationChannel for WebhookChannel {
    fn id(&self) -> &'static str {
        "webhook"
    }

    async fn notify(
        &self,
        event_type: EventType,
        event: Arc<WebhookEvent>,
    ) -> Result<(), EventError> {
        let settings = self.config.push_settings().await?;
        if event_type == EventType::TerminalBell {
            if !settings.enable_bell_push {
                return Ok(());
            }
        } else if !settings.enable_notification_push {
            return Ok(());
        }

        let body = serde_json::to_vec(event.as_ref())
            .map_err(|error| EventError::new(format!("failed to serialize webhook: {error}")))?;
        let mut tasks = tokio::task::JoinSet::new();
        for endpoint in self
            .endpoints()
            .await?
            .into_iter()
            .filter(|endpoint| endpoint.event_mask.contains(&event_type))
        {
            let transport = self.transport.clone();
            let event = event.clone();
            let body = body.clone();
            tasks.spawn(async move { Self::deliver(transport, endpoint, event, body).await });
        }
        while let Some(result) = tasks.join_next().await {
            result.map_err(|error| {
                EventError::new(format!("webhook delivery task failed: {error}"))
            })??;
        }
        Ok(())
    }
}

pub fn webhook_hmac_hex(secret: &[u8], body: &[u8]) -> Result<String, EventError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)
        .map_err(|error| EventError::new(format!("failed to initialize webhook HMAC: {error}")))?;
    mac.update(body);
    let bytes = mac.finalize().into_bytes();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_sha256_webhook_contract() {
        assert_eq!(
            webhook_hmac_hex(b"key", b"The quick brown fox jumps over the lazy dog")
                .expect("HMAC accepts arbitrary key lengths"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }
}
