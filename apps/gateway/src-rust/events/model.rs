use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    TerminalBell,
    TerminalNotification,
    TmuxWindowClose,
    TmuxPaneClose,
    DeviceTmuxMissing,
    DeviceDisconnect,
    SessionCreated,
    SessionClosed,
    AgentConfirmationPending,
    AgentTurnFinished,
    AgentError,
    WatchTriggered,
    WatchModelUnavailable,
    WatchRuleError,
}

impl EventType {
    pub const ALL: [Self; 14] = [
        Self::TerminalBell,
        Self::TerminalNotification,
        Self::TmuxWindowClose,
        Self::TmuxPaneClose,
        Self::DeviceTmuxMissing,
        Self::DeviceDisconnect,
        Self::SessionCreated,
        Self::SessionClosed,
        Self::AgentConfirmationPending,
        Self::AgentTurnFinished,
        Self::AgentError,
        Self::WatchTriggered,
        Self::WatchModelUnavailable,
        Self::WatchRuleError,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TerminalBell => "terminal_bell",
            Self::TerminalNotification => "terminal_notification",
            Self::TmuxWindowClose => "tmux_window_close",
            Self::TmuxPaneClose => "tmux_pane_close",
            Self::DeviceTmuxMissing => "device_tmux_missing",
            Self::DeviceDisconnect => "device_disconnect",
            Self::SessionCreated => "session_created",
            Self::SessionClosed => "session_closed",
            Self::AgentConfirmationPending => "agent_confirmation_pending",
            Self::AgentTurnFinished => "agent_turn_finished",
            Self::AgentError => "agent_error",
            Self::WatchTriggered => "watch_triggered",
            Self::WatchModelUnavailable => "watch_model_unavailable",
            Self::WatchRuleError => "watch_rule_error",
        }
    }

    pub const fn skipped_by_legacy_push_channels(self) -> bool {
        matches!(
            self,
            Self::DeviceDisconnect
                | Self::DeviceTmuxMissing
                | Self::SessionCreated
                | Self::SessionClosed
                | Self::TmuxWindowClose
                | Self::TmuxPaneClose
        )
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|event_type| event_type.as_str() == value)
    }
}

impl fmt::Display for EventType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSite {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDevice {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub device_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTmux {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_current_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_current_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub site: EventSite,
    pub device: EventDevice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<EventTmux>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonMap<String, JsonValue>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookEvent {
    pub site: EventSite,
    pub device: EventDevice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<EventTmux>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonMap<String, JsonValue>>,
    pub event_type: EventType,
    pub timestamp: String,
}

impl WebhookEvent {
    pub fn from_draft(event_type: EventType, timestamp: String, draft: EventDraft) -> Self {
        Self {
            site: draft.site,
            device: draft.device,
            tmux: draft.tmux,
            payload: draft.payload,
            event_type,
            timestamp,
        }
    }
}
