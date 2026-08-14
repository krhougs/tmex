use std::sync::Arc;

use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::database::repository::{Repository, RepositorySiteSettingsDefaults};
use crate::entity::{devices, site_settings};
use crate::tmux::{LifecycleEvent, LifecycleEventKind, TmuxLifecycleSink};

use super::{EventDevice, EventDraft, EventNotifier, EventSite, EventTmux, EventType};

#[derive(Clone)]
pub struct GatewayTmuxLifecycleSink {
    repository: Repository,
    defaults: RepositorySiteSettingsDefaults,
    notifier: Arc<EventNotifier>,
    runtime: tokio::runtime::Handle,
}

impl GatewayTmuxLifecycleSink {
    pub fn new(
        repository: Repository,
        defaults: RepositorySiteSettingsDefaults,
        notifier: Arc<EventNotifier>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Self {
            repository,
            defaults,
            notifier,
            runtime,
        }
    }

    async fn publish_event(&self, device_id: &str, event: LifecycleEvent) {
        let device = match self.repository.get_device_by_id(device_id).await {
            Ok(Some(device)) => device,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(device_id, %error, "failed to load tmux lifecycle event device");
                return;
            }
        };
        let settings = match self.repository.get_site_settings(&self.defaults).await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(device_id, %error, "failed to load tmux lifecycle event settings");
                return;
            }
        };
        let (event_type, draft) = lifecycle_event_draft(device, settings, event);
        if let Err(error) = self.notifier.notify(event_type, draft).await {
            tracing::error!(device_id, %error, "failed to publish tmux lifecycle event");
        }
    }
}

impl TmuxLifecycleSink for GatewayTmuxLifecycleSink {
    fn publish(&self, device_id: String, event: LifecycleEvent) {
        let sink = self.clone();
        drop(self.runtime.spawn(async move {
            sink.publish_event(&device_id, event).await;
        }));
    }
}

fn lifecycle_event_draft(
    device: devices::Model,
    settings: site_settings::Model,
    event: LifecycleEvent,
) -> (EventType, EventDraft) {
    let event_type = match event.kind {
        LifecycleEventKind::SessionCreated => EventType::SessionCreated,
        LifecycleEventKind::SessionClosed => EventType::SessionClosed,
        LifecycleEventKind::TmuxWindowClose => EventType::TmuxWindowClose,
        LifecycleEventKind::TmuxPaneClose => EventType::TmuxPaneClose,
    };
    let payload = (!event.payload.is_empty()).then(|| {
        event
            .payload
            .into_iter()
            .map(|(key, value)| (key, JsonValue::String(value)))
            .collect::<JsonMap<_, _>>()
    });
    let draft = EventDraft {
        site: EventSite {
            name: settings.site_name,
            url: settings.site_url,
        },
        device: EventDevice {
            id: device.id,
            name: device.name,
            device_type: device.r#type,
            host: device.host,
        },
        tmux: Some(EventTmux {
            session_name: event.tmux.session_name,
            window_id: event.tmux.window_id,
            window_index: event.tmux.window_index.map(i64::from),
            pane_id: event.tmux.pane_id,
            pane_index: event.tmux.pane_index.map(i64::from),
            pane_title: event.tmux.pane_title,
            pane_current_command: event.tmux.pane_current_command,
            pane_current_path: event.tmux.pane_current_path,
            ..EventTmux::default()
        }),
        payload,
    };
    (event_type, draft)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::tmux::LifecycleTmuxContext;

    use super::*;

    #[test]
    fn preserves_tmux_context_and_payload_on_the_notification_boundary() {
        let (event_type, draft) = lifecycle_event_draft(
            device(),
            settings(),
            LifecycleEvent {
                kind: LifecycleEventKind::TmuxPaneClose,
                tmux: LifecycleTmuxContext {
                    session_name: Some("tmex".to_owned()),
                    window_id: Some("@1".to_owned()),
                    window_index: Some(3),
                    pane_id: Some("%2".to_owned()),
                    pane_index: Some(4),
                    pane_title: Some("tests".to_owned()),
                    pane_current_command: Some("cargo".to_owned()),
                    pane_current_path: Some("/repo".to_owned()),
                },
                payload: BTreeMap::from([("windowName".to_owned(), "build".to_owned())]),
            },
        );

        assert_eq!(event_type, EventType::TmuxPaneClose);
        assert_eq!(draft.site.name, "tmex");
        assert_eq!(draft.device.id, "device-one");
        let tmux = draft.tmux.expect("tmux context");
        assert_eq!(tmux.session_name.as_deref(), Some("tmex"));
        assert_eq!(tmux.window_id.as_deref(), Some("@1"));
        assert_eq!(tmux.window_index, Some(3));
        assert_eq!(tmux.pane_id.as_deref(), Some("%2"));
        assert_eq!(tmux.pane_index, Some(4));
        assert_eq!(tmux.pane_title.as_deref(), Some("tests"));
        assert_eq!(tmux.pane_current_command.as_deref(), Some("cargo"));
        assert_eq!(tmux.pane_current_path.as_deref(), Some("/repo"));
        assert_eq!(
            draft
                .payload
                .as_ref()
                .and_then(|payload| payload.get("windowName"))
                .and_then(JsonValue::as_str),
            Some("build")
        );
    }

    fn device() -> devices::Model {
        devices::Model {
            id: "device-one".to_owned(),
            name: "Workstation".to_owned(),
            r#type: "local".to_owned(),
            host: None,
            port: None,
            username: None,
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
