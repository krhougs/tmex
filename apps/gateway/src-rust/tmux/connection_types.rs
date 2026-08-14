use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use tmex_protocol::{StateSnapshot, WireToken};
use tmex_terminal::{PaneStreamNotification, PromptMarker};

use super::{
    LifecycleEvent, MetadataProjectionFlush, PaneDataSegment, PaneHistoryPage, PaneReplayGap,
    SourceMetadataEvent, SpawnPolicy, SshDeviceConfig,
};

pub const CONTROL_MAX_RESTARTS: u32 = 3;
pub const CONTROL_RESTART_DELAY: Duration = Duration::from_millis(500);
pub const CONTROL_STABLE_RESET: Duration = Duration::from_secs(10);
pub const CONTROL_STDERR_TAIL_LIMIT: usize = 2048;
pub const CONTROL_ATTACH_READY_TIMEOUT: Duration = Duration::from_secs(3);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);
pub const LOCAL_RUN_TIMEOUT: Duration = Duration::from_secs(30);
pub const REMOTE_RUN_TIMEOUT: Duration = Duration::from_secs(10);
pub const NO_SERVER_RUNNING_RETRY_DELAY: Duration = Duration::from_millis(300);
pub const NO_SERVER_RUNNING_MAX_RETRIES: usize = 2;
pub const RUNTIME_COMMAND_QUEUE_CAPACITY: usize = 256;
pub const RUNTIME_EVENT_QUEUE_CAPACITY: usize = 1024;
pub const CONTROL_CHUNK_QUEUE_CAPACITY: usize = 256;
pub const PARKING_WINDOW_NAME: &str = "tmex-park";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TmuxRuntimeKind {
    Local,
    Ssh,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalTmuxConfig {
    pub tmux_bin: String,
    pub socket_name: Option<String>,
    pub environment: BTreeMap<String, String>,
}

impl Default for LocalTmuxConfig {
    fn default() -> Self {
        Self {
            tmux_bin: "tmux".to_owned(),
            socket_name: None,
            environment: std::env::vars().collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TmuxTransportConfig {
    Local(LocalTmuxConfig),
    Ssh(SshDeviceConfig),
}

#[derive(Clone)]
pub struct DeviceSessionConfig {
    pub device_id: String,
    pub device_name: Option<String>,
    pub session_name: String,
    pub default_working_dir: Option<String>,
    pub tmux_term_program: String,
    pub tmux_window_style: String,
    pub allow_passthrough: bool,
    pub enable_control_mode: bool,
    pub transport: TmuxTransportConfig,
    pub spawn_policy: Arc<dyn SpawnPolicy>,
}

impl fmt::Debug for DeviceSessionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceSessionConfig")
            .field("device_id", &self.device_id)
            .field("device_name", &self.device_name)
            .field("session_name", &self.session_name)
            .field("default_working_dir", &self.default_working_dir)
            .field("tmux_term_program", &self.tmux_term_program)
            .field("tmux_window_style", &self.tmux_window_style)
            .field("allow_passthrough", &self.allow_passthrough)
            .field("enable_control_mode", &self.enable_control_mode)
            .field("transport", &self.transport)
            .finish_non_exhaustive()
    }
}

impl DeviceSessionConfig {
    pub fn normalized_session_name(&self) -> &str {
        let session = self.session_name.trim();
        if session.is_empty() {
            "tmex"
        } else {
            session
        }
    }

    pub fn kind(&self) -> TmuxRuntimeKind {
        match self.transport {
            TmuxTransportConfig::Local(_) => TmuxRuntimeKind::Local,
            TmuxTransportConfig::Ssh(_) => TmuxRuntimeKind::Ssh,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovePanePosition {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeMode {
    Dark,
    Light,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedTerminalHistory {
    pub data: String,
    pub alternate_screen: bool,
    pub modes: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TmuxRuntimeEvent {
    Connected {
        device_id: String,
        server_epoch: WireToken,
    },
    Reconnecting {
        device_id: String,
        attempt: u32,
    },
    Closed {
        device_id: String,
        manual: bool,
    },
    Error {
        device_id: String,
        message: String,
    },
    Snapshot(StateSnapshot),
    Metadata(MetadataProjectionFlush),
    Terminal(PaneDataSegment),
    ReplayGap(PaneReplayGap),
    History(PaneHistoryPage),
    TerminalHistory {
        pane_id: String,
        history: CapturedTerminalHistory,
    },
    PaneActivated {
        window_id: String,
        pane_id: String,
    },
    PromptMarker {
        pane_id: String,
        marker: PromptMarker,
    },
    Title {
        pane_id: String,
        title: String,
    },
    Bell {
        pane_id: String,
    },
    ClipboardWrite {
        pane_id: String,
        text: String,
    },
    Notification {
        pane_id: String,
        notification: PaneStreamNotification,
    },
    SourceMetadata(SourceMetadataEvent),
    Lifecycle(LifecycleEvent),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetMissingMode {
    Reject,
    AllowAndRefresh,
    SilentAndRefresh,
}

pub fn is_no_server_running_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("no server running on") || normalized.contains("connection refused")
}

pub fn is_tmux_server_gone_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "no server running",
        "no sessions",
        "lost server",
        "can't find session",
        "session not found",
        "no such session",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}
