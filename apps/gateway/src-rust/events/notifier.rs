use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::{EventDraft, EventType, WebhookEvent};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EventSettings {
    pub bell_throttle_seconds: u64,
    pub notification_throttle_seconds: u64,
    pub disabled_notification_channels: HashSet<String>,
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct EventError {
    pub message: String,
}

impl EventError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait EventSettingsProvider: Send + Sync {
    async fn event_settings(&self) -> Result<EventSettings, EventError>;
}

pub trait EventClock: Send + Sync {
    fn now_millis(&self) -> u64;

    fn now_iso(&self) -> String;
}

#[async_trait]
pub trait NotificationChannel: Send + Sync {
    fn id(&self) -> &'static str;

    async fn notify(
        &self,
        event_type: EventType,
        event: Arc<WebhookEvent>,
    ) -> Result<(), EventError>;
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum RegisterChannelError {
    #[error("notification channel already registered: {0}")]
    Duplicate(String),
}

pub struct EventNotifier {
    settings: Arc<dyn EventSettingsProvider>,
    clock: Arc<dyn EventClock>,
    channels: BTreeMap<String, Arc<dyn NotificationChannel>>,
    bell_throttle: Mutex<HashMap<String, u64>>,
    notification_throttle: Mutex<HashMap<String, u64>>,
}

impl EventNotifier {
    pub fn new(settings: Arc<dyn EventSettingsProvider>, clock: Arc<dyn EventClock>) -> Self {
        Self {
            settings,
            clock,
            channels: BTreeMap::new(),
            bell_throttle: Mutex::new(HashMap::new()),
            notification_throttle: Mutex::new(HashMap::new()),
        }
    }

    pub fn register_channel(
        &mut self,
        channel: Arc<dyn NotificationChannel>,
    ) -> Result<(), RegisterChannelError> {
        let id = channel.id().to_owned();
        if self.channels.contains_key(&id) {
            return Err(RegisterChannelError::Duplicate(id));
        }
        self.channels.insert(id, channel);
        Ok(())
    }

    pub fn has_channel(&self, id: &str) -> bool {
        self.channels.contains_key(id)
    }

    pub async fn notify(
        &self,
        event_type: EventType,
        draft: EventDraft,
    ) -> Result<bool, EventError> {
        let timestamp = self.clock.now_iso();
        let settings = self.settings.event_settings().await?;
        let now_millis = self.clock.now_millis();
        if !self.passes_throttle(event_type, &draft, &settings, now_millis) {
            return Ok(false);
        }

        let event = Arc::new(WebhookEvent::from_draft(event_type, timestamp, draft));
        let mut tasks = tokio::task::JoinSet::new();
        for (id, channel) in &self.channels {
            if settings.disabled_notification_channels.contains(id) {
                continue;
            }
            let channel = channel.clone();
            let event = event.clone();
            tasks.spawn(async move { channel.notify(event_type, event).await });
        }

        let mut first_error = None;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    first_error.get_or_insert(error);
                }
                Err(error) => {
                    first_error.get_or_insert_with(|| {
                        EventError::new(format!("notification task failed: {error}"))
                    });
                }
            }
        }
        first_error.map_or(Ok(true), Err)
    }

    fn passes_throttle(
        &self,
        event_type: EventType,
        event: &EventDraft,
        settings: &EventSettings,
        now_millis: u64,
    ) -> bool {
        match event_type {
            EventType::TerminalBell => {
                let key = format!(
                    "{}:{}:{}",
                    event.device.id,
                    event
                        .tmux
                        .as_ref()
                        .and_then(|tmux| tmux.pane_id.as_deref())
                        .unwrap_or("-"),
                    event_type
                );
                passes_map_throttle(
                    &self.bell_throttle,
                    key,
                    settings.bell_throttle_seconds.saturating_mul(1_000),
                    now_millis,
                )
            }
            EventType::TerminalNotification => {
                let source = event
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("source"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                let key = format!(
                    "{}:{}:notification:{}",
                    event.device.id,
                    event
                        .tmux
                        .as_ref()
                        .and_then(|tmux| tmux.pane_id.as_deref())
                        .unwrap_or("-"),
                    source
                );
                passes_map_throttle(
                    &self.notification_throttle,
                    key,
                    settings.notification_throttle_seconds.saturating_mul(1_000),
                    now_millis,
                )
            }
            _ => true,
        }
    }
}

fn passes_map_throttle(
    entries: &Mutex<HashMap<String, u64>>,
    key: String,
    throttle_millis: u64,
    now_millis: u64,
) -> bool {
    if throttle_millis == 0 {
        return true;
    }
    let mut entries = entries
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if entries
        .get(&key)
        .is_some_and(|previous| now_millis.saturating_sub(*previous) < throttle_millis)
    {
        return false;
    }
    entries.insert(key, now_millis);
    true
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::events::{EventDevice, EventSite, EventTmux};

    struct Settings;

    #[async_trait]
    impl EventSettingsProvider for Settings {
        async fn event_settings(&self) -> Result<EventSettings, EventError> {
            Ok(EventSettings {
                bell_throttle_seconds: 6,
                notification_throttle_seconds: 3,
                disabled_notification_channels: HashSet::from(["disabled".to_owned()]),
            })
        }
    }

    struct Clock(AtomicU64);

    impl EventClock for Clock {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }

        fn now_iso(&self) -> String {
            "2026-08-12T00:00:00.000Z".to_owned()
        }
    }

    struct CountingChannel {
        id: &'static str,
        count: Arc<AtomicU64>,
    }

    #[async_trait]
    impl NotificationChannel for CountingChannel {
        fn id(&self) -> &'static str {
            self.id
        }

        async fn notify(
            &self,
            _event_type: EventType,
            _event: Arc<WebhookEvent>,
        ) -> Result<(), EventError> {
            self.count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn draft() -> EventDraft {
        EventDraft {
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
            tmux: Some(EventTmux {
                pane_id: Some("%1".to_owned()),
                ..EventTmux::default()
            }),
            payload: None,
        }
    }

    #[tokio::test]
    async fn applies_channel_disable_and_per_pane_bell_throttle() {
        let clock = Arc::new(Clock(AtomicU64::new(100_000)));
        let active_count = Arc::new(AtomicU64::new(0));
        let disabled_count = Arc::new(AtomicU64::new(0));
        let mut notifier = EventNotifier::new(Arc::new(Settings), clock.clone());
        notifier
            .register_channel(Arc::new(CountingChannel {
                id: "active",
                count: active_count.clone(),
            }))
            .expect("register active channel");
        notifier
            .register_channel(Arc::new(CountingChannel {
                id: "disabled",
                count: disabled_count.clone(),
            }))
            .expect("register disabled channel");

        assert!(notifier
            .notify(EventType::TerminalBell, draft())
            .await
            .expect("first bell"));
        assert!(!notifier
            .notify(EventType::TerminalBell, draft())
            .await
            .expect("throttled bell"));
        clock.0.store(106_000, Ordering::SeqCst);
        assert!(notifier
            .notify(EventType::TerminalBell, draft())
            .await
            .expect("bell after throttle"));

        assert_eq!(active_count.load(Ordering::SeqCst), 2);
        assert_eq!(disabled_count.load(Ordering::SeqCst), 0);
    }
}
