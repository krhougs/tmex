use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Local};

use crate::i18n::{GatewayI18n, GatewayLocale};
use crate::weixin::WeixinService;

use super::{
    build_pane_url, normalize_http_url, EventError, EventType, NotificationChannel,
    WebhookConfigProvider, WebhookEvent,
};

#[async_trait]
pub trait WeixinNotificationSender: Send + Sync {
    async fn send_to_authorized_users(&self, text: String) -> Result<(), EventError>;
}

#[async_trait]
impl WeixinNotificationSender for WeixinService {
    async fn send_to_authorized_users(&self, text: String) -> Result<(), EventError> {
        WeixinService::send_to_authorized_users(self, text)
            .await
            .map_err(|error| EventError::new(error.to_string()))
    }
}

pub struct WeixinChannel {
    config: Arc<dyn WebhookConfigProvider>,
    sender: Arc<dyn WeixinNotificationSender>,
    i18n: GatewayI18n,
}

impl WeixinChannel {
    pub fn new(
        config: Arc<dyn WebhookConfigProvider>,
        sender: Arc<dyn WeixinNotificationSender>,
        i18n: GatewayI18n,
    ) -> Self {
        Self {
            config,
            sender,
            i18n,
        }
    }

    fn terminal_topbar_label(&self, event: &WebhookEvent) -> String {
        let tmux = event.tmux.as_ref();
        let window = tmux
            .and_then(|tmux| tmux.window_index.map(|index| index.to_string()))
            .or_else(|| tmux.and_then(|tmux| tmux.window_id.clone()))
            .unwrap_or_else(|| "?".to_owned());
        let pane = tmux
            .and_then(|tmux| tmux.pane_index.map(|index| index.to_string()))
            .or_else(|| tmux.and_then(|tmux| tmux.pane_id.clone()))
            .unwrap_or_else(|| "?".to_owned());
        self.i18n.translate_with(
            "notification.telegramBell.terminalTopbarLabel",
            &HashMap::from([
                ("window", window),
                ("pane", pane),
                ("device", event.device.name.clone()),
            ]),
        )
    }

    fn pane_meta_lines(&self, event: &WebhookEvent) -> Vec<String> {
        let mut lines = Vec::new();
        let Some(tmux) = event.tmux.as_ref() else {
            return lines;
        };
        if let Some(title) = tmux.pane_title.as_deref().filter(|value| !value.is_empty()) {
            lines.push(format!(
                "{}：{title}",
                self.i18n.translate("notification.paneTitle")
            ));
        }
        if let Some(command) = tmux
            .pane_current_command
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!(
                "{}：{command}",
                self.i18n.translate("notification.process")
            ));
        }
        lines
    }

    fn format_bell(&self, event: &WebhookEvent) -> String {
        let mut lines = vec![self.i18n.translate_with(
            "notification.telegramBell.title",
            &HashMap::from([
                ("siteName", event.site.name.clone()),
                ("terminalTopbarLabel", self.terminal_topbar_label(event)),
            ]),
        )];
        lines.extend(self.pane_meta_lines(event));
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.extend([String::new(), url]);
        }
        lines.join("\n")
    }

    fn format_terminal_notification(&self, event: &WebhookEvent) -> String {
        let mut lines = Vec::new();
        if let Some(title) = payload_string(event, "title").filter(|value| !value.is_empty()) {
            lines.push(title.to_owned());
        }
        if let Some(message) = payload_string(event, "message").filter(|value| !value.is_empty()) {
            lines.push(message.to_owned());
        }
        lines.extend(self.pane_meta_lines(event));
        lines.extend([
            String::new(),
            format!(
                "from {}: {}",
                event.site.name,
                self.terminal_topbar_label(event)
            ),
        ]);
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.push(url);
        }
        lines.join("\n")
    }

    fn format_generic(&self, event: &WebhookEvent) -> String {
        let event_label = self
            .i18n
            .translate(&format!("notification.eventType.{}", event.event_type));
        let tmux = event.tmux.as_ref();
        let window = indexed_identity(
            tmux.and_then(|tmux| tmux.window_index),
            tmux.and_then(|tmux| tmux.window_id.as_deref()),
        );
        let pane = indexed_identity(
            tmux.and_then(|tmux| tmux.pane_index),
            tmux.and_then(|tmux| tmux.pane_id.as_deref()),
        );
        let mut lines = vec![
            format!("{} {event_label}", event_emoji(event.event_type)),
            format!(
                "{}：{}",
                self.i18n.translate("notification.site"),
                event.site.name
            ),
            format!(
                "{}：{}",
                self.i18n.translate("notification.time"),
                format_local_timestamp(&event.timestamp, self.i18n.locale())
            ),
            format!(
                "{}：{} ({})",
                self.i18n.translate("notification.device"),
                event.device.name,
                event.device.device_type
            ),
            format!("{}：{window}", self.i18n.translate("notification.window")),
            format!("{}：{pane}", self.i18n.translate("notification.pane")),
        ];
        lines.extend(self.pane_meta_lines(event));
        if let Some(message) = payload_string(event, "message").filter(|value| !value.is_empty()) {
            lines.push(format!(
                "{}：{message}",
                self.i18n.translate("notification.message")
            ));
        }
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.extend([String::new(), url]);
        }
        lines.join("\n")
    }
}

#[async_trait]
impl NotificationChannel for WeixinChannel {
    fn id(&self) -> &'static str {
        "weixin"
    }

    async fn notify(
        &self,
        event_type: EventType,
        event: Arc<WebhookEvent>,
    ) -> Result<(), EventError> {
        if event_type.skipped_by_legacy_push_channels() {
            return Ok(());
        }
        let settings = self.config.push_settings().await?;
        let text = if event_type == EventType::TerminalBell {
            if !settings.enable_bell_push {
                return Ok(());
            }
            self.format_bell(&event)
        } else {
            if !settings.enable_notification_push {
                return Ok(());
            }
            if event_type == EventType::TerminalNotification {
                self.format_terminal_notification(&event)
            } else {
                self.format_generic(&event)
            }
        };
        self.sender.send_to_authorized_users(text).await
    }
}

fn indexed_identity(index: Option<i64>, id: Option<&str>) -> String {
    match (index, id) {
        (Some(index), id) => format!("{index} ({})", id.unwrap_or("-")),
        (None, Some(id)) if !id.is_empty() => id.to_owned(),
        (None, _) => "-".to_owned(),
    }
}

fn payload_string<'a>(event: &'a WebhookEvent, key: &str) -> Option<&'a str> {
    event.payload.as_ref()?.get(key)?.as_str()
}

fn event_emoji(event_type: EventType) -> &'static str {
    match event_type {
        EventType::TerminalBell | EventType::TerminalNotification => "🔔",
        EventType::TmuxWindowClose => "🪟",
        EventType::TmuxPaneClose => "📱",
        EventType::DeviceTmuxMissing => "⚠️",
        EventType::DeviceDisconnect => "🔌",
        EventType::SessionCreated => "🆕",
        EventType::SessionClosed => "🚪",
        EventType::AgentConfirmationPending
        | EventType::AgentTurnFinished
        | EventType::AgentError => "🤖",
        EventType::WatchTriggered
        | EventType::WatchModelUnavailable
        | EventType::WatchRuleError => "👁️",
    }
}

fn format_local_timestamp(timestamp: &str, locale: GatewayLocale) -> String {
    let Ok(timestamp) = DateTime::parse_from_rfc3339(timestamp) else {
        return "Invalid Date".to_owned();
    };
    let local = timestamp.with_timezone(&Local);
    match locale {
        GatewayLocale::EnUs => local.format("%-m/%-d/%Y, %-I:%M:%S %p").to_string(),
        GatewayLocale::ZhCn => local.format("%Y/%-m/%-d %H:%M:%S").to_string(),
        GatewayLocale::JaJp => local.format("%Y/%-m/%-d %-H:%M:%S").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Map as JsonMap, Value as JsonValue};

    use super::*;
    use crate::events::{EventDevice, EventSite, EventTmux, WebhookEndpoint, WebhookPushSettings};

    struct Config(WebhookPushSettings);

    #[async_trait]
    impl WebhookConfigProvider for Config {
        async fn push_settings(&self) -> Result<WebhookPushSettings, EventError> {
            Ok(self.0)
        }

        async fn webhook_endpoints(&self) -> Result<Vec<WebhookEndpoint>, EventError> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct Sender(Mutex<Vec<String>>);

    #[async_trait]
    impl WeixinNotificationSender for Sender {
        async fn send_to_authorized_users(&self, text: String) -> Result<(), EventError> {
            self.0.lock().expect("sender lock").push(text);
            Ok(())
        }
    }

    fn event(event_type: EventType) -> Arc<WebhookEvent> {
        Arc::new(WebhookEvent {
            site: EventSite {
                name: "tmex <prod>".to_owned(),
                url: "https://tmex.example.com/base/".to_owned(),
            },
            device: EventDevice {
                id: "dev /一".to_owned(),
                name: "mac & mini".to_owned(),
                device_type: "local".to_owned(),
                host: None,
            },
            tmux: Some(EventTmux {
                window_id: Some("@1".to_owned()),
                window_index: Some(7),
                pane_id: Some("%1".to_owned()),
                pane_index: Some(3),
                pane_title: Some("build <main>".to_owned()),
                pane_current_command: Some("cargo & test".to_owned()),
                pane_current_path: Some("must-not-appear".to_owned()),
                ..EventTmux::default()
            }),
            payload: Some(JsonMap::from_iter([
                (
                    "title".to_owned(),
                    JsonValue::String("Done <ok>".to_owned()),
                ),
                (
                    "message".to_owned(),
                    JsonValue::String("all & green".to_owned()),
                ),
            ])),
            event_type,
            timestamp: "2026-08-12T01:02:03.000Z".to_owned(),
        })
    }

    #[tokio::test]
    async fn preserves_legacy_gates_plain_text_and_encoded_deep_links() {
        let disabled_sender = Arc::new(Sender::default());
        let disabled = WeixinChannel::new(
            Arc::new(Config(WebhookPushSettings::default())),
            disabled_sender.clone(),
            GatewayI18n::new(GatewayLocale::EnUs),
        );
        disabled
            .notify(EventType::TerminalBell, event(EventType::TerminalBell))
            .await
            .unwrap();
        assert!(disabled_sender.0.lock().expect("sender lock").is_empty());

        let sender = Arc::new(Sender::default());
        let channel = WeixinChannel::new(
            Arc::new(Config(WebhookPushSettings {
                enable_bell_push: true,
                enable_notification_push: true,
            })),
            sender.clone(),
            GatewayI18n::new(GatewayLocale::EnUs),
        );
        channel
            .notify(
                EventType::DeviceDisconnect,
                event(EventType::DeviceDisconnect),
            )
            .await
            .unwrap();
        channel
            .notify(
                EventType::TerminalNotification,
                event(EventType::TerminalNotification),
            )
            .await
            .unwrap();

        let messages = sender.0.lock().expect("sender lock");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("Done <ok>"));
        assert!(messages[0].contains("all & green"));
        assert!(messages[0].contains("build <main>"));
        assert!(!messages[0].contains("must-not-appear"));
        assert!(messages[0].contains(
            "https://tmex.example.com/base/devices/dev%20%2F%E4%B8%80/windows/%401/panes/%251"
        ));
        assert!(!messages[0].contains("<a href"));
    }
}
