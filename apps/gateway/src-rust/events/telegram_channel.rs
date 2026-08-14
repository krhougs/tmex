use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Local};

use crate::i18n::{GatewayI18n, GatewayLocale};
use crate::telegram::{TelegramOutgoingMessage, TelegramParseMode, TelegramService};

use super::{
    build_pane_url, normalize_http_url, EventError, EventType, NotificationChannel,
    WebhookConfigProvider, WebhookEvent,
};

#[async_trait]
pub trait TelegramNotificationSender: Send + Sync {
    async fn send_to_authorized_chats(
        &self,
        message: TelegramOutgoingMessage,
    ) -> Result<(), EventError>;
}

#[async_trait]
impl TelegramNotificationSender for TelegramService {
    async fn send_to_authorized_chats(
        &self,
        message: TelegramOutgoingMessage,
    ) -> Result<(), EventError> {
        TelegramService::send_to_authorized_chats(self, message)
            .await
            .map_err(|error| EventError::new(error.to_string()))
    }
}

pub struct TelegramChannel {
    config: Arc<dyn WebhookConfigProvider>,
    sender: Arc<dyn TelegramNotificationSender>,
    i18n: GatewayI18n,
}

impl TelegramChannel {
    pub fn new(
        config: Arc<dyn WebhookConfigProvider>,
        sender: Arc<dyn TelegramNotificationSender>,
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
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.paneTitle")),
                escape_html_text(title)
            ));
        }
        if let Some(command) = tmux
            .pane_current_command
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.process")),
                escape_html_text(command)
            ));
        }
        if let Some(path) = tmux
            .pane_current_path
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.currentPath")),
                escape_html_text(path)
            ));
        }
        lines
    }

    fn format_bell(&self, event: &WebhookEvent) -> String {
        let title = self.i18n.translate_with(
            "notification.telegramBell.title",
            &HashMap::from([
                ("siteName", event.site.name.clone()),
                ("terminalTopbarLabel", self.terminal_topbar_label(event)),
            ]),
        );
        let mut lines = vec![escape_html_text(&title)];
        lines.extend(self.pane_meta_lines(event));
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.extend([
                String::new(),
                format!(
                    "<a href=\"{}\">{}</a>",
                    escape_html_attribute(&url),
                    escape_html_text(&self.i18n.translate("notification.telegramBell.viewLink"))
                ),
            ]);
        }
        lines.join("\n")
    }

    fn format_terminal_notification(&self, event: &WebhookEvent) -> String {
        let title = payload_string(event, "title").unwrap_or_default();
        let message = payload_string(event, "message").unwrap_or_default();
        let mut lines = Vec::new();
        if !title.is_empty() {
            lines.push(escape_html_text(title));
        }
        if !message.is_empty() {
            lines.push(escape_html_text(message));
        }
        lines.extend(self.pane_meta_lines(event));

        let footer = format!(
            "from {}: {}",
            event.site.name,
            self.terminal_topbar_label(event)
        );
        lines.push(String::new());
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.push(format!(
                "<a href=\"{}\">{}</a>",
                escape_html_attribute(&url),
                escape_html_text(&footer)
            ));
        } else {
            lines.push(escape_html_text(&footer));
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
            format!(
                "{} {}",
                event_emoji(event.event_type),
                escape_html_text(&event_label)
            ),
            format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.site")),
                escape_html_text(&event.site.name)
            ),
            format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.time")),
                escape_html_text(&format_local_timestamp(
                    &event.timestamp,
                    self.i18n.locale()
                ))
            ),
            format!(
                "{}：{} ({})",
                escape_html_text(&self.i18n.translate("notification.device")),
                escape_html_text(&event.device.name),
                escape_html_text(&event.device.device_type)
            ),
            format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.window")),
                escape_html_text(&window)
            ),
            format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.pane")),
                escape_html_text(&pane)
            ),
        ];
        lines.extend(self.pane_meta_lines(event));
        if let Some(message) = payload_string(event, "message").filter(|value| !value.is_empty()) {
            lines.push(format!(
                "{}：{}",
                escape_html_text(&self.i18n.translate("notification.message")),
                escape_html_text(message)
            ));
        }
        if let Some(url) = normalize_http_url(build_pane_url(event)) {
            lines.extend([
                String::new(),
                format!(
                    "<a href=\"{}\">{}</a>",
                    escape_html_attribute(&url),
                    escape_html_text(&self.i18n.translate("notification.directLink"))
                ),
            ]);
        }
        lines.join("\n")
    }
}

#[async_trait]
impl NotificationChannel for TelegramChannel {
    fn id(&self) -> &'static str {
        "telegram"
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
        self.sender
            .send_to_authorized_chats(TelegramOutgoingMessage {
                text,
                parse_mode: Some(TelegramParseMode::Html),
            })
            .await
    }
}

fn indexed_identity(index: Option<i64>, id: Option<&str>) -> String {
    match (index, id) {
        (Some(index), id) => format!("{index} ({})", id.unwrap_or("-")),
        (None, Some(id)) if !id.is_empty() => id.to_owned(),
        (None, Some(_)) => "-".to_owned(),
        (None, None) => "-".to_owned(),
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

fn escape_html_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_attribute(input: &str) -> String {
    escape_html_text(input).replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Map as JsonMap, Value as JsonValue};

    use super::*;
    use crate::events::{EventDevice, EventSite, EventTmux, WebhookEndpoint, WebhookPushSettings};

    struct Config {
        push: WebhookPushSettings,
    }

    #[async_trait]
    impl WebhookConfigProvider for Config {
        async fn push_settings(&self) -> Result<WebhookPushSettings, EventError> {
            Ok(self.push)
        }

        async fn webhook_endpoints(&self) -> Result<Vec<WebhookEndpoint>, EventError> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct Sender(Mutex<Vec<TelegramOutgoingMessage>>);

    #[async_trait]
    impl TelegramNotificationSender for Sender {
        async fn send_to_authorized_chats(
            &self,
            message: TelegramOutgoingMessage,
        ) -> Result<(), EventError> {
            self.0.lock().expect("sender lock").push(message);
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
                pane_current_path: Some("/tmp/\"artifact\"".to_owned()),
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
    async fn preserves_push_gates_and_escapes_html_and_deep_link_components() {
        let sender = Arc::new(Sender::default());
        let channel = TelegramChannel::new(
            Arc::new(Config {
                push: WebhookPushSettings {
                    enable_bell_push: true,
                    enable_notification_push: true,
                },
            }),
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
        assert_eq!(messages[0].parse_mode, Some(TelegramParseMode::Html));
        assert!(messages[0].text.contains("Done &lt;ok&gt;"));
        assert!(messages[0].text.contains("all &amp; green"));
        assert!(messages[0].text.contains("build &lt;main&gt;"));
        assert!(messages[0].text.contains(
            "https://tmex.example.com/base/devices/dev%20%2F%E4%B8%80/windows/%401/panes/%251"
        ));
        assert!(!messages[0].text.contains("tmex <prod>"));
    }
}
