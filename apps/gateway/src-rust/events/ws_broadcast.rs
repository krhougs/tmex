use std::sync::Arc;

use async_trait::async_trait;
use chrono::DateTime;
use tmex_protocol::EventNotifyS2c;

use super::{EventError, EventType, NotificationChannel, WebhookEvent};

pub trait EventNotifyBroadcaster: Send + Sync {
    fn broadcast(&self, event: EventNotifyS2c) -> Result<(), EventError>;
}

pub struct WsBroadcastChannel {
    broadcaster: Arc<dyn EventNotifyBroadcaster>,
    now_millis: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl WsBroadcastChannel {
    pub fn new(
        broadcaster: Arc<dyn EventNotifyBroadcaster>,
        now_millis: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            broadcaster,
            now_millis,
        }
    }
}

#[async_trait]
impl NotificationChannel for WsBroadcastChannel {
    fn id(&self) -> &'static str {
        "ws-broadcast"
    }

    async fn notify(
        &self,
        event_type: EventType,
        event: Arc<WebhookEvent>,
    ) -> Result<(), EventError> {
        let event_json = match serde_json::to_string(event.as_ref()) {
            Ok(event_json) => event_json,
            Err(error) => {
                tracing::error!(%error, "failed to serialize WebSocket notification event");
                return Ok(());
            }
        };
        let timestamp = DateTime::parse_from_rfc3339(&event.timestamp)
            .ok()
            .and_then(|timestamp| u64::try_from(timestamp.timestamp_millis()).ok())
            .unwrap_or_else(|| (self.now_millis)());
        if let Err(error) = self.broadcaster.broadcast(EventNotifyS2c {
            event_type: event_type.to_string(),
            event_json,
            timestamp,
        }) {
            tracing::error!(%error, "failed to broadcast WebSocket notification event");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Map;

    use super::*;
    use crate::events::{EventDevice, EventSite};

    #[derive(Default)]
    struct RecordingBroadcaster {
        events: Mutex<Vec<EventNotifyS2c>>,
    }

    impl EventNotifyBroadcaster for RecordingBroadcaster {
        fn broadcast(&self, event: EventNotifyS2c) -> Result<(), EventError> {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(event);
            Ok(())
        }
    }

    #[tokio::test]
    async fn broadcasts_the_legacy_notification_wire_payload() {
        let broadcaster = Arc::new(RecordingBroadcaster::default());
        let channel = WsBroadcastChannel::new(broadcaster.clone(), Arc::new(|| 7));
        let event = Arc::new(WebhookEvent {
            site: EventSite {
                name: "tmex".to_owned(),
                url: "https://example.test".to_owned(),
            },
            device: EventDevice {
                id: "local".to_owned(),
                name: "Local".to_owned(),
                device_type: "local".to_owned(),
                host: None,
            },
            tmux: None,
            payload: Some(Map::new()),
            event_type: EventType::WatchRuleError,
            timestamp: "2026-08-12T08:09:10.123Z".to_owned(),
        });

        channel
            .notify(EventType::WatchRuleError, event)
            .await
            .expect("best-effort WebSocket notification");

        let events = broadcaster
            .events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "watch_rule_error");
        assert_eq!(events[0].timestamp, 1_786_522_150_123);
        let decoded: WebhookEvent =
            serde_json::from_str(&events[0].event_json).expect("event JSON");
        assert_eq!(decoded.event_type, EventType::WatchRuleError);
    }
}
