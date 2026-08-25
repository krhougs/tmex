use borsh::{BorshDeserialize, BorshSerialize};

use crate::ProtocolError;

pub type WireToken = [u8; 16];
pub const TERMINAL_PASTE_MAX_BYTES: usize = 1024 * 1024;
pub const TERMINAL_INPUT_MAX_BYTES: usize = TERMINAL_PASTE_MAX_BYTES + 64;


pub const AGENT_EVENT_SYNC: u8 = 1;
pub const AGENT_EVENT_STATUS: u8 = 2;
pub const AGENT_EVENT_TEXT_DELTA: u8 = 3;
pub const AGENT_EVENT_REASONING_DELTA: u8 = 4;
pub const AGENT_EVENT_TOOL_CALL: u8 = 5;
pub const AGENT_EVENT_TOOL_RESULT: u8 = 6;
pub const AGENT_EVENT_CONFIRMATION_REQUEST: u8 = 7;
pub const AGENT_EVENT_CONFIRMATION_RESOLVED: u8 = 8;
pub const AGENT_EVENT_MESSAGE_PERSISTED: u8 = 9;
pub const AGENT_EVENT_ERROR: u8 = 10;
pub const AGENT_EVENT_TURN_FINISHED: u8 = 11;
pub const AGENT_EVENT_CREDENTIAL_WARNING: u8 = 12;
pub const AGENT_EVENT_QUEUE_UPDATED: u8 = 13;

pub const WATCH_EVENT_TRIGGERED: u8 = 1;
pub const WATCH_EVENT_MODEL_UNAVAILABLE: u8 = 2;
pub const WATCH_EVENT_RULE_ERROR: u8 = 3;

macro_rules! device_id_payload {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
        pub struct $name {
            pub device_id: String,
        }
    };
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct HelloC2s {
    pub client_impl: String,
    pub client_version: String,
    pub max_frame_bytes: u32,
    pub supports_compression: bool,
    pub supports_diff_snapshot: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct HelloS2c {
    pub server_impl: String,
    pub server_version: String,
    pub selected_version: u16,
    pub max_frame_bytes: u32,
    pub heartbeat_interval_ms: u32,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct PingPong {
    pub nonce: u32,
    pub time_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct ErrorPayload {
    pub ref_seq: Option<u32>,
    pub code: u16,
    pub message: String,
    pub retryable: bool,
}

device_id_payload!(DeviceConnect);
device_id_payload!(DeviceConnected);
device_id_payload!(DeviceDisconnect);
device_id_payload!(DeviceDisconnected);

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct DeviceEvent {
    pub device_id: String,
    pub event_type: u8,
    pub error_type: Option<String>,
    pub message: Option<String>,
    pub raw_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxSelect {
    pub device_id: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub select_token: WireToken,
    pub want_history: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxSelectWindow {
    pub device_id: String,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxCreateWindow {
    pub device_id: String,
    pub name: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxWindowCreated {
    pub device_id: String,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxCloseWindow {
    pub device_id: String,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxClosePane {
    pub device_id: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxRenameWindow {
    pub device_id: String,
    pub window_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxSetWindowStyle {
    pub device_id: String,
    pub style: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxReorderWindows {
    pub device_id: String,
    pub window_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxReorderPanes {
    pub device_id: String,
    pub window_id: String,
    pub pane_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxEvent {
    pub device_id: String,
    pub event_type: u8,
    pub event_data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxSubscribePanes {
    pub device_id: String,
    pub pane_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxFetchPaneHistory {
    pub device_id: String,
    pub pane_id: String,
    pub request_token: WireToken,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxResizePane {
    pub device_id: String,
    pub pane_id: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxApplyStackedLayout {
    pub device_id: String,
    pub window_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxSplitPane {
    pub device_id: String,
    pub pane_id: String,
    pub direction: u8,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxFocusPane {
    pub device_id: String,
    pub window_id: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxRenamePane {
    pub device_id: String,
    pub pane_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxMovePane {
    pub device_id: String,
    pub src_pane_id: String,
    pub dst_pane_id: String,
    pub position: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TmuxBreakPane {
    pub device_id: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TermData {
    pub device_id: String,
    pub pane_id: String,
    pub encoding: u8,
    pub data: Vec<u8>,
    pub is_composing: bool,
}

pub type TermInput = TermData;
pub type TermPaste = TermData;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TermKeyInput {
    pub device_id: String,
    pub pane_id: String,
    pub key: crate::TerminalKey,
    pub modifiers: u16,
    pub action: crate::TerminalKeyAction,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TermResize {
    pub device_id: String,
    pub pane_id: String,
    pub cols: u16,
    pub rows: u16,
}

pub type TermSyncSize = TermResize;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TermOutput {
    pub device_id: String,
    pub pane_id: String,
    pub encoding: u8,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct TermHistory {
    pub device_id: String,
    pub pane_id: String,
    pub select_token: WireToken,
    pub encoding: u8,
    pub alternate_screen: bool,
    pub modes: u8,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct ClipboardWrite {
    pub device_id: String,
    pub pane_id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SwitchAck {
    pub device_id: String,
    pub window_id: String,
    pub pane_id: String,
    pub select_token: WireToken,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct LiveResume {
    pub device_id: String,
    pub pane_id: String,
    pub select_token: WireToken,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct Chunk {
    pub chunk_stream_id: u32,
    pub original_kind: u16,
    pub original_seq: u32,
    pub total_chunks: u16,
    pub chunk_index: u16,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct PaneWire {
    pub id: String,
    pub window_id: String,
    pub index: u16,
    pub title: Option<String>,
    pub custom_name: Option<String>,
    pub active: bool,
    pub width: u16,
    pub height: u16,
    pub current_path: Option<String>,
    pub current_command: Option<String>,
    pub left: Option<u16>,
    pub top: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct WindowWire {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub index: u16,
    pub active: bool,
    pub layout: Option<String>,
    pub panes: Vec<PaneWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SessionWire {
    pub id: String,
    pub name: String,
    pub windows: Vec<WindowWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct StateSnapshot {
    pub device_id: String,
    pub session: Option<SessionWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct StateSnapshotDiff {
    pub device_id: String,
    pub base_revision: u32,
    pub revision: u32,
    pub diff_format: u8,
    pub diff_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct AgentSubscription {
    pub session_id: String,
}

pub type AgentSubscribe = AgentSubscription;
pub type AgentUnsubscribe = AgentSubscription;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct AgentEvent {
    pub session_id: String,
    pub seq: u32,
    pub event_type: u8,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct WatchEvent {
    pub rule_id: String,
    pub device_id: String,
    pub pane_id: String,
    pub event_type: u8,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct WindowAddEvent {
    pub window_id: String,
}

pub type WindowCloseEvent = WindowAddEvent;
pub type WindowActiveEvent = WindowAddEvent;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct WindowRenamedEvent {
    pub window_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct PaneAddEvent {
    pub pane_id: String,
    pub window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct PaneCloseEvent {
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct PaneActiveEvent {
    pub window_id: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct LayoutChangeEvent {
    pub window_id: String,
    pub layout: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct BellEventV1 {
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub window_index: Option<u16>,
    pub pane_index: Option<u16>,
    pub pane_url: Option<String>,
    pub pane_title: Option<String>,
    pub pane_current_command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct BellEvent {
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub window_index: Option<u16>,
    pub pane_index: Option<u16>,
    pub pane_url: Option<String>,
    pub pane_title: Option<String>,
    pub pane_current_command: Option<String>,
    pub pane_current_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct NotificationEventV1 {
    pub source: u8,
    pub title: Option<String>,
    pub body: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub window_index: Option<u16>,
    pub pane_index: Option<u16>,
    pub pane_url: Option<String>,
    pub pane_title: Option<String>,
    pub pane_current_command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct NotificationEvent {
    pub source: u8,
    pub title: Option<String>,
    pub body: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub window_index: Option<u16>,
    pub pane_index: Option<u16>,
    pub pane_url: Option<String>,
    pub pane_title: Option<String>,
    pub pane_current_command: Option<String>,
    pub pane_current_path: Option<String>,
}

pub const SITE_THEME_DARK: u8 = 0;
pub const SITE_THEME_LIGHT: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SiteThemeUpdateC2s {
    pub theme: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SiteThemeUpdateS2c {
    pub theme: u8,
    pub server_timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SettingsUpdateS2c {
    pub namespace: String,
    pub server_timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct EventNotifyS2c {
    pub event_type: String,
    pub event_json: String,
    pub timestamp: u64,
}

pub fn encode_payload<T: BorshSerialize>(payload: &T) -> Result<Vec<u8>, ProtocolError> {
    borsh::to_vec(payload).map_err(|error| ProtocolError::PayloadDecode(error.to_string()))
}

pub fn decode_payload<T: BorshDeserialize>(data: &[u8]) -> Result<T, ProtocolError> {
    T::try_from_slice(data).map_err(|error| ProtocolError::PayloadDecode(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_payload_matches_borsh_field_order() {
        let payload = HelloC2s {
            client_impl: "fe".into(),
            client_version: "1".into(),
            max_frame_bytes: 1_048_576,
            supports_compression: false,
            supports_diff_snapshot: true,
        };
        let encoded = encode_payload(&payload).expect("encode hello");

        assert_eq!(
            encoded,
            [2, 0, 0, 0, b'f', b'e', 1, 0, 0, 0, b'1', 0, 0, 16, 0, 0, 1,]
        );
        assert_eq!(
            decode_payload::<HelloC2s>(&encoded).expect("decode hello"),
            payload
        );
    }

    #[test]
    fn optional_fields_and_fixed_token_round_trip() {
        let payload = TmuxSelect {
            device_id: "local".into(),
            window_id: Some("@1".into()),
            pane_id: None,
            select_token: [0xab; 16],
            want_history: true,
            cols: Some(120),
            rows: None,
        };
        let encoded = encode_payload(&payload).expect("encode select");

        assert_eq!(
            decode_payload::<TmuxSelect>(&encoded).expect("decode select"),
            payload
        );
    }

    #[test]
    fn v1_notification_decodes_without_the_new_trailing_option() {
        let old = NotificationEventV1 {
            source: 2,
            title: None,
            body: "done".into(),
            window_id: None,
            pane_id: Some("%1".into()),
            window_index: None,
            pane_index: Some(1),
            pane_url: None,
            pane_title: None,
            pane_current_command: Some("codex".into()),
        };
        let encoded = encode_payload(&old).expect("encode v1 notification");

        assert_eq!(
            decode_payload::<NotificationEventV1>(&encoded).expect("decode v1 notification"),
            old
        );
        assert!(decode_payload::<NotificationEvent>(&encoded).is_err());
    }
}
