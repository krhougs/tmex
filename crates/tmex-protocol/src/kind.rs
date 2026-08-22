use std::fmt;

use crate::ProtocolError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum MessageKind {
    HelloC2s = 0x0001,
    HelloS2c = 0x0002,
    Ping = 0x0003,
    Pong = 0x0004,
    Error = 0x0005,
    DeviceConnect = 0x0101,
    DeviceConnected = 0x0102,
    DeviceDisconnect = 0x0103,
    DeviceDisconnected = 0x0104,
    DeviceEvent = 0x0105,
    TmuxSelect = 0x0201,
    TmuxSelectWindow = 0x0202,
    TmuxCreateWindow = 0x0203,
    TmuxCloseWindow = 0x0204,
    TmuxClosePane = 0x0205,
    TmuxRenameWindow = 0x0206,
    TmuxEvent = 0x0207,
    StateSnapshot = 0x0208,
    StateSnapshotDiff = 0x0209,
    TmuxSetWindowStyle = 0x020a,
    TmuxReorderWindows = 0x020b,
    TmuxReorderPanes = 0x020c,
    TmuxSubscribePanes = 0x020d,
    TmuxFetchPaneHistory = 0x020e,
    TmuxResizePane = 0x020f,
    TmuxApplyStackedLayout = 0x0210,
    TmuxSplitPane = 0x0211,
    TmuxFocusPane = 0x0212,
    TmuxRenamePane = 0x0213,
    TmuxMovePane = 0x0214,
    TmuxBreakPane = 0x0215,
    TmuxWindowCreated = 0x0216,
    TermInput = 0x0301,
    TermPaste = 0x0302,
    TermResize = 0x0303,
    TermSyncSize = 0x0304,
    TermOutput = 0x0305,
    TermHistory = 0x0306,
    ClipboardWrite = 0x0307,
    TermKeyInput = 0x0308,
    SwitchAck = 0x0401,
    LiveResume = 0x0402,
    Chunk = 0x0501,
    AgentSubscribe = 0x0601,
    AgentUnsubscribe = 0x0602,
    AgentEvent = 0x0603,
    WatchEvent = 0x0701,
    SiteThemeUpdate = 0x0801,
    SettingsUpdate = 0x0802,
    NotifyEvent = 0x0803,
    CanonicalCommand = 0x0901,
    CanonicalEvent = 0x0902,
}

impl MessageKind {
    pub const ALL: [Self; 52] = [
        Self::HelloC2s,
        Self::HelloS2c,
        Self::Ping,
        Self::Pong,
        Self::Error,
        Self::DeviceConnect,
        Self::DeviceConnected,
        Self::DeviceDisconnect,
        Self::DeviceDisconnected,
        Self::DeviceEvent,
        Self::TmuxSelect,
        Self::TmuxSelectWindow,
        Self::TmuxCreateWindow,
        Self::TmuxCloseWindow,
        Self::TmuxClosePane,
        Self::TmuxRenameWindow,
        Self::TmuxEvent,
        Self::StateSnapshot,
        Self::StateSnapshotDiff,
        Self::TmuxSetWindowStyle,
        Self::TmuxReorderWindows,
        Self::TmuxReorderPanes,
        Self::TmuxSubscribePanes,
        Self::TmuxFetchPaneHistory,
        Self::TmuxResizePane,
        Self::TmuxApplyStackedLayout,
        Self::TmuxSplitPane,
        Self::TmuxFocusPane,
        Self::TmuxRenamePane,
        Self::TmuxMovePane,
        Self::TmuxBreakPane,
        Self::TmuxWindowCreated,
        Self::TermInput,
        Self::TermPaste,
        Self::TermResize,
        Self::TermSyncSize,
        Self::TermOutput,
        Self::TermHistory,
        Self::ClipboardWrite,
        Self::TermKeyInput,
        Self::SwitchAck,
        Self::LiveResume,
        Self::Chunk,
        Self::AgentSubscribe,
        Self::AgentUnsubscribe,
        Self::AgentEvent,
        Self::WatchEvent,
        Self::SiteThemeUpdate,
        Self::SettingsUpdate,
        Self::NotifyEvent,
        Self::CanonicalCommand,
        Self::CanonicalEvent,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HelloC2s => "HELLO_C2S",
            Self::HelloS2c => "HELLO_S2C",
            Self::Ping => "PING",
            Self::Pong => "PONG",
            Self::Error => "ERROR",
            Self::DeviceConnect => "DEVICE_CONNECT",
            Self::DeviceConnected => "DEVICE_CONNECTED",
            Self::DeviceDisconnect => "DEVICE_DISCONNECT",
            Self::DeviceDisconnected => "DEVICE_DISCONNECTED",
            Self::DeviceEvent => "DEVICE_EVENT",
            Self::TmuxSelect => "TMUX_SELECT",
            Self::TmuxSelectWindow => "TMUX_SELECT_WINDOW",
            Self::TmuxCreateWindow => "TMUX_CREATE_WINDOW",
            Self::TmuxCloseWindow => "TMUX_CLOSE_WINDOW",
            Self::TmuxClosePane => "TMUX_CLOSE_PANE",
            Self::TmuxRenameWindow => "TMUX_RENAME_WINDOW",
            Self::TmuxEvent => "TMUX_EVENT",
            Self::StateSnapshot => "STATE_SNAPSHOT",
            Self::StateSnapshotDiff => "STATE_SNAPSHOT_DIFF",
            Self::TmuxSetWindowStyle => "TMUX_SET_WINDOW_STYLE",
            Self::TmuxReorderWindows => "TMUX_REORDER_WINDOWS",
            Self::TmuxReorderPanes => "TMUX_REORDER_PANES",
            Self::TmuxSubscribePanes => "TMUX_SUBSCRIBE_PANES",
            Self::TmuxFetchPaneHistory => "TMUX_FETCH_PANE_HISTORY",
            Self::TmuxResizePane => "TMUX_RESIZE_PANE",
            Self::TmuxApplyStackedLayout => "TMUX_APPLY_STACKED_LAYOUT",
            Self::TmuxSplitPane => "TMUX_SPLIT_PANE",
            Self::TmuxFocusPane => "TMUX_FOCUS_PANE",
            Self::TmuxRenamePane => "TMUX_RENAME_PANE",
            Self::TmuxMovePane => "TMUX_MOVE_PANE",
            Self::TmuxBreakPane => "TMUX_BREAK_PANE",
            Self::TmuxWindowCreated => "TMUX_WINDOW_CREATED",
            Self::TermInput => "TERM_INPUT",
            Self::TermPaste => "TERM_PASTE",
            Self::TermResize => "TERM_RESIZE",
            Self::TermSyncSize => "TERM_SYNC_SIZE",
            Self::TermKeyInput => "TERM_KEY_INPUT",
            Self::TermOutput => "TERM_OUTPUT",
            Self::TermHistory => "TERM_HISTORY",
            Self::ClipboardWrite => "CLIPBOARD_WRITE",
            Self::SwitchAck => "SWITCH_ACK",
            Self::LiveResume => "LIVE_RESUME",
            Self::Chunk => "CHUNK",
            Self::AgentSubscribe => "AGENT_SUBSCRIBE",
            Self::AgentUnsubscribe => "AGENT_UNSUBSCRIBE",
            Self::AgentEvent => "AGENT_EVENT",
            Self::WatchEvent => "WATCH_EVENT",
            Self::SiteThemeUpdate => "SITE_THEME_UPDATE",
            Self::SettingsUpdate => "SETTINGS_UPDATE",
            Self::NotifyEvent => "NOTIFY_EVENT",
            Self::CanonicalCommand => "CANONICAL_COMMAND",
            Self::CanonicalEvent => "CANONICAL_EVENT",
        }
    }
}

impl TryFrom<u16> for MessageKind {
    type Error = ProtocolError;

    fn try_from(value: u16) -> Result<Self, ProtocolError> {
        Self::ALL
            .into_iter()
            .find(|kind| *kind as u16 == value)
            .ok_or(ProtocolError::UnknownKind(value))
    }
}

impl From<MessageKind> for u16 {
    fn from(value: MessageKind) -> Self {
        value as u16
    }
}

impl fmt::Display for MessageKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_wire_kinds_are_unique_and_round_trip() {
        let mut values = MessageKind::ALL.map(u16::from);
        values.sort_unstable();
        assert!(values.windows(2).all(|pair| pair[0] != pair[1]));

        for kind in MessageKind::ALL {
            assert_eq!(
                MessageKind::try_from(kind as u16).expect("known kind"),
                kind
            );
        }
    }

    #[test]
    fn semantic_key_kind_is_appended_without_reindexing_terminal_kinds() {
        assert_eq!(MessageKind::TermOutput as u16, 0x0305);
        assert_eq!(MessageKind::TermHistory as u16, 0x0306);
        assert_eq!(MessageKind::ClipboardWrite as u16, 0x0307);
        assert_eq!(MessageKind::TermKeyInput as u16, 0x0308);
    }

    #[test]
    fn unknown_kind_preserves_the_wire_value() {
        assert_eq!(
            MessageKind::try_from(0xffff),
            Err(ProtocolError::UnknownKind(0xffff))
        );
    }
}
