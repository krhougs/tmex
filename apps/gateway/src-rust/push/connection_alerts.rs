use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::entity::devices;
use crate::events::{EventClock, EventDevice, EventDraft, EventSite, EventTmux, EventType};

use super::ports::device_event;
use super::{DeviceEventBroadcaster, PushEventSink, PushStore, PushTelegramSender, PushTranslator};

const NOTIFY_THROTTLE_MILLIS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionAlertSource {
    Connect,
    Runtime,
    Close,
    Probe,
}

#[derive(Clone, Debug)]
pub struct ConnectionAlertInput {
    pub device: devices::Model,
    pub error: String,
    pub source: ConnectionAlertSource,
    pub silent_telegram: bool,
    pub persist: bool,
    pub session_closed_emitted: bool,
}

impl ConnectionAlertInput {
    pub fn new(
        device: devices::Model,
        error: impl Into<String>,
        source: ConnectionAlertSource,
    ) -> Self {
        Self {
            device,
            error: error.into(),
            source,
            silent_telegram: false,
            persist: true,
            session_closed_emitted: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassifiedConnectionAlert {
    pub error_type: String,
    pub message_key: String,
    pub message: String,
    pub raw_message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectionErrorClassification {
    pub error_type: &'static str,
    pub message_key: &'static str,
    pub includes_raw_message: bool,
}

pub fn classify_connection_error(message: &str) -> ConnectionErrorClassification {
    let message = message.to_lowercase();
    let classified = if message.contains("ssh_config_ref_not_supported") {
        (
            "ssh_config_ref_not_supported",
            "sshError.configRefNotSupported",
        )
    } else if message.contains("ssh_auth_sock") || message.contains("auth_sock") {
        ("agent_unavailable", "sshError.agentUnavailable")
    } else if message.contains("agent")
        && (message.contains("no identities") || message.contains("failure"))
    {
        ("agent_no_identity", "sshError.agentNoIdentities")
    } else if message.contains("permission denied") {
        ("auth_failed", "sshError.authFailed")
    } else if message.contains("all configured authentication methods failed") {
        ("auth_failed", "sshError.authFailedGeneric")
    } else if message.contains("enetunreach") || message.contains("ehostunreach") {
        ("network_unreachable", "sshError.networkUnreachable")
    } else if message.contains("connect refused")
        || message.contains("connection refused")
        || message.contains("econnrefused")
    {
        ("connection_refused", "sshError.connectionRefused")
    } else if message.contains("timeout") || message.contains("etimedout") {
        ("timeout", "sshError.connectionTimeout")
    } else if message.contains("host not found")
        || message.contains("getaddrinfo")
        || message.contains("enotfound")
    {
        ("host_not_found", "sshError.hostNotFound")
    } else if message.contains("handshake failed") || message.contains("unable to verify") {
        ("handshake_failed", "sshError.handshakeFailed")
    } else if message.contains("remote tmux unavailable")
        || message.contains("tmux_not_found")
        || message.contains("tmux: command not found")
        || message.contains("tmux control mode not ready")
        || message.contains("tmux exited")
        || message.contains("tmux_exec_failed")
    {
        ("tmux_unavailable", "sshError.tmuxUnavailable")
    } else if message.contains("ssh_connection_closed")
        || message.contains("connection closed")
        || message.contains("ssh command channel not ready")
        || message.contains("ssh connection not ready")
        || message.contains("channel closed")
    {
        ("connection_closed", "sshError.connectionClosed")
    } else {
        return ConnectionErrorClassification {
            error_type: "unknown",
            message_key: "sshError.unknown",
            includes_raw_message: true,
        };
    };
    ConnectionErrorClassification {
        error_type: classified.0,
        message_key: classified.1,
        includes_raw_message: false,
    }
}

pub struct ConnectionAlertNotifierDependencies {
    pub store: Arc<dyn PushStore>,
    pub translator: Arc<dyn PushTranslator>,
    pub broadcaster: Option<Arc<dyn DeviceEventBroadcaster>>,
    pub event_sink: Option<Arc<dyn PushEventSink>>,
    pub telegram: Option<Arc<dyn PushTelegramSender>>,
    pub clock: Arc<dyn EventClock>,
}

#[derive(Clone)]
pub struct ConnectionAlertNotifier {
    inner: Arc<ConnectionAlertNotifierInner>,
}

struct ConnectionAlertNotifierInner {
    dependencies: ConnectionAlertNotifierDependencies,
    telegram_throttle: Mutex<HashMap<String, u64>>,
    bridge_throttle: Mutex<HashMap<String, u64>>,
}

impl ConnectionAlertNotifier {
    pub fn new(dependencies: ConnectionAlertNotifierDependencies) -> Self {
        Self {
            inner: Arc::new(ConnectionAlertNotifierInner {
                dependencies,
                telegram_throttle: Mutex::new(HashMap::new()),
                bridge_throttle: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn notify(&self, input: ConnectionAlertInput) -> ClassifiedConnectionAlert {
        let classification = classify_connection_error(&input.error);
        let parameters = if classification.includes_raw_message {
            vec![("message", input.error.clone())]
        } else {
            Vec::new()
        };
        let friendly_message = self.inner.dependencies.translator.translate(
            classification.message_key,
            &parameters,
            None,
        );
        let persisted_message =
            if !input.error.is_empty() && !friendly_message.contains(&input.error) {
                format!("{friendly_message}\n{}", input.error)
            } else {
                friendly_message.clone()
            };

        tracing::error!(
            device_id = input.device.id,
            device_name = input.device.name,
            source = ?input.source,
            error_type = classification.error_type,
            raw_error = input.error,
            "device connection alert"
        );

        if input.persist {
            if let Err(error) = self
                .inner
                .dependencies
                .store
                .persist_connection_alert(
                    &input.device.id,
                    self.inner.dependencies.clock.now_iso(),
                    persisted_message,
                    classification.error_type.to_owned(),
                )
                .await
            {
                tracing::error!(%error, "failed to persist device connection alert");
            }
        }

        if let Some(broadcaster) = &self.inner.dependencies.broadcaster {
            if let Err(error) = broadcaster.broadcast(device_event(
                &input.device.id,
                classification.error_type,
                &friendly_message,
                &input.error,
            )) {
                tracing::error!(%error, "failed to broadcast device connection alert");
            }
        }

        if !input.silent_telegram
            && self.consume_telegram_throttle(&input.device.id, classification.error_type)
        {
            self.send_telegram(
                &input.device,
                classification.error_type,
                &friendly_message,
                &input.error,
            )
            .await;
        }

        self.maybe_emit_event(
            &input.device,
            input.source,
            classification.error_type,
            &friendly_message,
            input.session_closed_emitted,
        )
        .await;

        ClassifiedConnectionAlert {
            error_type: classification.error_type.to_owned(),
            message_key: classification.message_key.to_owned(),
            message: friendly_message,
            raw_message: input.error,
        }
    }

    pub fn clear(&self, device_id: &str) {
        clear_device_throttle(&self.inner.telegram_throttle, device_id);
        clear_device_throttle(&self.inner.bridge_throttle, device_id);
    }

    fn consume_telegram_throttle(&self, device_id: &str, error_type: &str) -> bool {
        let key = format!("{device_id}:{error_type}");
        let now = self.inner.dependencies.clock.now_millis();
        let mut throttle = self
            .inner
            .telegram_throttle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if throttle
            .get(&key)
            .is_some_and(|last| now.saturating_sub(*last) < NOTIFY_THROTTLE_MILLIS)
        {
            return false;
        }
        throttle.insert(key.clone(), now);
        sweep_expired(&mut throttle, device_id, &key, now);
        true
    }

    async fn send_telegram(
        &self,
        device: &devices::Model,
        error_type: &str,
        friendly_message: &str,
        raw_message: &str,
    ) {
        let Some(sender) = &self.inner.dependencies.telegram else {
            return;
        };
        let settings = match self.inner.dependencies.store.site_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(%error, "failed to load settings for Telegram connection alert");
                return;
            }
        };
        let badge_key = badge_key(error_type);
        let category = self.inner.dependencies.translator.translate(
            &format!("deviceStatus.errorBadge.{badge_key}"),
            &[],
            Some(error_type),
        );
        let text = self.inner.dependencies.translator.translate(
            "telegram.deviceConnectionError",
            &[
                ("siteName", settings.site_name),
                ("deviceName", device.name.clone()),
                (
                    "host",
                    device.host.clone().unwrap_or_else(|| "-".to_owned()),
                ),
                ("category", category),
                (
                    "error",
                    if friendly_message.is_empty() {
                        raw_message.to_owned()
                    } else {
                        friendly_message.to_owned()
                    },
                ),
            ],
            None,
        );
        if let Err(error) = sender.send_text(text).await {
            tracing::error!(%error, "failed to send Telegram connection alert");
        }
    }

    async fn maybe_emit_event(
        &self,
        device: &devices::Model,
        source: ConnectionAlertSource,
        error_type: &str,
        friendly_message: &str,
        session_closed_emitted: bool,
    ) {
        let Some(event_sink) = &self.inner.dependencies.event_sink else {
            return;
        };
        if !matches!(
            source,
            ConnectionAlertSource::Connect
                | ConnectionAlertSource::Close
                | ConnectionAlertSource::Probe
        ) {
            return;
        }
        let event_type = if error_type == "tmux_unavailable" {
            EventType::DeviceTmuxMissing
        } else if matches!(
            error_type,
            "connection_closed"
                | "network_unreachable"
                | "connection_refused"
                | "timeout"
                | "host_not_found"
                | "handshake_failed"
        ) {
            EventType::DeviceDisconnect
        } else {
            return;
        };
        if event_type == EventType::DeviceDisconnect && session_closed_emitted {
            return;
        }
        let key = format!("{}:{event_type}", device.id);
        let now = self.inner.dependencies.clock.now_millis();
        {
            let throttle = self
                .inner
                .bridge_throttle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if throttle
                .get(&key)
                .is_some_and(|last| now.saturating_sub(*last) < NOTIFY_THROTTLE_MILLIS)
            {
                return;
            }
        }
        let settings = match self.inner.dependencies.store.site_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(%error, "failed to load settings for connection event");
                return;
            }
        };
        let draft = EventDraft {
            site: EventSite {
                name: settings.site_name,
                url: settings.site_url,
            },
            device: EventDevice {
                id: device.id.clone(),
                name: device.name.clone(),
                device_type: device.r#type.clone(),
                host: device.host.clone(),
            },
            tmux: Some(EventTmux {
                session_name: Some(
                    device
                        .session
                        .as_deref()
                        .map(str::trim)
                        .filter(|session| !session.is_empty())
                        .unwrap_or("tmex")
                        .to_owned(),
                ),
                ..EventTmux::default()
            }),
            payload: Some(serde_json::Map::from_iter([(
                "message".to_owned(),
                serde_json::Value::String(friendly_message.to_owned()),
            )])),
        };
        if let Err(error) = event_sink.emit(event_type, draft).await {
            tracing::error!(%error, "failed to emit connection event");
            return;
        }
        let mut throttle = self
            .inner
            .bridge_throttle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        throttle.insert(key.clone(), now);
        sweep_expired(&mut throttle, &device.id, &key, now);
    }
}

fn clear_device_throttle(throttle: &Mutex<HashMap<String, u64>>, device_id: &str) {
    let prefix = format!("{device_id}:");
    throttle
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|key, _| !key.starts_with(&prefix));
}

fn sweep_expired(
    throttle: &mut HashMap<String, u64>,
    device_id: &str,
    current_key: &str,
    now: u64,
) {
    let prefix = format!("{device_id}:");
    throttle.retain(|key, timestamp| {
        key == current_key
            || !key.starts_with(&prefix)
            || now.saturating_sub(*timestamp) < NOTIFY_THROTTLE_MILLIS
    });
}

fn badge_key(error_type: &str) -> &'static str {
    match error_type {
        "auth_failed" => "authFailed",
        "agent_unavailable" => "agentUnavailable",
        "agent_no_identity" => "agentNoIdentity",
        "ssh_config_ref_not_supported" => "configRefNotSupported",
        "network_unreachable" => "networkUnreachable",
        "connection_refused" => "connectionRefused",
        "timeout" => "timeout",
        "host_not_found" => "hostNotFound",
        "handshake_failed" => "handshakeFailed",
        "tmux_unavailable" => "tmuxUnavailable",
        "connection_closed" => "connectionClosed",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tmex_protocol::DeviceEvent;

    use super::*;
    use crate::entity::site_settings;
    use crate::push::{PushError, PushStore};

    struct TestClock(AtomicU64);

    impl EventClock for TestClock {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }

        fn now_iso(&self) -> String {
            "2026-08-12T00:00:00.000Z".to_owned()
        }
    }

    #[derive(Default)]
    struct TestStore {
        persisted: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl PushStore for TestStore {
        async fn list_devices(&self) -> Result<Vec<devices::Model>, PushError> {
            Ok(Vec::new())
        }

        async fn get_device(&self, _device_id: &str) -> Result<Option<devices::Model>, PushError> {
            Ok(None)
        }

        async fn site_settings(&self) -> Result<site_settings::Model, PushError> {
            Ok(settings())
        }

        async fn persist_connection_alert(
            &self,
            device_id: &str,
            _timestamp: String,
            message: String,
            error_type: String,
        ) -> Result<(), PushError> {
            self.persisted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((format!("{device_id}:{error_type}"), message));
            Ok(())
        }
    }

    struct TestTranslator;

    impl PushTranslator for TestTranslator {
        fn translate(
            &self,
            key: &str,
            parameters: &[(&str, String)],
            default: Option<&str>,
        ) -> String {
            if key == "sshError.unknown" {
                let raw = parameters
                    .iter()
                    .find(|(name, _)| *name == "message")
                    .map(|(_, value)| value.as_str())
                    .unwrap_or_default();
                return format!("Connection failed: {raw}");
            }
            default.unwrap_or(key).to_owned()
        }
    }

    #[derive(Default)]
    struct TestBroadcaster(Mutex<Vec<DeviceEvent>>);

    impl DeviceEventBroadcaster for TestBroadcaster {
        fn broadcast(&self, event: DeviceEvent) -> Result<(), PushError> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(event);
            Ok(())
        }
    }

    #[derive(Default)]
    struct TestTelegram(AtomicUsize);

    #[async_trait]
    impl PushTelegramSender for TestTelegram {
        async fn send_text(&self, _text: String) -> Result<(), PushError> {
            self.0.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FlakyEventSink {
        calls: AtomicUsize,
        delivered: Mutex<Vec<EventType>>,
    }

    #[async_trait]
    impl PushEventSink for FlakyEventSink {
        async fn emit(&self, event_type: EventType, _draft: EventDraft) -> Result<(), PushError> {
            if self.calls.fetch_add(1, Ordering::AcqRel) == 0 {
                return Err(PushError::new("transient event failure"));
            }
            self.delivered
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(event_type);
            Ok(())
        }
    }

    #[tokio::test]
    async fn telegram_throttles_but_failed_event_emit_does_not_consume_bridge_window() {
        let store = Arc::new(TestStore::default());
        let broadcaster = Arc::new(TestBroadcaster::default());
        let telegram = Arc::new(TestTelegram::default());
        let events = Arc::new(FlakyEventSink::default());
        let notifier = ConnectionAlertNotifier::new(ConnectionAlertNotifierDependencies {
            store: store.clone(),
            translator: Arc::new(TestTranslator),
            broadcaster: Some(broadcaster.clone()),
            event_sink: Some(events.clone()),
            telegram: Some(telegram.clone()),
            clock: Arc::new(TestClock(AtomicU64::new(1_000_000))),
        });
        let first_device = device("device-a");

        notifier
            .notify(ConnectionAlertInput::new(
                first_device.clone(),
                "ssh_connection_closed",
                ConnectionAlertSource::Close,
            ))
            .await;
        notifier
            .notify(ConnectionAlertInput::new(
                first_device,
                "connection closed",
                ConnectionAlertSource::Close,
            ))
            .await;

        assert_eq!(telegram.0.load(Ordering::Acquire), 1);
        {
            let broadcasts = broadcaster.0.lock().unwrap();
            assert_eq!(broadcasts.len(), 2);
            assert!(broadcasts.iter().all(|event| event.event_type == 3));
        }
        assert_eq!(store.persisted.lock().unwrap().len(), 2);
        assert_eq!(events.calls.load(Ordering::Acquire), 2);
        assert_eq!(
            events.delivered.lock().unwrap().as_slice(),
            &[EventType::DeviceDisconnect]
        );

        let mut duplicate = ConnectionAlertInput::new(
            device("device-b"),
            "ssh_connection_closed",
            ConnectionAlertSource::Close,
        );
        duplicate.session_closed_emitted = true;
        notifier.notify(duplicate).await;
        assert_eq!(events.calls.load(Ordering::Acquire), 2);
    }

    fn device(id: &str) -> devices::Model {
        devices::Model {
            id: id.to_owned(),
            name: id.to_owned(),
            r#type: "ssh".to_owned(),
            host: Some("10.0.0.1".to_owned()),
            port: Some(22),
            username: Some("root".to_owned()),
            ssh_config_ref: None,
            session: Some("tmex".to_owned()),
            auth_mode: "auto".to_owned(),
            password_enc: None,
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: None,
            sort_order: 0,
            created_at: "2026-08-12T00:00:00.000Z".to_owned(),
            updated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        }
    }

    fn settings() -> site_settings::Model {
        site_settings::Model {
            id: 1,
            site_name: "tmex".to_owned(),
            site_url: "https://tmex.example.test".to_owned(),
            bell_throttle_seconds: 6,
            notification_throttle_seconds: 3,
            enable_browser_notification_toast: 1,
            enable_notification_push: 1,
            enable_bell_push: 1,
            enable_bell_sound: 1,
            ssh_reconnect_max_retries: 2,
            ssh_reconnect_delay_seconds: 1,
            language: "en_US".to_owned(),
            theme: "dark".to_owned(),
            disabled_notification_channels: "[]".to_owned(),
            updated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        }
    }
}
