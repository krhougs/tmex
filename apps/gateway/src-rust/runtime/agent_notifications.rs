use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tmex_protocol::{PaneWire, StateSnapshot};

use crate::agent::{
    AgentNotification, AgentNotificationSink, AgentNotificationTranslation, AgentPortError,
};
use crate::database::repository::{Repository, RepositorySiteSettingsDefaults};
use crate::events::{EventDevice, EventDraft, EventNotifier, EventSite, EventTmux, EventType};
use crate::i18n::GatewayI18n;
use crate::telegram::{TelegramOutgoingMessage, TelegramService};
use crate::tmux::{DeviceSessionRuntime, TmuxRuntimeRegistry};

const URI_COMPONENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub struct GatewayAgentNotificationSink {
    repository: Repository,
    defaults: RepositorySiteSettingsDefaults,
    runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    notifier: Arc<EventNotifier>,
    telegram: Arc<TelegramService>,
    i18n: GatewayI18n,
}

impl GatewayAgentNotificationSink {
    pub fn new(
        repository: Repository,
        defaults: RepositorySiteSettingsDefaults,
        runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
        notifier: Arc<EventNotifier>,
        telegram: Arc<TelegramService>,
        i18n: GatewayI18n,
    ) -> Self {
        Self {
            repository,
            defaults,
            runtimes,
            notifier,
            telegram,
            i18n,
        }
    }

    async fn notify_credential_warning(
        &self,
        session_title: String,
        types: Vec<String>,
    ) -> Result<(), AgentPortError> {
        let settings = self
            .repository
            .get_site_settings(&self.defaults)
            .await
            .map_err(port_error)?;
        if settings.enable_notification_push == 0 {
            return Ok(());
        }
        let text = self.i18n.translate_with(
            "telegram.agentCredentialWarning",
            &HashMap::from([
                ("siteName", settings.site_name),
                ("sessionTitle", session_title),
                ("types", types.join(", ")),
            ]),
        );
        self.telegram
            .send_to_authorized_chats(TelegramOutgoingMessage::text(text))
            .await
            .map_err(port_error)
    }

    async fn notify_event(&self, notification: AgentNotification) -> Result<(), AgentPortError> {
        let settings = self
            .repository
            .get_site_settings(&self.defaults)
            .await
            .map_err(port_error)?;
        let device = match notification.device_id.as_deref() {
            Some(device_id) => self
                .repository
                .get_device_by_id(device_id)
                .await
                .map_err(port_error)?,
            None => None,
        };
        let snapshot = match notification.device_id.as_deref() {
            Some(device_id) => match self.runtimes.peek(device_id).await {
                Some(runtime) => runtime.current_snapshot().await.ok().flatten(),
                None => None,
            },
            None => None,
        };
        let context = pane_context(
            notification.device_id.as_deref(),
            notification.pane_id.as_deref(),
            &settings.site_url,
            snapshot.as_ref(),
        );
        let (event_type, message) = translate_notification(&self.i18n, &notification)?;
        let mut payload = JsonMap::from_iter([
            ("message".to_owned(), JsonValue::String(message)),
            (
                "agentSessionId".to_owned(),
                JsonValue::String(notification.session_id.clone()),
            ),
            (
                "agentSessionTitle".to_owned(),
                JsonValue::String(notification.session_title.clone()),
            ),
        ]);
        if let Some(tool_name) = notification.tool_name {
            payload.insert("toolName".to_owned(), JsonValue::String(tool_name));
        }
        if let Some(confirmation_id) = notification.confirmation_id {
            payload.insert(
                "confirmationId".to_owned(),
                JsonValue::String(confirmation_id),
            );
        }
        let device_id = device
            .as_ref()
            .map(|device| device.id.clone())
            .or(notification.device_id)
            .unwrap_or_else(|| "-".to_owned());
        let draft = EventDraft {
            site: EventSite {
                name: settings.site_name,
                url: settings.site_url,
            },
            device: EventDevice {
                id: device_id,
                name: device
                    .as_ref()
                    .map(|device| device.name.clone())
                    .unwrap_or_else(|| "unknown".to_owned()),
                device_type: device
                    .as_ref()
                    .map(|device| device.r#type.clone())
                    .unwrap_or_else(|| "local".to_owned()),
                host: device.as_ref().and_then(|device| device.host.clone()),
            },
            tmux: Some(EventTmux {
                session_name: device.as_ref().and_then(|device| device.session.clone()),
                window_id: context.window_id,
                window_index: context.window_index,
                pane_id: context.pane_id.or(notification.pane_id),
                pane_index: context.pane_index,
                pane_url: context.pane_url,
                pane_title: context.pane_title,
                pane_current_command: context.pane_current_command,
                pane_current_path: context.pane_current_path,
            }),
            payload: Some(payload),
        };
        self.notifier
            .notify(event_type, draft)
            .await
            .map(|_| ())
            .map_err(port_error)
    }
}

#[async_trait]
impl AgentNotificationSink for GatewayAgentNotificationSink {
    async fn notify(&self, notification: AgentNotification) -> Result<(), AgentPortError> {
        match &notification.translation {
            AgentNotificationTranslation::CredentialWarning {
                session_title,
                types,
            } => {
                self.notify_credential_warning(session_title.clone(), types.clone())
                    .await
            }
            _ => self.notify_event(notification).await,
        }
    }
}

fn translate_notification(
    i18n: &GatewayI18n,
    notification: &AgentNotification,
) -> Result<(EventType, String), AgentPortError> {
    let (event_type, key, parameters) = match &notification.translation {
        AgentNotificationTranslation::TurnFinished { title } => (
            EventType::AgentTurnFinished,
            "notification.agent.turnFinished",
            HashMap::from([("title", title.clone())]),
        ),
        AgentNotificationTranslation::ConfirmationPending { title, tool_name } => (
            EventType::AgentConfirmationPending,
            "notification.agent.confirmationPending",
            HashMap::from([("title", title.clone()), ("toolName", tool_name.clone())]),
        ),
        AgentNotificationTranslation::Error { title, error } => (
            EventType::AgentError,
            "notification.agent.error",
            HashMap::from([("title", title.clone()), ("message", error.clone())]),
        ),
        AgentNotificationTranslation::CredentialWarning { .. } => {
            return Err(AgentPortError::new(
                "credential warning cannot be sent through the event notifier",
            ));
        }
    };
    let translated = i18n.translate_with(key, &parameters);
    Ok((
        event_type,
        if translated == key {
            notification.message.clone()
        } else {
            translated
        },
    ))
}

#[derive(Default)]
struct PaneContext {
    window_id: Option<String>,
    window_index: Option<i64>,
    pane_id: Option<String>,
    pane_index: Option<i64>,
    pane_url: Option<String>,
    pane_title: Option<String>,
    pane_current_command: Option<String>,
    pane_current_path: Option<String>,
}

fn pane_context(
    device_id: Option<&str>,
    pane_id: Option<&str>,
    site_url: &str,
    snapshot: Option<&StateSnapshot>,
) -> PaneContext {
    let Some(session) = snapshot.and_then(|snapshot| snapshot.session.as_ref()) else {
        return PaneContext::default();
    };
    let Some(pane_id) = pane_id else {
        return PaneContext::default();
    };
    let Some((window, pane)) = session.windows.iter().find_map(|window| {
        window
            .panes
            .iter()
            .find(|pane| pane.id == pane_id)
            .map(|pane| (window, pane))
    }) else {
        return PaneContext::default();
    };
    let pane_url = device_id.map(|device_id| {
        let base = site_url.strip_suffix('/').unwrap_or(site_url);
        format!(
            "{base}/devices/{}/windows/{}/panes/{}",
            encode_component(device_id),
            encode_component(&window.id),
            encode_component(&pane.id)
        )
    });
    pane_context_from_wire(window.id.clone(), i64::from(window.index), pane, pane_url)
}

fn pane_context_from_wire(
    window_id: String,
    window_index: i64,
    pane: &PaneWire,
    pane_url: Option<String>,
) -> PaneContext {
    PaneContext {
        window_id: Some(window_id),
        window_index: Some(window_index),
        pane_id: Some(pane.id.clone()),
        pane_index: Some(i64::from(pane.index)),
        pane_url,
        pane_title: pane.custom_name.clone().or_else(|| pane.title.clone()),
        pane_current_command: pane.current_command.clone(),
        pane_current_path: pane.current_path.clone(),
    }
}

fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET).to_string()
}

fn port_error(error: impl std::fmt::Display) -> AgentPortError {
    AgentPortError::new(error.to_string())
}
