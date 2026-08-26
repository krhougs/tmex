use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::{self, Write as _};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::FutureExt;
use tmex_protocol::{
    CanonicalHistoryCursor, StateSnapshot, TerminalKey, TerminalKeyAction, WindowWire, WireToken,
};
use tmex_terminal::{
    apply_sequence, encode_pane_option_value, parse_pane_option_value, HeadlessTerminal,
    HeadlessTerminalOptions, KeyboardModeState, KittyGraphicsEvent, TerminalContinuationState,
};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinSet;
use tokio::time::{interval, sleep};

use super::canonical_runtime::DeviceCanonicalState;
use super::kitty_screen_cache::KittyScreenCache;
use super::metadata_projection::parse_layout_leaves;
use super::{
    append_cursor_restore, capture_history_range_command, configure_window_style_commands,
    create_window_command, decode_server_epoch, encode_server_epoch, encode_terminal_key,
    ensure_session_commands, inherited_environment, is_control_mode_supported,
    is_no_server_running_message, is_target_missing_message, is_tmux_server_gone_message,
    join_shell_args, pane_history_info_command, pane_info_command, parse_pane_history_capture_info,
    parse_pane_meta, parse_pane_screen_info, parse_state_snapshot, parse_tmux_version,
    resize_pane_command, resize_window_command, send_input_commands,
    session_configuration_commands, snapshot_commands, start_control_runtime,
    CapturedPaneHistoryPage, CapturedTerminalHistory, ConnectionLifecycleEmitter,
    ControlModeSubscriptionEvent, ControlRuntimeError, ControlRuntimeHandle, DeviceSessionConfig,
    LocalShellPathResolver, LocalTmuxTransport, MetadataProjection, MetadataProjectionError,
    MetadataProjectionSnapshot, MovePanePosition, PaneContinuationModes, PaneEmulator,
    PaneHistoryCaptureInfo, PaneHistoryCursor, PaneHistoryCursorError,
    PaneHistoryCursorErrorReason, PaneHistoryReader, PaneHistorySource, PaneIdentity, PaneInfo,
    PaneModeFlags, PaneRetention, PaneRetentionError, PaneRetentionStats, PaneScreenCheckpoint,
    PaneTerminalCursor, ProcessSshConfigLookup, ProjectionEntityKind, ServerEpochError,
    SnapshotRefreshAction, SnapshotRefreshCoordinator, SnapshotRefreshRunResult, SpawnExecutor,
    SplitDirection, SshConfigError, SshInvocationBuilder, SshTmuxTransport, StandaloneSpawnPolicy,
    SystemOpenSshInvocationBuilder, TargetMissingMode, ThemeMode, ThemeSubscriptionTracker,
    TmuxCommandResult, TmuxLifecycleSink, TmuxRuntimeEvent, TmuxRuntimeKind, TmuxTransport,
    TmuxTransportConfig, TmuxTransportError, CONTROL_MAX_RESTARTS, CONTROL_RESTART_DELAY,
    CONTROL_STABLE_RESET, HEARTBEAT_INTERVAL, LOCAL_RUN_TIMEOUT, NO_SERVER_RUNNING_MAX_RETRIES,
    NO_SERVER_RUNNING_RETRY_DELAY, PARKING_WINDOW_NAME, REMOTE_RUN_TIMEOUT,
    RUNTIME_COMMAND_QUEUE_CAPACITY, RUNTIME_EVENT_QUEUE_CAPACITY,
};

const DEFAULT_COMMAND_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;
const PANE_MODE_ALT_SCREEN: u8 = 1 << 5;
const KITTY_SCREEN_TEXT_RESERVE_BYTES: usize = 512 * 1024;
const PANE_MODE_FLAGS_PRESENT: u8 = 1 << 7;

#[derive(Debug)]
pub enum DeviceSessionRuntimeError {
    Transport(TmuxTransportError),
    Control(ControlRuntimeError),
    SshConfig(SshConfigError),
    ServerEpoch(ServerEpochError),
    Metadata(MetadataProjectionError),
    Retention(PaneRetentionError),
    History(PaneHistoryCursorError),
    Closed,
    Backpressure,
    CommandFailed { command: String, detail: String },
    InvalidTerminalKey(String),
    TmuxVersionUnsupported(String),
    InvalidTmuxOutput(String),
}

impl fmt::Display for DeviceSessionRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(formatter),
            Self::Control(error) => error.fmt(formatter),
            Self::SshConfig(error) => error.fmt(formatter),
            Self::ServerEpoch(error) => error.fmt(formatter),
            Self::Metadata(error) => error.fmt(formatter),
            Self::Retention(error) => error.fmt(formatter),
            Self::History(error) => error.fmt(formatter),
            Self::Closed => formatter.write_str("device session runtime is closed"),
            Self::Backpressure => {
                formatter.write_str("device session runtime command queue is full")
            }
            Self::CommandFailed { command, detail } => {
                write!(formatter, "tmux command failed ({command}): {detail}")
            }
            Self::InvalidTerminalKey(detail) => formatter.write_str(detail),
            Self::TmuxVersionUnsupported(version) => {
                write!(
                    formatter,
                    "tmux control mode requires tmux >= 3.0, got {version}"
                )
            }
            Self::InvalidTmuxOutput(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for DeviceSessionRuntimeError {}

macro_rules! from_error {
    ($source:ty, $variant:ident) => {
        impl From<$source> for DeviceSessionRuntimeError {
            fn from(value: $source) -> Self {
                Self::$variant(value)
            }
        }
    };
}

from_error!(TmuxTransportError, Transport);
from_error!(ControlRuntimeError, Control);
from_error!(SshConfigError, SshConfig);
from_error!(ServerEpochError, ServerEpoch);
from_error!(MetadataProjectionError, Metadata);
from_error!(PaneRetentionError, Retention);
from_error!(PaneHistoryCursorError, History);

#[async_trait]
pub trait TmuxTransportFactory: Send + Sync + 'static {
    async fn create(
        &self,
        config: &DeviceSessionConfig,
    ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError>;
}

#[derive(Clone)]
pub struct DefaultTmuxTransportFactory {
    environment: BTreeMap<String, String>,
    ssh_invocation_builder: Arc<dyn SshInvocationBuilder>,
}

impl Default for DefaultTmuxTransportFactory {
    fn default() -> Self {
        Self {
            environment: inherited_environment(),
            ssh_invocation_builder: Arc::new(SystemOpenSshInvocationBuilder::default()),
        }
    }
}

impl DefaultTmuxTransportFactory {
    pub fn new(
        environment: BTreeMap<String, String>,
        ssh_invocation_builder: Arc<dyn SshInvocationBuilder>,
    ) -> Self {
        Self {
            environment,
            ssh_invocation_builder,
        }
    }
}

#[async_trait]
impl TmuxTransportFactory for DefaultTmuxTransportFactory {
    async fn create(
        &self,
        config: &DeviceSessionConfig,
    ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError> {
        let executor = SpawnExecutor::new(config.spawn_policy.clone());
        match &config.transport {
            TmuxTransportConfig::Local(local) => {
                let resolved_path = LocalShellPathResolver::new(
                    executor.clone(),
                    super::HostPlatform::current(),
                    local.environment.clone(),
                )
                .resolve()
                .await
                .map_err(|error| {
                    DeviceSessionRuntimeError::Transport(TmuxTransportError::Spawn(error))
                })?;
                Ok(Arc::new(LocalTmuxTransport::new(
                    local.clone(),
                    executor,
                    resolved_path.as_deref(),
                )))
            }
            TmuxTransportConfig::Ssh(ssh) => {
                let lookup = Arc::new(ProcessSshConfigLookup::new(
                    executor.clone(),
                    self.environment.clone(),
                ));
                let resolved =
                    super::resolve_ssh_connect_config(ssh, &self.environment, lookup).await?;
                Ok(Arc::new(
                    SshTmuxTransport::connect(
                        resolved,
                        executor,
                        self.ssh_invocation_builder.clone(),
                    )
                    .await?,
                ))
            }
        }
    }
}

enum RuntimeCommand {
    SendInput {
        pane_id: String,
        data: Vec<u8>,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    SendKey {
        pane_id: String,
        key: TerminalKey,
        modifiers: u16,
        action: TerminalKeyAction,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    SendInputOneWay {
        pane_id: String,
        data: Vec<u8>,
    },
    SendInputBatchOneWay {
        pane_id: String,
        chunks: Vec<Vec<u8>>,
    },
    ResizePaneOneWay {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    SelectPane {
        window_id: String,
        pane_id: String,
        size: Option<(u16, u16)>,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    ResizeWindowForPane {
        pane_id: String,
        cols: u16,
        rows: u16,
        response: Option<oneshot::Sender<Result<(), DeviceSessionRuntimeError>>>,
    },
    UpdateDefaultWorkingDir {
        default_working_dir: Option<String>,
    },
    SetCustomName {
        kind: ProjectionEntityKind,
        native_id: String,
        name: Option<String>,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    SetWindowStyle {
        style: String,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    CreateWindow {
        name: Option<String>,
        cwd: Option<String>,
        response: oneshot::Sender<Result<Option<String>, DeviceSessionRuntimeError>>,
    },
    SplitPane {
        pane_id: String,
        direction: SplitDirection,
        cwd: Option<String>,
        response: oneshot::Sender<Result<TmuxCommandResult, DeviceSessionRuntimeError>>,
    },
    SignalTheme {
        pane_id: String,
        theme: ThemeMode,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    Run {
        args: Vec<String>,
        missing: TargetMissingMode,
        refresh: bool,
        response: oneshot::Sender<Result<TmuxCommandResult, DeviceSessionRuntimeError>>,
    },
    RunBatch {
        commands: Vec<(Vec<String>, TargetMissingMode)>,
        refresh: bool,
        response: oneshot::Sender<Result<Vec<TmuxCommandResult>, DeviceSessionRuntimeError>>,
    },
    CloseWindow {
        window_id: String,
        response: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
    },
    RequestSnapshot,
    CaptureText {
        pane_id: String,
        history_lines: Option<usize>,
        response: oneshot::Sender<Result<String, DeviceSessionRuntimeError>>,
    },
    FetchTerminalHistory {
        pane_id: String,
        response:
            oneshot::Sender<Result<Option<CapturedTerminalHistory>, DeviceSessionRuntimeError>>,
    },
    PaneInfo {
        pane_id: String,
        response: oneshot::Sender<Result<PaneInfo, DeviceSessionRuntimeError>>,
    },
    ReadHistory {
        pane_id: String,
        cursor: Option<PaneHistoryCursor>,
        byte_limit: usize,
        response:
            oneshot::Sender<Result<Option<CapturedPaneHistoryPage>, DeviceSessionRuntimeError>>,
    },
    CaptureScreen {
        pane_id: String,
        byte_limit: usize,
        response: oneshot::Sender<Result<Option<PaneScreenCheckpoint>, DeviceSessionRuntimeError>>,
    },
    GetSnapshot(oneshot::Sender<Option<StateSnapshot>>),
    GetMetadata(oneshot::Sender<MetadataProjectionSnapshot>),
    GetPaneIdentity {
        pane_id: String,
        response: oneshot::Sender<Option<PaneIdentity>>,
    },
    GetRetentionStats(oneshot::Sender<PaneRetentionStats>),
    Shutdown(oneshot::Sender<()>),
    SnapshotFinished {
        base_revision: u64,
        result: Result<StateSnapshot, DeviceSessionRuntimeError>,
    },
    #[cfg(test)]
    InjectControlEventForTest {
        event: Box<ControlModeSubscriptionEvent>,
    },
    #[cfg(test)]
    PanicForTest,
}

pub(crate) struct RuntimeCommandCompletion {
    receiver: oneshot::Receiver<Result<(), DeviceSessionRuntimeError>>,
}

impl RuntimeCommandCompletion {
    pub(crate) async fn wait(self) -> Result<(), DeviceSessionRuntimeError> {
        self.receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }
}

#[derive(Clone)]
pub struct DeviceSessionRuntime {
    device_id: String,
    session_name: String,
    commands: mpsc::Sender<RuntimeCommand>,
    events: broadcast::Sender<TmuxRuntimeEvent>,
    terminated: Arc<AtomicBool>,
    pub(super) canonical: DeviceCanonicalState,
}

impl DeviceSessionRuntime {
    pub async fn start(
        config: DeviceSessionConfig,
        factory: Arc<dyn TmuxTransportFactory>,
    ) -> Result<Self, DeviceSessionRuntimeError> {
        Self::start_with_lifecycle_sink(config, factory, None).await
    }

    pub async fn start_with_lifecycle_sink(
        config: DeviceSessionConfig,
        factory: Arc<dyn TmuxTransportFactory>,
        lifecycle_sink: Option<Arc<dyn TmuxLifecycleSink>>,
    ) -> Result<Self, DeviceSessionRuntimeError> {
        let device_id = config.device_id.clone();
        let session_name = config.normalized_session_name().to_owned();
        let (commands, receiver) = mpsc::channel(RUNTIME_COMMAND_QUEUE_CAPACITY);
        let (events, _) = broadcast::channel(RUNTIME_EVENT_QUEUE_CAPACITY);
        let terminated = Arc::new(AtomicBool::new(false));
        let metadata =
            MetadataProjection::new(config.device_id.clone(), config.device_name.clone());
        let retention = PaneRetention::default();
        let canonical = DeviceCanonicalState::new(retention.clone(), metadata.current_snapshot());
        let (ready, ready_receiver) = oneshot::channel();
        let guarded_device_id = device_id.clone();
        let guarded_events = events.clone();
        let guarded_canonical = canonical.clone();
        let guarded_terminated = terminated.clone();
        let actor_events = events.clone();
        let actor_canonical = canonical.clone();
        let actor_terminated = terminated.clone();
        let command_sender = commands.downgrade();
        tokio::spawn(async move {
            if AssertUnwindSafe(run_actor(
                config,
                factory,
                metadata,
                retention,
                actor_canonical,
                command_sender,
                receiver,
                actor_events,
                actor_terminated,
                lifecycle_sink,
                ready,
            ))
            .catch_unwind()
            .await
            .is_err()
            {
                guarded_canonical.close();
                guarded_terminated.store(true, Ordering::Release);
                let message = "device session runtime task panicked".to_owned();
                let _ = guarded_events.send(TmuxRuntimeEvent::Error {
                    device_id: guarded_device_id.clone(),
                    message,
                });
                let _ = guarded_events.send(TmuxRuntimeEvent::Closed {
                    device_id: guarded_device_id,
                    manual: false,
                });
            }
        });
        ready_receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)??;
        Ok(Self {
            device_id,
            session_name,
            commands,
            events,
            terminated,
            canonical,
        })
    }

    pub async fn start_standalone(
        mut config: DeviceSessionConfig,
    ) -> Result<Self, DeviceSessionRuntimeError> {
        config.spawn_policy = Arc::new(StandaloneSpawnPolicy);
        Self::start(config, Arc::new(DefaultTmuxTransportFactory::default())).await
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn is_terminated(&self) -> bool {
        self.terminated.load(Ordering::Acquire)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TmuxRuntimeEvent> {
        self.events.subscribe()
    }

    pub async fn run_tmux(
        &self,
        args: Vec<String>,
        missing: TargetMissingMode,
        refresh: bool,
    ) -> Result<TmuxCommandResult, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::Run {
                args,
                missing,
                refresh,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn run_tmux_batch(
        &self,
        commands: Vec<(Vec<String>, TargetMissingMode)>,
        refresh: bool,
    ) -> Result<Vec<TmuxCommandResult>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::RunBatch {
                commands,
                refresh,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub fn request_snapshot(&self) -> Result<(), DeviceSessionRuntimeError> {
        self.commands
            .try_send(RuntimeCommand::RequestSnapshot)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => DeviceSessionRuntimeError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => DeviceSessionRuntimeError::Closed,
            })
    }

    pub async fn send_input_bytes(
        &self,
        pane_id: &str,
        data: &[u8],
    ) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SendInput {
                pane_id: pane_id.to_owned(),
                data: data.to_vec(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn send_key_input(
        &self,
        pane_id: &str,
        key: TerminalKey,
        modifiers: u16,
        action: TerminalKeyAction,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SendKey {
                pane_id: pane_id.to_owned(),
                key,
                modifiers,
                action,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn enqueue_input_bytes(
        &self,
        pane_id: &str,
        data: &[u8],
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .send(RuntimeCommand::SendInputOneWay {
                pane_id: pane_id.to_owned(),
                data: data.to_vec(),
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub(crate) async fn enqueue_input_batch(
        &self,
        pane_id: &str,
        chunks: Vec<Vec<u8>>,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .send(RuntimeCommand::SendInputBatchOneWay {
                pane_id: pane_id.to_owned(),
                chunks,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub fn try_send_input_bytes(
        &self,
        pane_id: &str,
        data: &[u8],
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .try_send(RuntimeCommand::SendInputOneWay {
                pane_id: pane_id.to_owned(),
                data: data.to_vec(),
            })
            .map_err(map_try_send_error)
    }

    pub async fn resize_window(
        &self,
        window_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            resize_window_command(window_id, cols, rows),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn resize_window_for_pane(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::ResizeWindowForPane {
                pane_id: pane_id.to_owned(),
                cols,
                rows,
                response: Some(response),
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub(crate) async fn enqueue_resize_window_for_pane(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .send(RuntimeCommand::ResizeWindowForPane {
                pane_id: pane_id.to_owned(),
                cols,
                rows,
                response: None,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub async fn resize_pane(
        &self,
        pane_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            resize_pane_command(pane_id, cols, rows),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub fn try_resize_pane(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .try_send(RuntimeCommand::ResizePaneOneWay {
                pane_id: pane_id.to_owned(),
                cols,
                rows,
            })
            .map_err(map_try_send_error)
    }

    pub async fn enqueue_resize_pane(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .send(RuntimeCommand::ResizePaneOneWay {
                pane_id: pane_id.to_owned(),
                cols,
                rows,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub fn try_update_default_working_dir(
        &self,
        default_working_dir: Option<String>,
    ) -> Result<(), DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.commands
            .try_send(RuntimeCommand::UpdateDefaultWorkingDir {
                default_working_dir,
            })
            .map_err(map_try_send_error)
    }

    pub async fn set_custom_name(
        &self,
        kind: ProjectionEntityKind,
        native_id: &str,
        name: Option<String>,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SetCustomName {
                kind,
                native_id: native_id.to_owned(),
                name,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn set_window_style(&self, style: &str) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SetWindowStyle {
                style: style.to_owned(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn select_window(&self, window_id: &str) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            strings(["select-window", "-t", window_id]),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn select_pane(
        &self,
        window_id: &str,
        pane_id: &str,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.enqueue_select_pane(window_id, pane_id, None)
            .await?
            .wait()
            .await
    }

    pub(crate) async fn enqueue_select_pane(
        &self,
        window_id: &str,
        pane_id: &str,
        size: Option<(u16, u16)>,
    ) -> Result<RuntimeCommandCompletion, DeviceSessionRuntimeError> {
        if self.canonical.is_closed() {
            return Err(DeviceSessionRuntimeError::Closed);
        }
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SelectPane {
                window_id: window_id.to_owned(),
                pane_id: pane_id.to_owned(),
                size,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        Ok(RuntimeCommandCompletion { receiver })
    }

    pub async fn create_window(
        &self,
        name: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Option<String>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::CreateWindow {
                name: name.map(str::to_owned),
                cwd: cwd.map(str::to_owned),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn close_window(&self, window_id: &str) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::CloseWindow {
                window_id: window_id.to_owned(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn close_pane(&self, pane_id: &str) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            strings(["kill-pane", "-t", pane_id]),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn split_pane(
        &self,
        pane_id: &str,
        direction: SplitDirection,
        cwd: Option<&str>,
    ) -> Result<TmuxCommandResult, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SplitPane {
                pane_id: pane_id.to_owned(),
                direction,
                cwd: cwd.map(str::to_owned),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn move_pane(
        &self,
        source_pane_id: &str,
        target_pane_id: &str,
        position: MovePanePosition,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            super::move_pane_command(source_pane_id, target_pane_id, position),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn break_pane(
        &self,
        pane_id: &str,
    ) -> Result<Option<(String, String)>, DeviceSessionRuntimeError> {
        let result = self
            .run_tmux(
                vec![
                    "break-pane".to_owned(),
                    "-s".to_owned(),
                    pane_id.to_owned(),
                    "-t".to_owned(),
                    format!("{}:", self.session_name),
                    "-P".to_owned(),
                    "-F".to_owned(),
                    "#{window_id}|#{pane_id}".to_owned(),
                ],
                TargetMissingMode::AllowAndRefresh,
                true,
            )
            .await?;
        let Some((window_id, new_pane_id)) = result.stdout.trim().split_once('|') else {
            return Ok(None);
        };
        if !super::is_tmux_window_id(window_id) || !super::is_tmux_pane_id(new_pane_id) {
            return Ok(None);
        }
        self.events
            .send(TmuxRuntimeEvent::PaneActivated {
                window_id: window_id.to_owned(),
                pane_id: new_pane_id.to_owned(),
            })
            .ok();
        Ok(Some((window_id.to_owned(), new_pane_id.to_owned())))
    }

    pub async fn select_layout_even_horizontal(
        &self,
        window_id: &str,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            strings(["select-layout", "-t", window_id, "even-horizontal"]),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn apply_stacked_layout(
        &self,
        window_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux_batch(
            vec![
                (
                    resize_window_command(window_id, cols, rows),
                    TargetMissingMode::AllowAndRefresh,
                ),
                (
                    strings(["select-layout", "-t", window_id, "even-horizontal"]),
                    TargetMissingMode::AllowAndRefresh,
                ),
            ],
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn rename_window(
        &self,
        window_id: &str,
        name: &str,
    ) -> Result<(), DeviceSessionRuntimeError> {
        self.run_tmux(
            strings(["rename-window", "-t", window_id, name]),
            TargetMissingMode::AllowAndRefresh,
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn signal_theme_change(
        &self,
        pane_id: &str,
        theme: ThemeMode,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::SignalTheme {
                pane_id: pane_id.to_owned(),
                theme,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn capture_pane_text(
        &self,
        pane_id: &str,
        history_lines: Option<usize>,
    ) -> Result<String, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::CaptureText {
                pane_id: pane_id.to_owned(),
                history_lines,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn fetch_pane_history(
        &self,
        pane_id: &str,
    ) -> Result<Option<CapturedTerminalHistory>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::FetchTerminalHistory {
                pane_id: pane_id.to_owned(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn pane_info(&self, pane_id: &str) -> Result<PaneInfo, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::PaneInfo {
                pane_id: pane_id.to_owned(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn read_pane_history(
        &self,
        pane_id: &str,
        cursor: Option<PaneHistoryCursor>,
        byte_limit: usize,
    ) -> Result<Option<CapturedPaneHistoryPage>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::ReadHistory {
                pane_id: pane_id.to_owned(),
                cursor,
                byte_limit,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn capture_canonical_screen(
        &self,
        pane_id: &str,
        byte_limit: usize,
    ) -> Result<Option<PaneScreenCheckpoint>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::CaptureScreen {
                pane_id: pane_id.to_owned(),
                byte_limit,
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?
    }

    pub async fn current_snapshot(
        &self,
    ) -> Result<Option<StateSnapshot>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::GetSnapshot(response))
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub async fn metadata_snapshot(
        &self,
    ) -> Result<MetadataProjectionSnapshot, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::GetMetadata(response))
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub async fn pane_identity(
        &self,
        pane_id: &str,
    ) -> Result<Option<PaneIdentity>, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::GetPaneIdentity {
                pane_id: pane_id.to_owned(),
                response,
            })
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub async fn retention_stats(&self) -> Result<PaneRetentionStats, DeviceSessionRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(RuntimeCommand::GetRetentionStats(response))
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)?;
        receiver
            .await
            .map_err(|_| DeviceSessionRuntimeError::Closed)
    }

    pub async fn shutdown(&self) {
        if self.terminated.load(Ordering::Acquire) {
            return;
        }
        let (response, receiver) = oneshot::channel();
        if self
            .commands
            .send(RuntimeCommand::Shutdown(response))
            .await
            .is_ok()
        {
            let _ = receiver.await;
        }
    }

    #[cfg(test)]
    async fn panic_actor_for_test(&self) {
        let _ = self.commands.send(RuntimeCommand::PanicForTest).await;
    }

    #[cfg(test)]
    async fn inject_control_event_for_test(&self, event: ControlModeSubscriptionEvent) {
        let _ = self
            .commands
            .send(RuntimeCommand::InjectControlEventForTest {
                event: Box::new(event),
            })
            .await;
    }
}

#[async_trait]
impl super::ManagedTmuxRuntime for DeviceSessionRuntime {
    fn is_terminated(&self) -> bool {
        self.is_terminated()
    }

    async fn shutdown(&self) {
        self.shutdown().await;
    }
}

struct RuntimeActor {
    config: DeviceSessionConfig,
    transport: Arc<dyn TmuxTransport>,
    commands: mpsc::WeakSender<RuntimeCommand>,
    events: broadcast::Sender<TmuxRuntimeEvent>,
    control_events: mpsc::Receiver<ControlModeSubscriptionEvent>,
    control_events_tx: mpsc::Sender<ControlModeSubscriptionEvent>,
    control: Option<ControlRuntimeHandle>,
    metadata: MetadataProjection,
    retention: PaneRetention,
    canonical: DeviceCanonicalState,
    history: PaneHistoryReader,
    emulators: HashMap<String, PaneEmulator>,
    keyboard_modes: HashMap<String, KeyboardModeState>,
    kitty_screen_cache: KittyScreenCache,
    theme_subscriptions: ThemeSubscriptionTracker,
    snapshot: Option<StateSnapshot>,
    snapshot_refresh: SnapshotRefreshCoordinator,
    lifecycle: ConnectionLifecycleEmitter,
    lifecycle_sink: Option<Arc<dyn TmuxLifecycleSink>>,
    control_restart_count: u32,
    control_started_at_ms: u64,
    manual_shutdown: bool,
    shutdown_ack: Option<oneshot::Sender<()>>,
}

type CommandCompletion = Box<dyn FnOnce(&mut RuntimeActor) -> bool + Send>;

async fn resize_window_via(
    transport: &Arc<dyn TmuxTransport>,
    kind: TmuxRuntimeKind,
    pane_id: &str,
    window_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<Option<()>, DeviceSessionRuntimeError> {
    let window_id = match window_id {
        Some(window_id) => window_id,
        None => {
            let output = checked_command(
                transport,
                &strings(["display-message", "-p", "-t", pane_id, "#{window_id}"]),
                kind,
                TargetMissingMode::AllowAndRefresh,
            )
            .await?;
            let window_id = output.stdout.trim();
            if !super::is_tmux_window_id(window_id) {
                return Ok(None);
            }
            window_id.to_owned()
        }
    };
    checked_command(
        transport,
        &resize_window_command(&window_id, cols, rows),
        kind,
        TargetMissingMode::AllowAndRefresh,
    )
    .await
    .map(|_| Some(()))
}

async fn close_window_via(
    transport: &Arc<dyn TmuxTransport>,
    kind: TmuxRuntimeKind,
    session: &str,
    cwd: &str,
    window_id: &str,
) -> Result<(), DeviceSessionRuntimeError> {
    let count = checked_command(
        transport,
        &strings(["display-message", "-p", "-t", session, "#{session_windows}"]),
        kind,
        TargetMissingMode::Reject,
    )
    .await?
    .stdout
    .trim()
    .parse::<usize>()
    .unwrap_or(0);
    if count <= 1 {
        checked_command(
            transport,
            &strings(["new-window", "-d", "-t", session, "-c", cwd]),
            kind,
            TargetMissingMode::Reject,
        )
        .await?;
    }
    checked_command(
        transport,
        &strings(["kill-window", "-t", window_id]),
        kind,
        TargetMissingMode::AllowAndRefresh,
    )
    .await
    .map(|_| ())
}

async fn configure_window_style_via(
    transport: &Arc<dyn TmuxTransport>,
    kind: TmuxRuntimeKind,
    session: &str,
    style: &str,
) -> Result<(), DeviceSessionRuntimeError> {
    let list = checked_command(
        transport,
        &strings(["list-windows", "-t", session, "-F", "#{window_id}"]),
        kind,
        TargetMissingMode::Reject,
    )
    .await?;
    let windows = list
        .stdout
        .lines()
        .map(str::trim)
        .filter(|id| super::is_tmux_window_id(id))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(commands) = configure_window_style_commands(session, &windows, style) {
        for command in commands {
            checked_command(transport, &command, kind, TargetMissingMode::Reject).await?;
        }
    }
    Ok(())
}

async fn fetch_terminal_history_via(
    transport: &Arc<dyn TmuxTransport>,
    kind: TmuxRuntimeKind,
    pane_id: &str,
) -> Result<Option<CapturedTerminalHistory>, DeviceSessionRuntimeError> {
    let screen = checked_command(
        transport,
        &super::pane_screen_info_command(pane_id),
        kind,
        TargetMissingMode::AllowAndRefresh,
    )
    .await?;
    let screen = parse_pane_screen_info(&screen.stdout);
    // Terminal replay needs physical rows and their padded cells; `-J` is only for text scraping.
    let normal = checked_command(
        transport,
        &strings([
            "capture-pane",
            "-t",
            pane_id,
            "-S",
            "-",
            "-E",
            "-",
            "-e",
            "-N",
            "-p",
        ]),
        kind,
        TargetMissingMode::AllowAndRefresh,
    )
    .await?
    .stdout;
    let alternate = checked_command(
        transport,
        &strings([
            "capture-pane",
            "-t",
            pane_id,
            "-a",
            "-S",
            "-",
            "-E",
            "-",
            "-e",
            "-N",
            "-p",
            "-q",
        ]),
        kind,
        TargetMissingMode::AllowAndRefresh,
    )
    .await?
    .stdout;
    let history = if screen.alternate_screen {
        if !normal.trim().is_empty() {
            normal
        } else {
            alternate
        }
    } else if !normal.is_empty() {
        normal
    } else {
        alternate
    };
    if history.is_empty() {
        return Ok(None);
    }
    Ok(Some(CapturedTerminalHistory {
        data: append_cursor_restore(&history, &screen),
        alternate_screen: screen.alternate_screen,
        modes: encode_pane_modes(&screen.modes, false) & !PANE_MODE_FLAGS_PRESENT,
    }))
}
#[allow(clippy::too_many_arguments)]
async fn run_actor(
    config: DeviceSessionConfig,
    factory: Arc<dyn TmuxTransportFactory>,
    metadata: MetadataProjection,
    retention: PaneRetention,
    canonical: DeviceCanonicalState,
    command_sender: mpsc::WeakSender<RuntimeCommand>,
    mut command_receiver: mpsc::Receiver<RuntimeCommand>,
    events: broadcast::Sender<TmuxRuntimeEvent>,
    terminated: Arc<AtomicBool>,
    lifecycle_sink: Option<Arc<dyn TmuxLifecycleSink>>,
    ready: oneshot::Sender<Result<(), DeviceSessionRuntimeError>>,
) {
    let transport = match factory.create(&config).await {
        Ok(transport) => transport,
        Err(error) => {
            terminated.store(true, Ordering::Release);
            let _ = ready.send(Err(error));
            return;
        }
    };
    let history_source = Arc::new(TransportPaneHistorySource {
        transport: transport.clone(),
        deadline: command_deadline(config.kind()),
    });
    let (control_events_tx, control_events) = mpsc::channel(RUNTIME_EVENT_QUEUE_CAPACITY);
    let mut actor = RuntimeActor {
        metadata,
        retention,
        canonical,
        history: PaneHistoryReader::new(history_source),
        emulators: HashMap::new(),
        keyboard_modes: HashMap::new(),
        kitty_screen_cache: KittyScreenCache::default(),
        theme_subscriptions: ThemeSubscriptionTracker::new(),
        snapshot: None,
        snapshot_refresh: SnapshotRefreshCoordinator::new(),
        lifecycle: ConnectionLifecycleEmitter::new(),
        lifecycle_sink,
        control_restart_count: 0,
        control_started_at_ms: 0,
        manual_shutdown: false,
        shutdown_ack: None,
        config,
        transport,
        commands: command_sender,
        events,
        control_events,
        control_events_tx,
        control: None,
    };
    if let Err(error) = actor.connect().await {
        actor.shutdown().await;
        terminated.store(true, Ordering::Release);
        let _ = ready.send(Err(error));
        return;
    }
    if ready.send(Ok(())).is_err() {
        actor.shutdown().await;
        terminated.store(true, Ordering::Release);
        return;
    }
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;
    let mut metadata_flush = interval(Duration::from_millis(8));
    metadata_flush.tick().await;
    let mut inflight = JoinSet::<CommandCompletion>::new();
    loop {
        tokio::select! {
            biased;
            event = actor.control_events.recv() => {
                let Some(event) = event else { continue; };
                if actor.handle_control_event(event).await { break; }
            }
            completed = inflight.join_next(), if !inflight.is_empty() => {
                match completed {
                    Some(Ok(completion)) => {
                        if completion(&mut actor) { break; }
                    }
                    Some(Err(error)) => actor.emit_error(format!("command task failed: {error}")),
                    None => {}
                }
            }
            command = command_receiver.recv() => {
                let Some(command) = command else { break; };
                if actor.handle_command(command, &mut inflight).await { break; }
            }
            _ = heartbeat.tick(), if actor.control.is_some() => {
                if let Some(control) = &actor.control { let _ = control.heartbeat(); }
            }
            _ = metadata_flush.tick() => {
                actor.flush_metadata();
            }
        }
    }
    inflight.abort_all();
    actor.shutdown().await;
    terminated.store(true, Ordering::Release);
    if let Some(response) = actor.shutdown_ack.take() {
        let _ = response.send(());
    }
}

impl RuntimeActor {
    async fn connect(&mut self) -> Result<(), DeviceSessionRuntimeError> {
        let version = checked_command(
            &self.transport,
            &["-V".to_owned()],
            self.config.kind(),
            TargetMissingMode::Reject,
        )
        .await?;
        let version_gated = match self.config.kind() {
            TmuxRuntimeKind::Ssh => true,
            TmuxRuntimeKind::Local => self.config.enable_control_mode,
        };
        if version_gated && !is_control_mode_supported(parse_tmux_version(&version.stdout)) {
            return Err(DeviceSessionRuntimeError::TmuxVersionUnsupported(
                version.stdout.trim().to_owned(),
            ));
        }
        let session = self.config.normalized_session_name().to_owned();
        let cwd = self.default_working_dir();
        let [has_session, new_session] = ensure_session_commands(&session, &cwd);
        let has = run_allow_failure(&self.transport, &has_session, self.config.kind()).await?;
        let created = has.exit_code != 0;
        if created {
            checked_command(
                &self.transport,
                &new_session,
                self.config.kind(),
                TargetMissingMode::Reject,
            )
            .await?;
        }
        let server_epoch = self.ensure_server_epoch().await?;
        self.metadata.set_server_epoch(server_epoch);
        self.canonical.sync_projection(
            self.metadata.server_epoch(),
            self.metadata.current_snapshot(),
            &[],
        );
        let term_program = self.config.tmux_term_program.trim();
        let ghostty_terminfo_available =
            term_program == "ghostty" && self.transport.ensure_ghostty_terminfo().await;
        for command in session_configuration_commands(
            &session,
            self.config.allow_passthrough,
            term_program,
            ghostty_terminfo_available,
            &cwd,
        ) {
            run_allow_failure(&self.transport, &command, self.config.kind()).await?;
        }
        self.configure_window_style().await?;
        if self.config.enable_control_mode {
            self.start_control().await?;
        }
        self.restore_keyboard_modes().await;
        self.restore_theme_subscriptions().await;
        if created {
            self.emit(TmuxRuntimeEvent::Lifecycle(
                ConnectionLifecycleEmitter::notify_session_created(session.clone()),
            ));
        }
        let snapshot = fetch_snapshot(
            self.transport.clone(),
            &self.config.device_id,
            &session,
            self.config.kind(),
        )
        .await?;
        self.apply_snapshot(snapshot, self.metadata.revision())?;
        self.emit(TmuxRuntimeEvent::Connected {
            device_id: self.config.device_id.clone(),
            server_epoch,
        });
        Ok(())
    }

    async fn ensure_server_epoch(&mut self) -> Result<WireToken, DeviceSessionRuntimeError> {
        let show = strings(["show-options", "-gqv", super::TMEX_SERVER_EPOCH_OPTION]);
        let existing = run_allow_failure(&self.transport, &show, self.config.kind()).await?;
        if existing.exit_code == 0 && !existing.stdout.trim().is_empty() {
            return Ok(decode_server_epoch(&existing.stdout)?);
        }
        let candidate: WireToken = rand::random();
        let set = vec![
            "set-option".to_owned(),
            "-gq".to_owned(),
            "-o".to_owned(),
            super::TMEX_SERVER_EPOCH_OPTION.to_owned(),
            encode_server_epoch(candidate),
        ];
        checked_command(
            &self.transport,
            &set,
            self.config.kind(),
            TargetMissingMode::Reject,
        )
        .await?;
        let resolved = checked_command(
            &self.transport,
            &show,
            self.config.kind(),
            TargetMissingMode::Reject,
        )
        .await?;
        Ok(decode_server_epoch(&resolved.stdout)?)
    }

    async fn configure_window_style(&mut self) -> Result<(), DeviceSessionRuntimeError> {
        let style = self.config.tmux_window_style.clone();
        self.configure_window_style_value(&style).await
    }

    async fn configure_window_style_value(
        &mut self,
        style: &str,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let session = self.config.normalized_session_name();
        let list = checked_command(
            &self.transport,
            &strings(["list-windows", "-t", session, "-F", "#{window_id}"]),
            self.config.kind(),
            TargetMissingMode::Reject,
        )
        .await?;
        let windows = list
            .stdout
            .lines()
            .map(str::trim)
            .filter(|id| super::is_tmux_window_id(id))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if let Some(commands) = configure_window_style_commands(session, &windows, style) {
            for command in commands {
                checked_command(
                    &self.transport,
                    &command,
                    self.config.kind(),
                    TargetMissingMode::Reject,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn start_control(&mut self) -> Result<(), DeviceSessionRuntimeError> {
        let session = self.config.normalized_session_name().to_owned();
        let parking = strings([
            "new-window",
            "-t",
            &session,
            "-n",
            PARKING_WINDOW_NAME,
            "-P",
            "-F",
            "#{window_id}",
            self.transport.parking_command(),
        ]);
        let parking_id = run_allow_failure(&self.transport, &parking, self.config.kind())
            .await?
            .stdout
            .trim()
            .to_owned();
        let control = start_control_runtime(
            self.transport.clone(),
            &session,
            self.control_events_tx.clone(),
        )
        .await;
        if super::is_tmux_window_id(&parking_id) {
            let _ = run_allow_failure(
                &self.transport,
                &strings(["last-window", "-t", &session]),
                self.config.kind(),
            )
            .await;
            let _ = run_allow_failure(
                &self.transport,
                &strings(["kill-window", "-t", &parking_id]),
                self.config.kind(),
            )
            .await;
        }
        self.control = Some(control?);
        self.control_started_at_ms = system_time_ms();
        Ok(())
    }

    async fn select_pane(
        &mut self,
        window_id: &str,
        pane_id: &str,
        size: Option<(u16, u16)>,
    ) -> Result<(), DeviceSessionRuntimeError> {
        checked_command(
            &self.transport,
            &strings(["select-window", "-t", window_id]),
            self.config.kind(),
            TargetMissingMode::AllowAndRefresh,
        )
        .await?;
        let selected = checked_command(
            &self.transport,
            &strings(["select-pane", "-t", pane_id]),
            self.config.kind(),
            TargetMissingMode::AllowAndRefresh,
        )
        .await;
        if selected
            .as_ref()
            .err()
            .is_none_or(|error| !is_tmux_server_gone_message(&error.to_string()))
        {
            self.request_snapshot();
        }
        selected?;
        if let Some((cols, rows)) = size {
            self.resize_window_for_pane(pane_id, cols, rows).await?;
        }
        Ok(())
    }

    async fn resize_window_for_pane(
        &mut self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let snapshot_window = self.snapshot.as_ref().and_then(|snapshot| {
            snapshot.session.as_ref().and_then(|session| {
                session
                    .windows
                    .iter()
                    .find(|window| window.panes.iter().any(|pane| pane.id == pane_id))
            })
        });
        let window_id = if let Some(window) = snapshot_window {
            if window.panes.len() > 1 {
                if crate::ws::parse_window_layout_size(window.layout.as_deref()).is_some_and(
                    |(current_cols, current_rows)| current_cols == cols && current_rows == rows,
                ) {
                    return Ok(());
                }
            } else if window
                .panes
                .iter()
                .any(|pane| pane.id == pane_id && pane.width == cols && pane.height == rows)
            {
                return Ok(());
            }
            Some(window.id.clone())
        } else {
            None
        };
        let window_id = match window_id {
            Some(window_id) => window_id,
            None => {
                let output = checked_command(
                    &self.transport,
                    &strings(["display-message", "-p", "-t", pane_id, "#{window_id}"]),
                    self.config.kind(),
                    TargetMissingMode::AllowAndRefresh,
                )
                .await?;
                let window_id = output.stdout.trim();
                if !super::is_tmux_window_id(window_id) {
                    self.request_snapshot();
                    return Ok(());
                }
                window_id.to_owned()
            }
        };
        let resized = checked_command(
            &self.transport,
            &resize_window_command(&window_id, cols, rows),
            self.config.kind(),
            TargetMissingMode::AllowAndRefresh,
        )
        .await;
        if resized
            .as_ref()
            .err()
            .is_none_or(|error| !is_tmux_server_gone_message(&error.to_string()))
        {
            self.request_snapshot();
        }
        resized.map(|_| ())
    }

    async fn handle_command(
        &mut self,
        command: RuntimeCommand,
        inflight: &mut JoinSet<CommandCompletion>,
    ) -> bool {
        match command {
            RuntimeCommand::SendInput {
                pane_id,
                data,
                response,
            } => {
                let result = self.send_input(&pane_id, &data).await;
                let _ = response.send(result);
            }
            RuntimeCommand::SendKey {
                pane_id,
                key,
                modifiers,
                action,
                response,
            } => {
                let result = self.send_key(&pane_id, &key, modifiers, &action).await;
                let _ = response.send(result);
            }
            RuntimeCommand::SendInputOneWay { pane_id, data } => {
                if let Err(error) = self.send_input(&pane_id, &data).await {
                    self.emit_error(error.to_string());
                }
            }
            RuntimeCommand::SendInputBatchOneWay { pane_id, chunks } => {
                for data in chunks {
                    if let Err(error) = self.send_input(&pane_id, &data).await {
                        self.emit_error(error.to_string());
                        break;
                    }
                }
            }
            RuntimeCommand::ResizePaneOneWay {
                pane_id,
                cols,
                rows,
            } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = checked_command(
                        &transport,
                        &resize_pane_command(&pane_id, Some(cols), Some(rows)),
                        kind,
                        TargetMissingMode::AllowAndRefresh,
                    )
                    .await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if server_gone.is_none() {
                            actor.request_snapshot();
                        }
                        if let Err(error) = result {
                            actor.emit_error(error.to_string());
                        }
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::SelectPane {
                window_id,
                pane_id,
                size,
                response,
            } => {
                let result = self.select_pane(&window_id, &pane_id, size).await;
                let server_gone = result
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .filter(|message| is_tmux_server_gone_message(message));
                let _ = response.send(result);
                if let Some(message) = server_gone {
                    self.notify_session_closed(&message);
                    return true;
                }
            }
            RuntimeCommand::ResizeWindowForPane {
                pane_id,
                cols,
                rows,
                response,
            } => {
                let snapshot_window = self.snapshot.as_ref().and_then(|snapshot| {
                    snapshot.session.as_ref().and_then(|session| {
                        session
                            .windows
                            .iter()
                            .find(|window| window.panes.iter().any(|pane| pane.id == pane_id))
                    })
                });
                if let Some(window) = snapshot_window {
                    let unchanged = if window.panes.len() > 1 {
                        crate::ws::parse_window_layout_size(window.layout.as_deref()).is_some_and(
                            |(current_cols, current_rows)| {
                                current_cols == cols && current_rows == rows
                            },
                        )
                    } else {
                        window.panes.iter().any(|pane| {
                            pane.id == pane_id && pane.width == cols && pane.height == rows
                        })
                    };
                    if unchanged {
                        if let Some(response) = response {
                            let _ = response.send(Ok(()));
                        }
                        return false;
                    }
                }
                let window_id = snapshot_window.map(|window| window.id.clone());
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result =
                        resize_window_via(&transport, kind, &pane_id, window_id, cols, rows).await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if response.is_none() {
                            if let Err(error) = &result {
                                actor.emit_error(error.to_string());
                            }
                        }
                        let resized = result.as_ref().is_ok_and(|resized| resized.is_some());
                        if let Some(response) = response {
                            let _ = response.send(result.map(|_| ()));
                        }
                        if resized {
                            actor.request_snapshot();
                        }
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::UpdateDefaultWorkingDir {
                default_working_dir,
            } => {
                self.config.default_working_dir = default_working_dir
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty());
                let session_name = self.config.normalized_session_name().to_owned();
                let default_working_dir = self.default_working_dir();
                let command = strings([
                    "set-option",
                    "-t",
                    &session_name,
                    "default-path",
                    &default_working_dir,
                ]);
                if let Err(error) =
                    run_allow_failure(&self.transport, &command, self.config.kind()).await
                {
                    self.emit_error(error.to_string());
                }
            }
            RuntimeCommand::SetCustomName {
                kind,
                native_id,
                name,
                response,
            } => {
                let result = self
                    .metadata
                    .set_custom_name(kind, &native_id, name)
                    .map_err(DeviceSessionRuntimeError::Metadata);
                let _ = response.send(result);
            }
            RuntimeCommand::SetWindowStyle { style, response } => {
                if super::resolve_tmux_window_style(&self.config.tmux_window_style).is_none() {
                    let _ = response.send(Ok(()));
                } else {
                    let transport = self.transport.clone();
                    let kind = self.config.kind();
                    let session = self.config.normalized_session_name().to_owned();
                    inflight.spawn(async move {
                        let result =
                            configure_window_style_via(&transport, kind, &session, &style).await;
                        Box::new(move |actor: &mut RuntimeActor| {
                            if let Err(error) = &result {
                                actor.emit_error(error.to_string());
                            }
                            let _ = response.send(result);
                            false
                        }) as CommandCompletion
                    });
                }
            }
            RuntimeCommand::CreateWindow {
                name,
                cwd,
                response,
            } => {
                let session = self.config.normalized_session_name().to_owned();
                let cwd = cwd.unwrap_or_else(|| self.default_working_dir());
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = checked_command(
                        &transport,
                        &create_window_command(
                            &session,
                            &cwd,
                            name.as_deref().filter(|name| !name.is_empty()),
                        ),
                        kind,
                        TargetMissingMode::Reject,
                    )
                    .await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if result.is_ok() {
                            actor.request_snapshot();
                        }
                        let result = result.map(|output| {
                            let window_id = output.stdout.trim();
                            super::is_tmux_window_id(window_id).then(|| window_id.to_owned())
                        });
                        let _ = response.send(result);
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::SplitPane {
                pane_id,
                direction,
                cwd,
                response,
            } => {
                let cwd = cwd.unwrap_or_else(|| self.default_working_dir());
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = checked_command(
                        &transport,
                        &super::split_pane_command(&pane_id, direction, &cwd),
                        kind,
                        TargetMissingMode::AllowAndRefresh,
                    )
                    .await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if let Ok(output) = &result {
                            if let Some((window_id, new_pane_id)) =
                                output.stdout.trim().split_once('|')
                            {
                                if super::is_tmux_window_id(window_id)
                                    && super::is_tmux_pane_id(new_pane_id)
                                {
                                    actor.emit(TmuxRuntimeEvent::PaneActivated {
                                        window_id: window_id.to_owned(),
                                        pane_id: new_pane_id.to_owned(),
                                    });
                                }
                            }
                            actor.request_snapshot();
                        }
                        let _ = response.send(result);
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::SignalTheme {
                pane_id,
                theme,
                response,
            } => {
                let result = if self.theme_subscriptions.has(&pane_id) {
                    let reply = if theme == ThemeMode::Dark {
                        b"\x1b[?997;1n".as_slice()
                    } else {
                        b"\x1b[?997;2n".as_slice()
                    };
                    self.send_input(&pane_id, reply).await
                } else {
                    Ok(())
                };
                let _ = response.send(result);
            }
            RuntimeCommand::Run {
                args,
                missing,
                refresh,
                response,
            } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = checked_command(&transport, &args, kind, missing).await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = result
                            .as_ref()
                            .err()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if refresh && server_gone.is_none() {
                            actor.request_snapshot();
                        }
                        let _ = response.send(result);
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::RunBatch {
                commands,
                refresh,
                response,
            } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let mut results = Vec::with_capacity(commands.len());
                    let mut failure = None;
                    for (args, missing) in commands {
                        match checked_command(&transport, &args, kind, missing).await {
                            Ok(result) => results.push(result),
                            Err(error) => {
                                failure = Some(error);
                                break;
                            }
                        }
                    }
                    Box::new(move |actor: &mut RuntimeActor| {
                        let server_gone = failure
                            .as_ref()
                            .map(ToString::to_string)
                            .filter(|message| is_tmux_server_gone_message(message));
                        if refresh && server_gone.is_none() {
                            actor.request_snapshot();
                        }
                        let _ = response.send(failure.map_or(Ok(results), Err));
                        if let Some(message) = server_gone {
                            actor.notify_session_closed(&message);
                            return true;
                        }
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::CloseWindow {
                window_id,
                response,
            } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                let session = self.config.normalized_session_name().to_owned();
                let cwd = self.default_working_dir();
                inflight.spawn(async move {
                    let result =
                        close_window_via(&transport, kind, &session, &cwd, &window_id).await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        if result.is_ok() {
                            actor.request_snapshot();
                        }
                        let _ = response.send(result);
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::RequestSnapshot => self.request_snapshot(),
            RuntimeCommand::CaptureText {
                pane_id,
                history_lines,
                response,
            } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let command = super::capture_pane_text_command(&pane_id, history_lines);
                    let result =
                        checked_command(&transport, &command, kind, TargetMissingMode::Reject)
                            .await
                            .map(|result| result.stdout);
                    Box::new(move |_actor: &mut RuntimeActor| {
                        let _ = response.send(result);
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::FetchTerminalHistory { pane_id, response } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = fetch_terminal_history_via(&transport, kind, &pane_id).await;
                    Box::new(move |actor: &mut RuntimeActor| {
                        if let Ok(Some(history)) = &result {
                            actor.emit(TmuxRuntimeEvent::TerminalHistory {
                                pane_id,
                                history: history.clone(),
                            });
                        }
                        let _ = response.send(result);
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::PaneInfo { pane_id, response } => {
                let transport = self.transport.clone();
                let kind = self.config.kind();
                inflight.spawn(async move {
                    let result = checked_command(
                        &transport,
                        &pane_info_command(&pane_id),
                        kind,
                        TargetMissingMode::Reject,
                    )
                    .await
                    .map(|result| parse_pane_meta(&result.stdout));
                    Box::new(move |_actor: &mut RuntimeActor| {
                        let _ = response.send(result);
                        false
                    }) as CommandCompletion
                });
            }
            RuntimeCommand::ReadHistory {
                pane_id,
                cursor,
                byte_limit,
                response,
            } => {
                let identity = self.pane_identity(&pane_id);
                let result = match identity {
                    Some(identity) => self
                        .history
                        .read_page(&pane_id, identity.pane_epoch, cursor.as_ref(), byte_limit)
                        .await
                        .map(Some)
                        .map_err(DeviceSessionRuntimeError::from),
                    None => Ok(None),
                };
                let _ = response.send(result);
            }
            RuntimeCommand::CaptureScreen {
                pane_id,
                byte_limit,
                response,
            } => {
                let result = self.capture_canonical_screen(&pane_id, byte_limit).await;
                let _ = response.send(result);
            }
            RuntimeCommand::GetSnapshot(response) => {
                let _ = response.send(self.snapshot.clone());
            }
            RuntimeCommand::GetMetadata(response) => {
                let _ = response.send(self.metadata.current_snapshot());
            }
            RuntimeCommand::GetPaneIdentity { pane_id, response } => {
                let _ = response.send(self.pane_identity(&pane_id));
            }
            RuntimeCommand::GetRetentionStats(response) => {
                let _ = response.send(self.retention.stats());
            }
            RuntimeCommand::Shutdown(response) => {
                self.manual_shutdown = true;
                self.shutdown_ack = Some(response);
                return true;
            }
            RuntimeCommand::SnapshotFinished {
                base_revision,
                result,
            } => match result {
                Ok(snapshot) => {
                    if let Err(error) = self.apply_snapshot(snapshot, base_revision) {
                        self.emit_error(error.to_string());
                    }
                    if matches!(
                        self.snapshot_refresh
                            .complete_run(SnapshotRefreshRunResult::Succeeded),
                        SnapshotRefreshAction::StartTrailing { .. }
                    ) {
                        self.spawn_snapshot(self.metadata.revision());
                    }
                }
                Err(error) => {
                    self.snapshot_refresh
                        .complete_run(SnapshotRefreshRunResult::Failed);
                    let message = error.to_string();
                    self.emit_error(message.clone());
                    if is_tmux_server_gone_message(&message) {
                        self.notify_session_closed(&message);
                        return true;
                    }
                }
            },
            #[cfg(test)]
            RuntimeCommand::InjectControlEventForTest { event } => {
                if self.handle_control_event(*event).await {
                    return true;
                }
            }
            #[cfg(test)]
            RuntimeCommand::PanicForTest => panic!("runtime actor test panic"),
        }
        false
    }

    async fn handle_control_event(&mut self, event: ControlModeSubscriptionEvent) -> bool {
        match event {
            ControlModeSubscriptionEvent::TerminalOutput { pane_id, data } => {
                if let Some(epoch) = self.metadata.ensure_pane_epoch(&pane_id) {
                    match self.retention.ingest(&pane_id, epoch, &data) {
                        Ok(Some(segment)) => {
                            let emulator =
                                self.emulators.entry(pane_id.clone()).or_insert_with(|| {
                                    PaneEmulator::new(&pane_id, HeadlessTerminalOptions::default())
                                });
                            if emulator
                                .cursor()
                                .is_none_or(|(current, _)| current != epoch)
                            {
                                emulator.begin_at(epoch, segment.seq_start);
                            }
                            if emulator.feed_segment(&segment).is_err() {
                                emulator.reset();
                                emulator.begin_at(epoch, segment.seq_start);
                                let _ = emulator.feed_segment(&segment);
                            }
                            self.emit(TmuxRuntimeEvent::Terminal(segment));
                        }
                        Ok(None) => {}
                        Err(error) => self.emit_error(error.to_string()),
                    }
                }
            }
            ControlModeSubscriptionEvent::Title { pane_id, title } => {
                match self.metadata.apply_pane_title(&pane_id, title.clone()) {
                    Ok(()) => self.canonical.sync_metadata(
                        self.metadata.server_epoch(),
                        self.metadata.current_snapshot(),
                    ),
                    Err(error) => self.emit_error(error.to_string()),
                }
                self.emit(TmuxRuntimeEvent::Title { pane_id, title });
            }
            ControlModeSubscriptionEvent::Bell { pane_id } => {
                self.emit(TmuxRuntimeEvent::Bell { pane_id });
            }
            ControlModeSubscriptionEvent::Notification {
                pane_id,
                notification,
            } => {
                self.emit(TmuxRuntimeEvent::Notification {
                    pane_id,
                    notification,
                });
            }
            ControlModeSubscriptionEvent::PromptMarker { pane_id, marker } => {
                if let Some(emulator) = self.emulators.get_mut(&pane_id) {
                    emulator.publish_prompt_marker(&marker);
                }
                self.emit(TmuxRuntimeEvent::PromptMarker { pane_id, marker });
            }
            ControlModeSubscriptionEvent::ClipboardWrite { pane_id, text } => {
                self.emit(TmuxRuntimeEvent::ClipboardWrite { pane_id, text });
            }
            ControlModeSubscriptionEvent::SourceMetadata(event) => {
                if let super::SourceMetadataEvent::LayoutChanged { layout, .. } = &event {
                    for pane in parse_layout_leaves(layout) {
                        self.sync_emulator_size(
                            &format!("%{}", pane.pane_number),
                            pane.width,
                            pane.height,
                        );
                    }
                }
                match self.metadata.apply_source_event(&event) {
                    Ok(()) => self.canonical.sync_metadata(
                        self.metadata.server_epoch(),
                        self.metadata.current_snapshot(),
                    ),
                    Err(error) => self.emit_error(error.to_string()),
                }
                self.emit(TmuxRuntimeEvent::SourceMetadata(event));
            }
            ControlModeSubscriptionEvent::StructureChanged => self.request_snapshot(),
            ControlModeSubscriptionEvent::Exit { reason } => {
                self.control = None;
                if self.manual_shutdown {
                    return true;
                }
                if let Err(error) = self
                    .reconnect_control(reason.as_deref().unwrap_or_default())
                    .await
                {
                    self.emit_error(error.to_string());
                    return true;
                }
            }
            ControlModeSubscriptionEvent::ThemeSubscription {
                pane_id,
                subscribed,
            } => {
                self.theme_subscriptions.note(&pane_id, subscribed);
                let command = strings([
                    "set-option",
                    "-p",
                    "-t",
                    &pane_id,
                    "@tmex_2031",
                    if subscribed { "on" } else { "off" },
                ]);
                let _ = run_allow_failure(&self.transport, &command, self.config.kind()).await;
            }
            ControlModeSubscriptionEvent::KeyboardSequence { pane_id, seq } => {
                let state = self.keyboard_modes.entry(pane_id.clone()).or_default();
                apply_sequence(state, seq);
                let value = encode_pane_option_value(state);
                let mut command = strings(["set-option", "-p", "-t", &pane_id, "@tmex-kbd"]);
                if value.is_empty() {
                    command.push("-u".to_owned());
                } else {
                    command.push(value);
                }
                let _ = run_allow_failure(&self.transport, &command, self.config.kind()).await;
            }
            ControlModeSubscriptionEvent::Graphics { pane_id, event } => match event {
                KittyGraphicsEvent::Reply(bytes) => {
                    if let Err(error) = self.send_input(&pane_id, &bytes).await {
                        self.emit_error(error.to_string());
                    }
                }
                KittyGraphicsEvent::Error { message, .. } => {
                    self.emit_error(format!("Kitty graphics: {message}"));
                }
                KittyGraphicsEvent::ReplayImage {
                    image_id,
                    virtual_placement,
                    data,
                } => {
                    if let Some(pane_epoch) = self.metadata.pane_epoch(&pane_id) {
                        self.kitty_screen_cache.store_image(
                            &pane_id,
                            pane_epoch,
                            image_id,
                            virtual_placement,
                            data,
                        );
                    }
                }
                KittyGraphicsEvent::ReplayPlacement {
                    image_id,
                    placement_id,
                    data,
                } => {
                    if let Some(pane_epoch) = self.metadata.pane_epoch(&pane_id) {
                        self.kitty_screen_cache.store_placement(
                            &pane_id,
                            pane_epoch,
                            image_id,
                            placement_id,
                            data,
                        );
                    }
                }
                KittyGraphicsEvent::ReplayDelete { image_id } => {
                    if let Some(pane_epoch) = self.metadata.pane_epoch(&pane_id) {
                        self.kitty_screen_cache
                            .delete(&pane_id, pane_epoch, image_id);
                    }
                }
            },
            ControlModeSubscriptionEvent::Pause { .. }
            | ControlModeSubscriptionEvent::Continue { .. }
            | ControlModeSubscriptionEvent::UnhandledBlock(_)
            | ControlModeSubscriptionEvent::Metrics(_) => {}
        }
        false
    }

    async fn reconnect_control(&mut self, reason: &str) -> Result<(), DeviceSessionRuntimeError> {
        if system_time_ms().saturating_sub(self.control_started_at_ms)
            >= CONTROL_STABLE_RESET.as_millis() as u64
        {
            self.control_restart_count = 0;
        }
        self.control_restart_count += 1;
        if self.control_restart_count > CONTROL_MAX_RESTARTS {
            return Err(DeviceSessionRuntimeError::CommandFailed {
                command: "control reconnect".to_owned(),
                detail: reason.to_owned(),
            });
        }
        self.emit(TmuxRuntimeEvent::Reconnecting {
            device_id: self.config.device_id.clone(),
            attempt: self.control_restart_count,
        });
        sleep(CONTROL_RESTART_DELAY.saturating_mul(self.control_restart_count)).await;
        let has = run_allow_failure(
            &self.transport,
            &strings(["has-session", "-t", self.config.normalized_session_name()]),
            self.config.kind(),
        )
        .await?;
        if has.exit_code != 0 {
            if let Some(event) = self.lifecycle.notify_session_closed(
                self.config.normalized_session_name(),
                if reason.is_empty() {
                    &has.stderr
                } else {
                    reason
                },
            ) {
                self.emit(TmuxRuntimeEvent::Lifecycle(event));
            }
            return Err(DeviceSessionRuntimeError::Closed);
        }
        self.start_control().await?;
        self.configure_window_style().await?;
        self.request_snapshot();
        Ok(())
    }

    fn request_snapshot(&mut self) {
        match self.snapshot_refresh.request() {
            SnapshotRefreshAction::Start { .. } => self.spawn_snapshot(self.metadata.revision()),
            SnapshotRefreshAction::Coalesced { .. }
            | SnapshotRefreshAction::StartTrailing { .. }
            | SnapshotRefreshAction::Idle { .. } => {}
        }
    }

    fn spawn_snapshot(&self, base_revision: u64) {
        let transport = self.transport.clone();
        let commands = self.commands.clone();
        let device_id = self.config.device_id.clone();
        let session_name = self.config.normalized_session_name().to_owned();
        let kind = self.config.kind();
        tokio::spawn(async move {
            let result =
                match AssertUnwindSafe(fetch_snapshot(transport, &device_id, &session_name, kind))
                    .catch_unwind()
                    .await
                {
                    Ok(result) => result,
                    Err(_) => Err(DeviceSessionRuntimeError::InvalidTmuxOutput(
                        "snapshot task panicked".to_owned(),
                    )),
                };
            if let Some(commands) = commands.upgrade() {
                let _ = commands
                    .send(RuntimeCommand::SnapshotFinished {
                        base_revision,
                        result,
                    })
                    .await;
            }
        });
    }

    fn apply_snapshot(
        &mut self,
        snapshot: StateSnapshot,
        base_revision: u64,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let snapshot_sizes_are_current = self.metadata.revision() == base_revision;
        let previous = self.snapshot.replace(snapshot.clone());
        self.metadata.reconcile(&snapshot, Some(base_revision))?;
        let panes = snapshot
            .session
            .iter()
            .flat_map(|session| &session.windows)
            .flat_map(|window| &window.panes)
            .filter_map(|pane| {
                self.metadata
                    .ensure_pane_epoch(&pane.id)
                    .map(|pane_epoch| PaneIdentity {
                        pane_id: pane.id.clone(),
                        pane_epoch,
                    })
            })
            .collect::<Vec<_>>();
        self.retention.reconcile_panes(&panes);
        self.canonical.sync_projection(
            self.metadata.server_epoch(),
            self.metadata.current_snapshot(),
            &panes,
        );
        let current = panes
            .iter()
            .map(|pane| pane.pane_id.clone())
            .collect::<HashSet<_>>();
        for pane in &panes {
            self.history
                .invalidate_pane(&pane.pane_id, Some(pane.pane_epoch));
        }
        self.emulators
            .retain(|pane_id, _| current.contains(pane_id));
        if snapshot_sizes_are_current {
            for pane in snapshot
                .session
                .iter()
                .flat_map(|session| &session.windows)
                .flat_map(|window| &window.panes)
            {
                self.sync_emulator_size(&pane.id, pane.width, pane.height);
            }
        }
        self.keyboard_modes
            .retain(|pane_id, _| current.contains(pane_id));
        self.theme_subscriptions.prune(&current);
        if let Some(previous) = previous {
            for pane_id in snapshot_pane_ids(&previous) {
                if !current.contains(&pane_id) {
                    self.history.invalidate_pane(&pane_id, None);
                    self.kitty_screen_cache.clear_pane(&pane_id);
                }
            }
            let old = snapshot_windows(&previous);
            let new = snapshot_windows(&snapshot);
            let lifecycle = self.lifecycle.snapshot_closures(
                &old,
                &new,
                true,
                self.config.normalized_session_name(),
                |kind, id| self.metadata.custom_name(kind, id).map(str::to_owned),
            );
            for event in lifecycle {
                self.emit(TmuxRuntimeEvent::Lifecycle(event));
            }
        }
        self.emit(TmuxRuntimeEvent::Snapshot(snapshot));
        self.flush_metadata();
        Ok(())
    }

    fn pane_identity(&self, pane_id: &str) -> Option<PaneIdentity> {
        let pane_epoch = self.metadata.pane_epoch(pane_id)?;
        self.metadata.has_pane(pane_id).then(|| PaneIdentity {
            pane_id: pane_id.to_owned(),
            pane_epoch,
        })
    }

    fn sync_emulator_size(&mut self, pane_id: &str, cols: u16, rows: u16) {
        let options = HeadlessTerminalOptions {
            cols: usize::from(cols.max(1)),
            rows: usize::from(rows.max(1)),
            ..HeadlessTerminalOptions::default()
        };
        self.emulators
            .entry(pane_id.to_owned())
            .and_modify(|emulator| {
                let size = emulator.size();
                if size.cols != options.cols || size.rows != options.rows {
                    emulator.resize(options.cols, options.rows);
                }
            })
            .or_insert_with(|| PaneEmulator::new(pane_id, options));
    }

    async fn capture_canonical_screen(
        &mut self,
        pane_id: &str,
        byte_limit: usize,
    ) -> Result<Option<PaneScreenCheckpoint>, DeviceSessionRuntimeError> {
        let Some(identity) = self.pane_identity(pane_id) else {
            return Ok(None);
        };
        let max_bytes = byte_limit.min(self.retention.limits().max_checkpoint_bytes_per_pane);
        if max_bytes < 64 {
            return Ok(None);
        }
        let projected = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.session.as_ref())
            .into_iter()
            .flat_map(|session| &session.windows)
            .flat_map(|window| &window.panes)
            .find(|pane| pane.id == pane_id);
        let estimated_cols = usize::from(projected.map_or(80, |pane| pane.width)).max(1);
        let estimated_rows = usize::from(projected.map_or(24, |pane| pane.height)).max(1);
        let estimated_bytes_per_line = estimated_cols.saturating_mul(4).max(16);
        let bounded_total_lines = estimated_rows
            .max((max_bytes / estimated_bytes_per_line).min(estimated_rows.saturating_add(256)));
        let history_lines = bounded_total_lines.saturating_sub(estimated_rows);
        let base_cursor = Arc::new(StdMutex::new(None::<PaneTerminalCursor>));
        let frame = if let Some(control) = &self.control {
            let cursor = base_cursor.clone();
            let retention = self.retention.clone();
            let pane = pane_id.to_owned();
            control
                .capture_pane_frame_at_barrier(pane_id, history_lines, move || {
                    *cursor
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        retention.latest_cursor(&pane);
                })
                .await?
        } else {
            let info = checked_command(
                &self.transport,
                &super::pane_screen_info_command(pane_id),
                self.config.kind(),
                TargetMissingMode::Reject,
            )
            .await?;
            let info = parse_pane_screen_info(&info.stdout);
            let text = strip_capture_command_terminator(
                checked_command(
                    &self.transport,
                    &super::capture_pane_screen_command(
                        pane_id,
                        (!info.alternate_screen).then_some(history_lines),
                    ),
                    self.config.kind(),
                    TargetMissingMode::Reject,
                )
                .await?
                .stdout,
            );
            *base_cursor
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                self.retention.latest_cursor(pane_id);
            let history_info = checked_command(
                &self.transport,
                &pane_history_info_command(pane_id),
                self.config.kind(),
                TargetMissingMode::Reject,
            )
            .await?;
            let history_size = parse_pane_history_capture_info(&history_info.stdout)
                .map_err(|error| DeviceSessionRuntimeError::InvalidTmuxOutput(error.to_string()))?
                .history_size;
            super::AtomicPaneCapture {
                text,
                history_text: None,
                cols: info.cols,
                rows: info.rows,
                cursor_x: info.cursor_x,
                cursor_y: info.cursor_y,
                alternate_screen: info.alternate_screen,
                history_size,
                modes: Some(info.modes),
                continuation: info.continuation,
            }
        };
        let base_cursor = base_cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(base_cursor) = base_cursor else {
            return Ok(None);
        };
        let prefix = if frame.alternate_screen {
            b"\x1b[?1049h\x1b[2J\x1b[H".as_slice()
        } else {
            b"\x1b[2J\x1b[H".as_slice()
        };
        let terminal_state = self.emulators.get(pane_id).and_then(|emulator| {
            emulator.continuation_state_at(base_cursor.pane_epoch, base_cursor.terminal_seq)
        });
        let captured_viewport =
            captured_viewport_terminal(&frame.text, frame.cols, frame.rows, frame.alternate_screen);
        let captured_viewport_text = captured_viewport.viewport_text();
        let exact_viewport = self.emulators.get(pane_id).and_then(|emulator| {
            let viewport = emulator.viewport_ansi_at(
                base_cursor.pane_epoch,
                base_cursor.terminal_seq,
                frame.cols,
                frame.rows,
                frame.alternate_screen,
            )?;
            (emulator.viewport_text() == captured_viewport_text).then_some(viewport)
        });
        let fallback_viewport = captured_viewport.viewport_ansi();
        let continuation = encode_terminal_continuation(
            &frame.continuation,
            frame.cols,
            frame.rows,
            frame.cursor_x,
            frame.cursor_y,
            terminal_state.as_ref(),
        );
        let base_overhead = prefix.len() + continuation.len();
        if base_overhead > max_bytes {
            return Ok(None);
        }
        let graphics_budget = max_bytes
            .saturating_sub(base_overhead)
            .saturating_sub(KITTY_SCREEN_TEXT_RESERVE_BYTES.min(max_bytes));
        let graphics =
            self.kitty_screen_cache
                .replay_prefix(pane_id, identity.pane_epoch, graphics_budget);
        let text_budget = max_bytes.saturating_sub(base_overhead + graphics.len());
        let history_bytes = if !frame.alternate_screen && frame.history_size > 0 {
            frame
                .history_text
                .as_ref()
                .map(|history| format!("{history}\n").into_bytes())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let encoded_text = encode_checkpoint_text(
            &history_bytes,
            &fallback_viewport,
            exact_viewport.as_deref(),
            text_budget,
        );
        let mut data = Vec::with_capacity(
            prefix.len() + graphics.len() + encoded_text.data.len() + continuation.len(),
        );
        data.extend_from_slice(prefix);
        data.extend_from_slice(&graphics);
        data.extend_from_slice(&encoded_text.data);
        data.extend_from_slice(&continuation);
        let Some(current_identity) = self.pane_identity(pane_id) else {
            return Ok(None);
        };
        if current_identity.pane_epoch != identity.pane_epoch
            || base_cursor.pane_epoch != current_identity.pane_epoch
        {
            return Ok(None);
        }
        let embedded_lines = if encoded_text.history_included {
            history_lines
        } else {
            0
        };
        let history_cursor = if frame.alternate_screen {
            None
        } else {
            self.history
                .create_cursor(
                    pane_id,
                    current_identity.pane_epoch,
                    if encoded_text.truncated {
                        frame.history_size
                    } else {
                        frame.history_size.saturating_sub(embedded_lines)
                    },
                )
                .map(|cursor| CanonicalHistoryCursor {
                    pane_epoch: cursor.pane_epoch,
                    history_epoch: cursor.history_epoch,
                    before_line: cursor.before_line,
                })
        };
        let checkpoint = PaneScreenCheckpoint {
            pane_id: pane_id.to_owned(),
            pane_epoch: current_identity.pane_epoch,
            base_seq: base_cursor.terminal_seq,
            rows: u16::try_from(frame.rows.max(1)).unwrap_or(u16::MAX),
            cols: u16::try_from(frame.cols.max(1)).unwrap_or(u16::MAX),
            modes: frame.modes.as_ref().map_or(
                u8::from(frame.alternate_screen) * PANE_MODE_ALT_SCREEN,
                |modes| encode_pane_modes(modes, frame.alternate_screen),
            ),
            data,
            history_cursor,
            captured_at_ms: system_time_ms(),
        };
        if !self.retention.store_screen_checkpoint(checkpoint.clone()) {
            return Ok(None);
        }
        if !encoded_text.exact_viewport_used {
            if let Some(replay) = self.retention.read_replay(pane_id, &base_cursor)? {
                let emulator = self.emulators.entry(pane_id.to_owned()).or_insert_with(|| {
                    PaneEmulator::new(pane_id, HeadlessTerminalOptions::default())
                });
                let _ = emulator.rebuild(&checkpoint, &replay);
            }
        }
        Ok(Some(checkpoint))
    }

    async fn send_input(
        &mut self,
        pane_id: &str,
        data: &[u8],
    ) -> Result<(), DeviceSessionRuntimeError> {
        for command in send_input_commands(pane_id, data) {
            if let Some(control) = &self.control {
                control
                    .execute(join_shell_args(&command), LOCAL_RUN_TIMEOUT)
                    .await?;
            } else {
                checked_command(
                    &self.transport,
                    &command,
                    self.config.kind(),
                    TargetMissingMode::Reject,
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn send_key(
        &mut self,
        pane_id: &str,
        key: &TerminalKey,
        modifiers: u16,
        action: &TerminalKeyAction,
    ) -> Result<(), DeviceSessionRuntimeError> {
        let mode = self
            .keyboard_modes
            .get(pane_id)
            .cloned()
            .unwrap_or_default();
        let bytes = encode_terminal_key(key, modifiers, action, &mode)
            .map_err(|error| DeviceSessionRuntimeError::InvalidTerminalKey(error.to_string()))?;
        self.send_input(pane_id, &bytes).await
    }

    /// gateway 重启后从 tmux pane user option 重水化键盘协议模式（唯一真源在
    /// `keyboard_modes` map，option 仅为重启恢复服务）。命令失败跳过——等价
    /// 旧网关「无键盘模式跟踪」行为。
    async fn restore_keyboard_modes(&mut self) {
        let result = run_allow_failure(
            &self.transport,
            &strings(["list-panes", "-a", "-F", "#{pane_id}|#{@tmex-kbd}"]),
            self.config.kind(),
        )
        .await;
        let Ok(result) = result else {
            return;
        };
        if result.exit_code != 0 {
            return;
        }
        self.keyboard_modes.clear();
        for line in result.stdout.lines() {
            let Some((pane_id, value)) = line.trim().split_once('|') else {
                continue;
            };
            if !super::is_tmux_pane_id(pane_id) {
                continue;
            }
            let state = parse_pane_option_value(value);
            if state.is_default() {
                continue;
            }
            self.keyboard_modes.insert(pane_id.to_owned(), state);
        }
    }

    async fn restore_theme_subscriptions(&mut self) {
        let result = run_allow_failure(
            &self.transport,
            &strings(["list-panes", "-a", "-F", "#{pane_id}|#{@tmex_2031}"]),
            self.config.kind(),
        )
        .await;
        let Ok(result) = result else {
            return;
        };
        if result.exit_code != 0 {
            return;
        }
        self.theme_subscriptions
            .restore(result.stdout.lines().filter_map(|line| {
                let (pane_id, flag) = line.trim().split_once('|')?;
                (flag == "on" && super::is_tmux_pane_id(pane_id)).then(|| pane_id.to_owned())
            }));
    }

    fn flush_metadata(&mut self) {
        match self.metadata.flush_pending() {
            Ok(Some(flush)) => {
                self.canonical.sync_metadata(
                    self.metadata.server_epoch(),
                    self.metadata.current_snapshot(),
                );
                self.emit(TmuxRuntimeEvent::Metadata(flush));
            }
            Ok(None) => self.canonical.sync_metadata(
                self.metadata.server_epoch(),
                self.metadata.current_snapshot(),
            ),
            Err(error) => self.emit_error(error.to_string()),
        }
    }

    fn default_working_dir(&self) -> String {
        self.config
            .default_working_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| self.transport.home_dir())
            .unwrap_or(".")
            .to_owned()
    }

    fn emit(&self, event: TmuxRuntimeEvent) {
        if let TmuxRuntimeEvent::Lifecycle(lifecycle) = &event {
            if let Some(sink) = &self.lifecycle_sink {
                sink.publish(self.config.device_id.clone(), lifecycle.clone());
            }
        }
        let _ = self.events.send(event);
    }

    fn emit_error(&self, message: String) {
        self.emit(TmuxRuntimeEvent::Error {
            device_id: self.config.device_id.clone(),
            message,
        });
    }

    fn notify_session_closed(&mut self, message: &str) {
        if let Some(event) = self
            .lifecycle
            .notify_session_closed(self.config.normalized_session_name(), message)
        {
            self.emit(TmuxRuntimeEvent::Lifecycle(event));
        }
    }

    async fn shutdown(&mut self) {
        self.canonical.close();
        if let Some(control) = self.control.take() {
            control.stop().await;
        }
        self.metadata.dispose();
        self.retention.dispose();
        self.history.dispose();
        self.emulators.clear();
        self.theme_subscriptions.reset();
        let _ = self.transport.close().await;
        self.emit(TmuxRuntimeEvent::Closed {
            device_id: self.config.device_id.clone(),
            manual: self.manual_shutdown,
        });
    }
}

#[derive(Clone)]
struct TransportPaneHistorySource {
    transport: Arc<dyn TmuxTransport>,
    deadline: Duration,
}

#[async_trait]
impl PaneHistorySource for TransportPaneHistorySource {
    async fn get_pane_history_capture_info(
        &self,
        pane_id: &str,
    ) -> Result<PaneHistoryCaptureInfo, PaneHistoryCursorError> {
        let result = self
            .transport
            .run_tmux(
                &pane_history_info_command(pane_id),
                self.deadline,
                64 * 1024,
            )
            .await
            .map_err(history_source_error)?;
        if result.exit_code != 0 {
            return Err(history_source_error_message(result.stderr));
        }
        parse_pane_history_capture_info(&result.stdout).map_err(|error| {
            PaneHistoryCursorError::new(
                PaneHistoryCursorErrorReason::CacheEvicted,
                error.to_string(),
            )
        })
    }

    async fn capture_pane_history_range(
        &self,
        pane_id: &str,
        start_line: i64,
        end_line: i64,
        max_output_bytes: usize,
    ) -> Result<String, PaneHistoryCursorError> {
        let result = self
            .transport
            .run_tmux(
                &capture_history_range_command(pane_id, start_line, end_line),
                self.deadline,
                max_output_bytes,
            )
            .await
            .map_err(history_source_error)?;
        if result.exit_code != 0 {
            return Err(history_source_error_message(result.stderr));
        }
        Ok(result.stdout)
    }
}

async fn fetch_snapshot(
    transport: Arc<dyn TmuxTransport>,
    device_id: &str,
    session_name: &str,
    kind: TmuxRuntimeKind,
) -> Result<StateSnapshot, DeviceSessionRuntimeError> {
    let [session, windows, panes] = snapshot_commands(session_name);
    let (session, windows, panes) = tokio::try_join!(
        checked_command(&transport, &session, kind, TargetMissingMode::Reject),
        checked_command(&transport, &windows, kind, TargetMissingMode::Reject),
        checked_command(&transport, &panes, kind, TargetMissingMode::Reject),
    )?;
    Ok(parse_state_snapshot(
        device_id,
        &session.stdout,
        &windows.stdout,
        &panes.stdout,
    ))
}

async fn checked_command(
    transport: &Arc<dyn TmuxTransport>,
    args: &[String],
    kind: TmuxRuntimeKind,
    missing: TargetMissingMode,
) -> Result<TmuxCommandResult, DeviceSessionRuntimeError> {
    let mut retries = 0;
    loop {
        let result = transport
            .run_tmux(args, command_deadline(kind), DEFAULT_COMMAND_OUTPUT_LIMIT)
            .await?;
        if result.exit_code == 0 {
            return Ok(result);
        }
        let detail = if result.stderr.trim().is_empty() {
            result.stdout.trim()
        } else {
            result.stderr.trim()
        };
        if is_no_server_running_message(detail) && retries < NO_SERVER_RUNNING_MAX_RETRIES {
            retries += 1;
            sleep(NO_SERVER_RUNNING_RETRY_DELAY).await;
            continue;
        }
        if is_target_missing_message(detail) && missing != TargetMissingMode::Reject {
            return Ok(result);
        }
        return Err(DeviceSessionRuntimeError::CommandFailed {
            command: join_shell_args(args),
            detail: detail.to_owned(),
        });
    }
}

async fn run_allow_failure(
    transport: &Arc<dyn TmuxTransport>,
    args: &[String],
    kind: TmuxRuntimeKind,
) -> Result<TmuxCommandResult, DeviceSessionRuntimeError> {
    Ok(transport
        .run_tmux(args, command_deadline(kind), DEFAULT_COMMAND_OUTPUT_LIMIT)
        .await?)
}

fn command_deadline(kind: TmuxRuntimeKind) -> Duration {
    if kind == TmuxRuntimeKind::Local {
        LOCAL_RUN_TIMEOUT
    } else {
        REMOTE_RUN_TIMEOUT
    }
}

fn snapshot_windows(snapshot: &StateSnapshot) -> BTreeMap<String, WindowWire> {
    snapshot
        .session
        .iter()
        .flat_map(|session| session.windows.iter())
        .map(|window| (window.id.clone(), window.clone()))
        .collect()
}

fn snapshot_pane_ids(snapshot: &StateSnapshot) -> Vec<String> {
    snapshot
        .session
        .iter()
        .flat_map(|session| session.windows.iter())
        .flat_map(|window| window.panes.iter())
        .map(|pane| pane.id.clone())
        .collect()
}

fn history_source_error(error: TmuxTransportError) -> PaneHistoryCursorError {
    history_source_error_message(error.to_string())
}

fn history_source_error_message(message: impl Into<String>) -> PaneHistoryCursorError {
    PaneHistoryCursorError::new(PaneHistoryCursorErrorReason::CacheEvicted, message)
}

fn system_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(str::to_owned).collect()
}

fn map_try_send_error<T>(error: mpsc::error::TrySendError<T>) -> DeviceSessionRuntimeError {
    match error {
        mpsc::error::TrySendError::Full(_) => DeviceSessionRuntimeError::Backpressure,
        mpsc::error::TrySendError::Closed(_) => DeviceSessionRuntimeError::Closed,
    }
}

fn encode_pane_modes(flags: &PaneModeFlags, alternate_screen: bool) -> u8 {
    let mut modes = PANE_MODE_FLAGS_PRESENT;
    modes |= u8::from(flags.mouse_standard);
    modes |= u8::from(flags.mouse_button) << 1;
    modes |= u8::from(flags.mouse_all) << 2;
    modes |= u8::from(flags.mouse_sgr) << 3;
    modes |= u8::from(flags.mouse_utf8) << 4;
    if alternate_screen {
        modes |= PANE_MODE_ALT_SCREEN;
    }
    modes
}

fn encode_terminal_continuation(
    modes: &PaneContinuationModes,
    cols: usize,
    rows: usize,
    cursor_x: Option<usize>,
    cursor_y: Option<usize>,
    terminal: Option<&TerminalContinuationState>,
) -> Vec<u8> {
    let mut output = String::from("\x1b[0m\x1b[?6l");
    let insert = terminal.map_or(modes.insert, |state| state.insert);
    let wrap = terminal.map_or(modes.wrap, |state| state.wrap);
    let cursor_visible = terminal.map_or(modes.cursor_visible, |state| state.cursor_visible);
    let application_cursor =
        terminal.map_or(modes.application_cursor, |state| state.application_cursor);
    let application_keypad =
        terminal.map_or(modes.application_keypad, |state| state.application_keypad);
    let origin = terminal.map_or(modes.origin, |state| state.origin);

    output.push_str(if insert { "\x1b[4h" } else { "\x1b[4l" });
    for (mode, enabled) in [(7, wrap), (25, cursor_visible), (1, application_cursor)] {
        let _ = write!(output, "\x1b[?{mode}{}", if enabled { 'h' } else { 'l' });
    }
    output.push_str(if application_keypad { "\x1b=" } else { "\x1b>" });

    let region_upper = modes.scroll_region_upper.min(rows.saturating_sub(1));
    let region_lower = modes
        .scroll_region_lower
        .max(region_upper)
        .min(rows.saturating_sub(1));
    if region_upper == 0 && region_lower.saturating_add(1) == rows {
        output.push_str("\x1b[r");
    } else {
        let _ = write!(output, "\x1b[{};{}r", region_upper + 1, region_lower + 1);
    }

    if origin {
        output.push_str("\x1b[?6h");
    }
    if let (Some(x), Some(y)) = (cursor_x, cursor_y) {
        let x = x.min(cols.saturating_sub(1));
        let y = y.min(rows.saturating_sub(1));
        let row = if origin {
            y.saturating_sub(region_upper)
                .min(region_lower.saturating_sub(region_upper))
                + 1
        } else {
            y + 1
        };
        let _ = write!(output, "\x1b[{row};{}H", x + 1);
    }
    output
        .as_bytes()
        .iter()
        .copied()
        .chain(
            terminal
                .map_or(b"\x1b[0m".as_slice(), |state| state.sgr().as_bytes())
                .iter()
                .copied(),
        )
        .collect()
}

/// `tmux capture-pane -p` 的 stdout 以命令输出行结束符收尾。该终结符不代表
/// viewport 之外的新 terminal row；snapshot 重放时若保留，会在满高屏写出最后
/// 一个 CRLF 并触发一次 scroll。只移除一个终结符，绝不 trim trailing spaces/SGR；
/// `row\n\n` 仍保留一个 LF，准确表示真实空末行。
fn strip_capture_command_terminator(mut text: String) -> String {
    if text.ends_with("\r\n") {
        text.truncate(text.len() - 2);
    } else if text.ends_with('\n') {
        text.truncate(text.len() - 1);
    }
    text
}

fn truncate_utf8_tail(value: &[u8], byte_limit: usize) -> Vec<u8> {
    let mut start = value.len().saturating_sub(byte_limit);
    while start < value.len() && (0x80..0xc0).contains(&value[start]) {
        start += 1;
    }
    value[start..].to_vec()
}

fn captured_viewport_terminal(
    text: &str,
    cols: usize,
    rows: usize,
    alternate_screen: bool,
) -> HeadlessTerminal {
    let mut terminal = HeadlessTerminal::new(HeadlessTerminalOptions {
        cols,
        rows,
        scrollback_lines: 0,
    });
    terminal.feed(if alternate_screen {
        b"\x1b[?1049h\x1b[2J\x1b[H".as_slice()
    } else {
        b"\x1b[2J\x1b[H".as_slice()
    });
    let mut normalized = Vec::with_capacity(text.len());
    let mut previous_was_cr = false;
    for &byte in text.as_bytes() {
        if byte == b'\n' && !previous_was_cr {
            normalized.push(b'\r');
        }
        normalized.push(byte);
        previous_was_cr = byte == b'\r';
    }
    terminal.feed(&normalized);
    terminal
}

struct EncodedCheckpointText {
    data: Vec<u8>,
    history_included: bool,
    truncated: bool,
    exact_viewport_used: bool,
}

const CANONICAL_VIEWPORT_PREFIX: &[u8] = b"\x1b[0m\x1b[H";
const CANONICAL_VIEWPORT_RESET: &[u8] = b"\x1b[0m";

// A canonical viewport paints every cell. When history precedes it, keeping CUP home would
// overwrite the history tail before it reaches scrollback; dropping only CUP lets one full screen
// of cells scroll the history tail out while preserving the same final viewport.
fn canonical_viewport_after_history(viewport: &[u8]) -> Option<Vec<u8>> {
    let body = viewport.strip_prefix(CANONICAL_VIEWPORT_PREFIX)?;
    let mut appended = Vec::with_capacity(CANONICAL_VIEWPORT_RESET.len() + body.len());
    appended.extend_from_slice(CANONICAL_VIEWPORT_RESET);
    appended.extend_from_slice(body);
    Some(appended)
}

fn encode_checkpoint_text(
    history: &[u8],
    fallback_viewport: &[u8],
    exact_viewport: Option<&[u8]>,
    byte_limit: usize,
) -> EncodedCheckpointText {
    let exact_viewport = exact_viewport.filter(|viewport| viewport.len() <= byte_limit);
    let exact_viewport_used = exact_viewport.is_some();
    let viewport = exact_viewport.unwrap_or(fallback_viewport);
    let appended_viewport = if history.is_empty() {
        None
    } else {
        canonical_viewport_after_history(viewport)
    };
    let history_included = appended_viewport
        .as_ref()
        .is_some_and(|appended| history.len().saturating_add(appended.len()) <= byte_limit);
    let viewport = if history_included {
        appended_viewport.as_deref().unwrap_or(viewport)
    } else {
        viewport
    };
    let viewport_size = viewport.len();
    let history_size = if history_included { history.len() } else { 0 };
    let mut data = Vec::with_capacity(history_size.saturating_add(viewport_size.min(byte_limit)));
    if history_included {
        data.extend_from_slice(history);
    }
    let truncated = viewport_size > byte_limit;
    if truncated {
        if let Some(body) = viewport
            .strip_prefix(CANONICAL_VIEWPORT_PREFIX)
            .filter(|_| CANONICAL_VIEWPORT_PREFIX.len() <= byte_limit)
        {
            data.extend_from_slice(CANONICAL_VIEWPORT_PREFIX);
            data.extend_from_slice(&truncate_utf8_tail(
                body,
                byte_limit.saturating_sub(CANONICAL_VIEWPORT_PREFIX.len()),
            ));
        } else {
            data.extend_from_slice(&truncate_utf8_tail(viewport, byte_limit));
        }
    } else {
        data.extend_from_slice(viewport);
    }
    EncodedCheckpointText {
        data,
        history_included,
        truncated,
        exact_viewport_used,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::state::{
        CanonicalFeedRuntime, CanonicalFeedRuntimeListener,
        PaneHistoryCursorErrorReason as CanonicalHistoryCursorErrorReason,
        PaneRetentionConsumerCallbacks as CanonicalRetentionCallbacks,
        PaneSubscriptionRequest as CanonicalSubscriptionRequest,
    };
    use crate::tmux::capture_history::{
        PANE_HISTORY_CAPTURE_INFO_FORMAT, PANE_META_FORMAT, PANE_SCREEN_INFO_FORMAT,
    };
    use crate::tmux::tmux_commands::SESSION_SNAPSHOT_FORMAT;
    use crate::tmux::{
        ControlClient, LocalTmuxConfig, MetadataProjectionFlush, TMEX_SERVER_EPOCH_OPTION,
    };
    use tmex_protocol::{SourceMetadataPatch, TERMINAL_KEY_MOD_CTRL, TERMINAL_KEY_MOD_SHIFT};
    use tmex_terminal::{HeadlessTerminal, KbdSequence};
    use tokio::sync::{Notify, Semaphore};
    use tokio::time::timeout;

    struct FakeTransport {
        close_gate: Option<Arc<Notify>>,
        select_gate: Option<Arc<FakeSelectGate>>,
        close_started: Arc<AtomicBool>,
        close_finished: Arc<AtomicBool>,
        commands: Arc<StdMutex<Vec<Vec<String>>>>,
        has_session_exit_code: i32,
        reject_default_path: bool,
        panic_snapshot: Option<Arc<AtomicBool>>,
        /// Some(line) 时 list-panes -s 返回该行（pane 快照注入）。
        pane_snapshot_line: Option<String>,
        /// display-message pane screen info 响应文本。
        pane_screen_info: Option<String>,
        /// capture-pane 响应文本。
        capture_text: Option<String>,
    }

    struct FakeSelectGate {
        blocked: AtomicBool,
        started: Semaphore,
        release: Semaphore,
    }

    impl Default for FakeSelectGate {
        fn default() -> Self {
            Self {
                blocked: AtomicBool::new(false),
                started: Semaphore::new(0),
                release: Semaphore::new(0),
            }
        }
    }

    #[async_trait]
    impl TmuxTransport for FakeTransport {
        async fn run_tmux(
            &self,
            args: &[String],
            _deadline: Duration,
            _output_limit: usize,
        ) -> Result<TmuxCommandResult, TmuxTransportError> {
            self.commands.lock().unwrap().push(args.to_vec());
            if args.first().map(String::as_str) == Some("list-windows")
                && self
                    .panic_snapshot
                    .as_ref()
                    .is_some_and(|flag| flag.swap(false, Ordering::AcqRel))
            {
                panic!("snapshot transport test panic");
            }
            if args.first().map(String::as_str) == Some("select-window") {
                if let Some(gate) = &self.select_gate {
                    if !gate.blocked.swap(true, Ordering::AcqRel) {
                        gate.started.add_permits(1);
                        gate.release.acquire().await.unwrap().forget();
                    }
                }
            }
            let stdout = if args == ["-V"] {
                "tmux 3.4\n"
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some(SESSION_SNAPSHOT_FORMAT)
            {
                "$0|tmex-runtime-lifecycle-test\n"
            } else if args.first().map(String::as_str) == Some("list-windows") {
                "@1|0|1|layout|term\n"
            } else if args.first().map(String::as_str) == Some("show-options")
                && args.last().map(String::as_str) == Some(TMEX_SERVER_EPOCH_OPTION)
            {
                "00000000000000000000000000000000\n"
            } else if args.first().map(String::as_str) == Some("list-panes") {
                self.pane_snapshot_line.as_deref().unwrap_or("")
            } else if args.first().map(String::as_str) == Some("capture-pane") {
                self.capture_text.as_deref().unwrap_or("")
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some(PANE_META_FORMAT)
            {
                "80 24 0 0 0 bash\n"
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some(PANE_SCREEN_INFO_FORMAT)
            {
                self.pane_screen_info
                    .as_deref()
                    .unwrap_or("80|24|0|0|0|0|0|0|0|0|0|0|23|0|0|1|1|0|0\n")
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some(PANE_HISTORY_CAPTURE_INFO_FORMAT)
            {
                "0|80\n"
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some("#{session_windows}")
            {
                "1\n"
            } else if args
                == [
                    "display-message",
                    "-p",
                    "-t",
                    "%legacy-window-resize",
                    "#{window_id}",
                ]
            {
                "@9\n"
            } else {
                ""
            };
            let rejects_default_path =
                self.reject_default_path && args.iter().any(|arg| arg == "default-path");
            let exit_code = if args.first().map(String::as_str) == Some("has-session") {
                self.has_session_exit_code
            } else if rejects_default_path {
                1
            } else {
                0
            };
            Ok(TmuxCommandResult {
                exit_code,
                stdout: stdout.to_owned(),
                stderr: if rejects_default_path {
                    "invalid option: default-path".to_owned()
                } else {
                    String::new()
                },
            })
        }

        async fn open_control(
            &self,
            _session_name: &str,
        ) -> Result<ControlClient, TmuxTransportError> {
            Err(TmuxTransportError::Closed)
        }

        fn home_dir(&self) -> Option<&str> {
            Some("/tmp")
        }

        fn tmux_bin(&self) -> &str {
            "unused"
        }

        async fn close(&self) -> Result<(), TmuxTransportError> {
            self.close_started.store(true, Ordering::Release);
            if let Some(gate) = &self.close_gate {
                gate.notified().await;
            }
            self.close_finished.store(true, Ordering::Release);
            Ok(())
        }
    }

    struct FakeTransportFactory {
        transport: Arc<FakeTransport>,
    }

    type FakeFactory = (
        Arc<dyn TmuxTransportFactory>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
    );
    type RecordingFakeFactory = (
        Arc<dyn TmuxTransportFactory>,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        Arc<StdMutex<Vec<Vec<String>>>>,
    );

    #[async_trait]
    impl TmuxTransportFactory for FakeTransportFactory {
        async fn create(
            &self,
            _config: &DeviceSessionConfig,
        ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError> {
            Ok(self.transport.clone())
        }
    }

    fn runtime_config() -> DeviceSessionConfig {
        DeviceSessionConfig {
            device_id: "unit-device".to_owned(),
            device_name: None,
            session_name: "tmex-runtime-lifecycle-test".to_owned(),
            default_working_dir: Some("/tmp".to_owned()),
            tmux_term_program: "off".to_owned(),
            tmux_window_style: String::new(),
            allow_passthrough: false,
            enable_control_mode: false,
            transport: TmuxTransportConfig::Local(LocalTmuxConfig {
                tmux_bin: "unused".to_owned(),
                socket_name: Some("tmex-runtime-lifecycle-test".to_owned()),
                environment: BTreeMap::new(),
            }),
            spawn_policy: Arc::new(StandaloneSpawnPolicy),
        }
    }

    fn fake_factory(close_gate: Option<Arc<Notify>>) -> FakeFactory {
        let (factory, close_started, close_finished, _) = recording_fake_factory(close_gate);
        (factory, close_started, close_finished)
    }

    fn recording_fake_factory(close_gate: Option<Arc<Notify>>) -> RecordingFakeFactory {
        recording_fake_factory_with_session(close_gate, true)
    }

    fn recording_fake_factory_with_session(
        close_gate: Option<Arc<Notify>>,
        session_exists: bool,
    ) -> RecordingFakeFactory {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate,
            select_gate: None,
            close_started: close_started.clone(),
            close_finished: close_finished.clone(),
            commands: commands.clone(),
            has_session_exit_code: i32::from(!session_exists),
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: None,
            pane_screen_info: None,
            capture_text: None,
        });
        (
            Arc::new(FakeTransportFactory { transport }),
            close_started,
            close_finished,
            commands,
        )
    }

    async fn wait_for(flag: &AtomicBool) {
        wait_until(|| flag.load(Ordering::Acquire)).await;
    }

    async fn wait_until(predicate: impl Fn() -> bool) {
        timeout(Duration::from_secs(1), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn keyboard_sequences_update_state_and_persist_option() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::PushKittyFlags(7),
            })
            .await;
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::ModifyOtherKeys(2),
            })
            .await;
        wait_until(|| {
            commands
                .lock()
                .unwrap()
                .iter()
                .any(|args| args.last().map(String::as_str) == Some("k=7;m=2"))
        })
        .await;

        // 归零序列把 option 清成 unset
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::PopKittyFlags(9),
            })
            .await;
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::ModifyOtherKeys(0),
            })
            .await;
        wait_until(|| {
            let commands = commands.lock().unwrap();
            let set = commands
                .iter()
                .filter(|args| args.contains(&"@tmex-kbd".to_owned()))
                .collect::<Vec<_>>();
            set.len() >= 4
                && set
                    .last()
                    .map(|args| args.contains(&"-u".to_owned()))
                    .unwrap_or(false)
        })
        .await;

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn kitty_graphics_reply_is_injected_into_the_source_pane() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let reply = b"\x1b_Gi=31;OK\x1b\\".to_vec();

        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::Graphics {
                pane_id: "%1".to_owned(),
                event: KittyGraphicsEvent::Reply(reply.clone()),
            })
            .await;
        let expected = send_input_commands("%1", &reply);
        wait_until(|| {
            let commands = commands.lock().unwrap();
            expected.iter().all(|command| commands.contains(command))
        })
        .await;

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn semantic_key_input_routes_through_the_runtime_actor() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::PushKittyFlags(7),
            })
            .await;
        runtime
            .send_key_input(
                "%1",
                TerminalKey::Enter,
                TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
                TerminalKeyAction::Press,
            )
            .await
            .unwrap();

        assert!(commands.lock().unwrap().contains(&vec![
            "send-keys".to_owned(),
            "-H".to_owned(),
            "-t".to_owned(),
            "%1".to_owned(),
            "1b".to_owned(),
            "5b".to_owned(),
            "31".to_owned(),
            "33".to_owned(),
            "3b".to_owned(),
            "36".to_owned(),
            "75".to_owned(),
        ]));
        runtime.shutdown().await;
    }

    #[test]
    fn capture_command_terminator_strips_exactly_one_line_ending() {
        assert_eq!(strip_capture_command_terminator("row\n".to_owned()), "row");
        assert_eq!(
            strip_capture_command_terminator("row\r\n".to_owned()),
            "row"
        );
        assert_eq!(
            strip_capture_command_terminator("row\n\n".to_owned()),
            "row\n",
            "真实空末行必须保留"
        );
        assert_eq!(
            strip_capture_command_terminator("row  \x1b[0m\n".to_owned()),
            "row  \x1b[0m",
            "尾随空格与 SGR 不得 trim"
        );
        assert_eq!(strip_capture_command_terminator("row".to_owned()), "row");
    }

    #[test]
    fn continuation_restores_partial_region_modes_cursor_and_neutral_sgr() {
        let modes = PaneContinuationModes {
            scroll_region_upper: 2,
            scroll_region_lower: 8,
            origin: true,
            insert: true,
            wrap: false,
            cursor_visible: false,
            application_cursor: true,
            application_keypad: true,
        };
        let encoded = encode_terminal_continuation(&modes, 20, 10, Some(6), Some(4), None);

        assert_eq!(
            encoded,
            b"\x1b[0m\x1b[?6l\x1b[4h\x1b[?7l\x1b[?25l\x1b[?1h\x1b=\x1b[3;9r\x1b[?6h\x1b[3;7H\x1b[0m"
        );
    }

    #[test]
    fn exact_emulator_modes_override_mux_format_placeholders() {
        let mut terminal = HeadlessTerminal::default();
        terminal.feed(b"\x1b[4h\x1b[?7l\x1b[?25h\x1b[?1h\x1b=");
        let state = terminal.continuation_state();
        let placeholder_modes = PaneContinuationModes {
            scroll_region_upper: 0,
            scroll_region_lower: 23,
            origin: false,
            insert: false,
            wrap: true,
            cursor_visible: false,
            application_cursor: false,
            application_keypad: false,
        };

        let encoded = encode_terminal_continuation(
            &placeholder_modes,
            80,
            24,
            Some(0),
            Some(0),
            Some(&state),
        );
        let encoded = String::from_utf8(encoded).expect("escape stream is UTF-8");

        assert!(encoded.contains("\x1b[4h"));
        assert!(encoded.contains("\x1b[?7l"));
        assert!(encoded.contains("\x1b[?25h"));
        assert!(encoded.contains("\x1b[?1h"));
        assert!(encoded.contains("\x1b="));
    }

    #[test]
    fn checkpoint_text_streams_a_canonical_viewport_after_history() {
        let history = b"old\r\n";
        let viewport = captured_viewport_terminal("visible", 8, 3, false).viewport_ansi();
        let appended = canonical_viewport_after_history(&viewport).unwrap();
        let encoded = encode_checkpoint_text(history, &viewport, None, 1024);

        assert_eq!(encoded.data, [history.as_slice(), &appended].concat());
        assert!(encoded.history_included);
        assert!(!encoded.truncated);
        assert!(!encoded.exact_viewport_used);
    }

    #[test]
    fn checkpoint_fallback_preserves_history_and_isolates_viewport_cells() {
        let history = b"old-a\r\nold-b\r\nold-c\r\n";
        let captured = "\x1b[48;2;15;18;22m\x1b[2K\n\n\x1b[49mnew";
        let viewport = captured_viewport_terminal(captured, 8, 3, false).viewport_ansi();
        let encoded = encode_checkpoint_text(history, &viewport, None, 1024);
        let options = HeadlessTerminalOptions {
            cols: 8,
            rows: 3,
            scrollback_lines: 32,
        };
        let mut previous = HeadlessTerminal::new(options);
        previous.feed(b"\x1b[2J\x1b[H");
        previous.feed(history);
        previous.feed(b"\x1b[0m");
        previous.feed(captured.replace('\n', "\r\n").as_bytes());

        let mut terminal = HeadlessTerminal::new(options);
        terminal.feed(b"\x1b[2J\x1b[H");
        terminal.feed(&encoded.data);

        assert_ne!(previous.viewport_ansi(), viewport);
        assert_eq!(terminal.viewport_ansi(), viewport);
        assert_eq!(terminal.history_lines(), previous.history_lines());
    }

    #[test]
    fn checkpoint_text_does_not_emit_a_partial_fallback_boundary_when_truncated() {
        let viewport = b"\x1b[0m\x1b[Habcdef";
        let encoded = encode_checkpoint_text(&[], viewport, None, 9);

        assert_eq!(encoded.data, b"\x1b[0m\x1b[Hef");
        assert!(encoded.truncated);
    }

    #[tokio::test]
    async fn keyboard_modes_stay_server_side_and_do_not_pollute_snapshots() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands,
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: Some(
                // %1 | @1 | 0 | 1 | 80 | 24 | 0 | 0 | 1 | title | bash | /tmp
                "%1|@1|0|1|80|24|0|0|1|term|bash|/tmp".to_owned(),
            ),
            pane_screen_info: None,
            capture_text: Some("hello\n".to_owned()),
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let snapshot = runtime.current_snapshot().await.unwrap().expect("snapshot");
        assert!(
            snapshot
                .session
                .map(|session| !session.windows.is_empty())
                .unwrap_or(false),
            "fake pane snapshot must be projected"
        );

        // 屏幕快照只携带可见终端状态，不再给客户端镜像输入协议模式。
        let plain = runtime
            .capture_canonical_screen("%1", 4096)
            .await
            .unwrap()
            .expect("plain capture");
        let mut plain_terminal = HeadlessTerminal::default();
        plain_terminal.feed(&plain.data);
        assert_eq!(plain_terminal.viewport_text(), "hello");
        assert!(plain.data.ends_with(
            b"\x1b[0m\x1b[?6l\x1b[4l\x1b[?7h\x1b[?25h\x1b[?1l\x1b>\x1b[r\x1b[1;1H\x1b[0m"
        ));
        // Codex 形态：Gateway 仍跟踪 kitty/MoK，供服务端 semantic encoder 使用。
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::PushKittyFlags(7),
            })
            .await;
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::KeyboardSequence {
                pane_id: "%1".to_owned(),
                seq: KbdSequence::ModifyOtherKeys(2),
            })
            .await;
        let codex = runtime
            .capture_canonical_screen("%1", 4096)
            .await
            .unwrap()
            .expect("codex capture");
        let snapshot_state = |data: &[u8]| {
            let mut terminal = HeadlessTerminal::default();
            terminal.feed(data);
            (terminal.viewport_ansi(), terminal.continuation_state())
        };
        assert_eq!(
            snapshot_state(&codex.data),
            snapshot_state(&plain.data),
            "keyboard protocol modes must stay in the Gateway encoder state"
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_screen_uses_exact_emulator_cells_when_tmux_text_loses_backgrounds() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands,
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: Some("%1|@1|0|1|40|12|0|0|1|term|bash|/tmp".to_owned()),
            pane_screen_info: Some("40|12|0|0|0|0|0|0|0|0|0|0|11|0|0|1|1|0|0\n".to_owned()),
            capture_text: Some(String::new()),
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::TerminalOutput {
                pane_id: "%1".to_owned(),
                data: b"\x1b[H\x1b[48;5;240m\x1b[2K\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[0m"
                    .to_vec(),
            })
            .await;

        let checkpoint = runtime
            .capture_canonical_screen("%1", 64 * 1024)
            .await
            .unwrap()
            .expect("canonical screen");
        let data = String::from_utf8(checkpoint.data).expect("ANSI snapshot is UTF-8");
        assert!(data.contains("\x1b[0;48;5;240m"));

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_screen_prefixes_cached_virtual_kitty_image_and_honors_delete() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands,
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: Some("%1|@1|0|1|40|12|0|0|1|term|bash|/tmp".to_owned()),
            pane_screen_info: Some("40|12|0|0|0|0|0|0|0|0|0|0|11|0|0|1|1|0|0\n".to_owned()),
            capture_text: Some("visible".to_owned()),
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let replay = b"\x1b_Ga=T,q=2,f=32,U=1,s=1,v=1,c=1,r=1,i=7;/wAA/w==\x1b\\".to_vec();
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::Graphics {
                pane_id: "%1".to_owned(),
                event: KittyGraphicsEvent::ReplayImage {
                    image_id: 7,
                    virtual_placement: true,
                    data: replay.clone(),
                },
            })
            .await;

        let checkpoint = runtime
            .capture_canonical_screen("%1", 6 * 1024 * 1024)
            .await
            .unwrap()
            .expect("canonical screen with graphics");
        let replay_at = checkpoint
            .data
            .windows(replay.len())
            .position(|window| window == replay)
            .expect("cached Kitty replay prefix");
        let text_at = checkpoint
            .data
            .windows(b"visible".len())
            .position(|window| window == b"visible")
            .expect("captured terminal text");
        assert!(replay_at < text_at);

        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::Graphics {
                pane_id: "%1".to_owned(),
                event: KittyGraphicsEvent::ReplayDelete { image_id: Some(7) },
            })
            .await;
        let deleted = runtime
            .capture_canonical_screen("%1", 6 * 1024 * 1024)
            .await
            .unwrap()
            .expect("canonical screen after graphics delete");
        assert!(!deleted
            .data
            .windows(replay.len())
            .any(|window| window == replay));

        let image = b"\x1b_Ga=t,q=2,f=32,s=1,v=1,i=8;/wAA/w==\x1b\\".to_vec();
        let placement = b"\x1b_Ga=p,q=2,U=1,i=8,p=4,c=1,r=1,C=1;\x1b\\".to_vec();
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::Graphics {
                pane_id: "%1".to_owned(),
                event: KittyGraphicsEvent::ReplayImage {
                    image_id: 8,
                    virtual_placement: false,
                    data: image.clone(),
                },
            })
            .await;
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::Graphics {
                pane_id: "%1".to_owned(),
                event: KittyGraphicsEvent::ReplayPlacement {
                    image_id: 8,
                    placement_id: 4,
                    data: placement.clone(),
                },
            })
            .await;
        let separated = runtime
            .capture_canonical_screen("%1", 6 * 1024 * 1024)
            .await
            .unwrap()
            .expect("canonical screen with separate virtual placement");
        let image_at = separated
            .data
            .windows(image.len())
            .position(|window| window == image)
            .expect("cached image transmission");
        let placement_at = separated
            .data
            .windows(placement.len())
            .position(|window| window == placement)
            .expect("cached virtual placement");
        assert!(image_at < placement_at);

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_screen_resizes_the_emulator_before_post_layout_output() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands,
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: Some("%1|@1|0|1|80|24|0|0|1|term|bash|/tmp".to_owned()),
            pane_screen_info: Some("40|12|0|0|0|0|0|0|0|0|0|0|11|0|0|1|1|0|0\n".to_owned()),
            capture_text: Some("visible".to_owned()),
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::SourceMetadata(
                super::super::SourceMetadataEvent::LayoutChanged {
                    window_id: "@1".to_owned(),
                    layout: "0000,40x12,0,0,1".to_owned(),
                },
            ))
            .await;
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::TerminalOutput {
                pane_id: "%1".to_owned(),
                data: b"\x1b[2J\x1b[Hvisible\x1b[2;1H\x1b[48;5;240m\x1b[2K\x1b[0m".to_vec(),
            })
            .await;

        let checkpoint = runtime
            .capture_canonical_screen("%1", 64 * 1024)
            .await
            .unwrap()
            .expect("canonical screen");
        let data = String::from_utf8(checkpoint.data).expect("ANSI snapshot is UTF-8");
        assert!(data.contains("\x1b[0;48;5;240m"));

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_screen_rejects_an_incomplete_emulator_viewport() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands,
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: Some("%1|@1|0|1|80|24|0|0|1|term|bash|/tmp".to_owned()),
            pane_screen_info: None,
            capture_text: Some("existing\n".to_owned()),
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        runtime
            .inject_control_event_for_test(ControlModeSubscriptionEvent::TerminalOutput {
                pane_id: "%1".to_owned(),
                data: b"new".to_vec(),
            })
            .await;

        let checkpoint = runtime
            .capture_canonical_screen("%1", 64 * 1024)
            .await
            .unwrap()
            .expect("canonical screen");
        let data = String::from_utf8(checkpoint.data).expect("ANSI snapshot is UTF-8");
        assert!(data.contains("existing"));
        assert!(!data.contains("new"));

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn unsupported_best_effort_session_option_does_not_abort_startup() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started,
            close_finished,
            commands: commands.clone(),
            has_session_exit_code: 0,
            reject_default_path: true,
            panic_snapshot: None,
            pane_snapshot_line: None,
            pane_screen_info: None,
            capture_text: None,
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });

        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        assert!(commands
            .lock()
            .unwrap()
            .iter()
            .any(|args| args.iter().any(|arg| arg == "default-path")));

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn actor_panic_marks_the_runtime_closed_and_emits_terminal_events() {
        let (factory, _close_started, _close_finished) = fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let mut events = runtime.subscribe();

        runtime.panic_actor_for_test().await;
        wait_until(|| runtime.is_terminated()).await;
        assert!(runtime.canonical.is_closed());

        let (saw_error, saw_closed) = timeout(Duration::from_secs(1), async {
            let mut saw_error = false;
            let mut saw_closed = false;
            while !saw_error || !saw_closed {
                match events.recv().await.unwrap() {
                    TmuxRuntimeEvent::Error { message, .. } => {
                        saw_error |= message == "device session runtime task panicked";
                    }
                    TmuxRuntimeEvent::Closed { manual, .. } => saw_closed |= !manual,
                    _ => {}
                }
            }
            (saw_error, saw_closed)
        })
        .await
        .expect("panic terminal events");
        assert!(saw_error && saw_closed);
    }

    #[tokio::test]
    async fn snapshot_panic_completes_the_cycle_and_allows_a_later_refresh() {
        let panic_snapshot = Arc::new(AtomicBool::new(false));
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: None,
            close_started: Arc::new(AtomicBool::new(false)),
            close_finished: Arc::new(AtomicBool::new(false)),
            commands: Arc::new(StdMutex::new(Vec::new())),
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: Some(panic_snapshot.clone()),
            pane_snapshot_line: None,
            pane_screen_info: None,
            capture_text: None,
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        timeout(Duration::from_secs(1), async {
            while runtime.current_snapshot().await.unwrap().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("initial snapshot");
        let mut events = runtime.subscribe();

        panic_snapshot.store(true, Ordering::Release);
        runtime.request_snapshot().unwrap();
        timeout(Duration::from_secs(1), async {
            loop {
                if let TmuxRuntimeEvent::Error { message, .. } = events.recv().await.unwrap() {
                    if message == "snapshot task panicked" {
                        break;
                    }
                }
            }
        })
        .await
        .expect("snapshot panic becomes an error completion");

        runtime.request_snapshot().unwrap();
        timeout(Duration::from_secs(1), async {
            loop {
                if matches!(events.recv().await.unwrap(), TmuxRuntimeEvent::Snapshot(_)) {
                    break;
                }
            }
        })
        .await
        .expect("later snapshot refresh succeeds");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn legacy_pane_resize_targets_the_owning_window() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        runtime
            .resize_window_for_pane("%legacy-window-resize", 80, 24)
            .await
            .unwrap();
        runtime
            .resize_pane("%explicit-pane-resize", Some(70), Some(20))
            .await
            .unwrap();

        {
            let commands = commands.lock().unwrap();
            assert!(commands.iter().any(|args| {
                args == &strings(["resize-window", "-t", "@9", "-x", "80", "-y", "24"])
            }));
            assert!(commands.iter().any(|args| {
                args == &strings([
                    "resize-pane",
                    "-t",
                    "%explicit-pane-resize",
                    "-x",
                    "70",
                    "-y",
                    "20",
                ])
            }));
            assert!(!commands.iter().any(|args| {
                args.first().map(String::as_str) == Some("resize-pane")
                    && args.iter().any(|arg| arg == "%legacy-window-resize")
            }));
        }

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_resize_pane_targets_the_owning_window() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let canonical = super::super::DeviceCanonicalRuntime::new(runtime.clone()).unwrap();

        CanonicalFeedRuntime::resize_pane(&canonical, "%legacy-window-resize", 137, 41)
            .await
            .unwrap();

        {
            let commands = commands.lock().unwrap();
            assert!(commands.iter().any(|args| {
                args == &strings(["resize-window", "-t", "@9", "-x", "137", "-y", "41"])
            }));
            assert!(!commands.iter().any(|args| {
                args.first().map(String::as_str) == Some("resize-pane")
                    && args.iter().any(|arg| arg == "%legacy-window-resize")
            }));
        }

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn legacy_select_and_sync_resize_stay_fifo_when_the_runtime_queue_is_full() {
        let close_started = Arc::new(AtomicBool::new(false));
        let close_finished = Arc::new(AtomicBool::new(false));
        let commands = Arc::new(StdMutex::new(Vec::new()));
        let select_gate = Arc::new(FakeSelectGate::default());
        let transport = Arc::new(FakeTransport {
            close_gate: None,
            select_gate: Some(select_gate.clone()),
            close_started,
            close_finished,
            commands: commands.clone(),
            has_session_exit_code: 0,
            reject_default_path: false,
            panic_snapshot: None,
            pane_snapshot_line: None,
            pane_screen_info: None,
            capture_text: None,
        });
        let factory: Arc<dyn TmuxTransportFactory> = Arc::new(FakeTransportFactory { transport });
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        let select = runtime
            .enqueue_select_pane("@9", "%legacy-window-resize", Some((60, 18)))
            .await
            .unwrap();
        select_gate.started.acquire().await.unwrap().forget();
        for _ in 0..RUNTIME_COMMAND_QUEUE_CAPACITY {
            runtime.enqueue_input_bytes("%queue", b"x").await.unwrap();
        }
        let sync = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .enqueue_resize_window_for_pane("%legacy-window-resize", 112, 35)
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert!(!sync.is_finished());

        select_gate.release.add_permits(1);
        select.wait().await.unwrap();
        timeout(Duration::from_secs(3), sync)
            .await
            .expect("sync resize accepted after queue capacity returns")
            .unwrap()
            .unwrap();
        wait_until(|| {
            commands
                .lock()
                .unwrap()
                .iter()
                .filter(|args| args.first().map(String::as_str) == Some("resize-window"))
                .count()
                == 2
        })
        .await;

        let resize_commands = commands
            .lock()
            .unwrap()
            .iter()
            .filter(|args| args.first().map(String::as_str) == Some("resize-window"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            resize_commands,
            [
                strings(["resize-window", "-t", "@9", "-x", "60", "-y", "18"]),
                strings(["resize-window", "-t", "@9", "-x", "112", "-y", "35"]),
            ]
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn dropping_every_handle_closes_the_actor_and_transport() {
        let (factory, _close_started, close_finished) = fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let terminated = runtime.terminated.clone();

        drop(runtime);

        wait_for(&terminated).await;
        assert!(close_finished.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn startup_session_created_reaches_host_sink_before_start_returns() {
        let (factory, _close_started, _close_finished, _) =
            recording_fake_factory_with_session(None, false);
        let delivered = Arc::new(StdMutex::new(Vec::new()));
        let delivered_for_sink = delivered.clone();
        let sink: Arc<dyn TmuxLifecycleSink> = Arc::new(
            move |device_id: String, event: super::super::LifecycleEvent| {
                delivered_for_sink.lock().unwrap().push((device_id, event));
            },
        );

        let runtime =
            DeviceSessionRuntime::start_with_lifecycle_sink(runtime_config(), factory, Some(sink))
                .await
                .unwrap();

        {
            let delivered = delivered.lock().unwrap();
            assert_eq!(delivered.len(), 1);
            assert_eq!(delivered[0].0, "unit-device");
            assert_eq!(
                delivered[0].1.kind,
                super::super::LifecycleEventKind::SessionCreated
            );
            assert_eq!(
                delivered[0].1.tmux.session_name.as_deref(),
                Some("tmex-runtime-lifecycle-test")
            );
        }
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_ack_waits_for_transport_close_and_terminated_state() {
        let close_gate = Arc::new(Notify::new());
        let (factory, close_started, close_finished) = fake_factory(Some(close_gate.clone()));
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let terminated = runtime.terminated.clone();
        let mut shutdown = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.shutdown().await }
        });

        wait_for(&close_started).await;
        assert!(timeout(Duration::from_millis(25), &mut shutdown)
            .await
            .is_err());
        assert!(!terminated.load(Ordering::Acquire));
        close_gate.notify_waiters();
        timeout(Duration::from_secs(1), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert!(close_finished.load(Ordering::Acquire));
        assert!(terminated.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn canonical_adapter_shares_actor_retention_and_initial_projection() {
        let (factory, _close_started, _close_finished) = fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let canonical = super::super::DeviceCanonicalRuntime::new(runtime.clone()).unwrap();
        assert_eq!(canonical.get_server_epoch(), Some([0; 16]));
        assert_eq!(canonical.get_metadata_snapshot().revision, 1);

        let pane = PaneIdentity {
            pane_id: "%7".to_owned(),
            pane_epoch: [0x22; 16],
        };
        let metadata = runtime.metadata_snapshot().await.unwrap();
        runtime.canonical.sync_projection(
            canonical.get_server_epoch(),
            metadata,
            std::slice::from_ref(&pane),
        );
        runtime
            .canonical
            .retention()
            .reconcile_panes(std::slice::from_ref(&pane));
        assert_eq!(
            canonical.get_pane_identity("%7").unwrap().pane_epoch,
            pane.pane_epoch
        );

        let delivered = Arc::new(StdMutex::new(Vec::<Vec<u8>>::new()));
        let delivered_for_callback = delivered.clone();
        let mut lease = canonical
            .attach_pane_consumer(CanonicalRetentionCallbacks {
                on_data: Arc::new(move |segment| {
                    delivered_for_callback.lock().unwrap().push(segment.data);
                }),
                on_gap: Arc::new(|_| {}),
            })
            .unwrap();
        lease
            .apply_subscriptions(
                1,
                &[CanonicalSubscriptionRequest {
                    pane_id: pane.pane_id.clone(),
                    pane_epoch: pane.pane_epoch,
                    cursor: None,
                }],
                &[],
            )
            .unwrap();
        runtime
            .canonical
            .retention()
            .ingest(&pane.pane_id, pane.pane_epoch, b"shared")
            .unwrap();
        assert_eq!(&*delivered.lock().unwrap(), &[b"shared".to_vec()]);

        runtime.shutdown().await;
        assert!(canonical
            .attach_pane_consumer(CanonicalRetentionCallbacks {
                on_data: Arc::new(|_| {}),
                on_gap: Arc::new(|_| {}),
            })
            .is_err());
    }

    #[tokio::test]
    async fn canonical_adapter_projects_metadata_lag_close_and_detach() {
        let (factory, _close_started, _close_finished) = fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let canonical = super::super::DeviceCanonicalRuntime::new(runtime.clone()).unwrap();
        let initial = canonical.get_metadata_snapshot();
        let patches = Arc::new(StdMutex::new(Vec::<SourceMetadataPatch>::new()));
        let rebases = Arc::new(StdMutex::new(Vec::<u64>::new()));
        let closes = Arc::new(AtomicUsize::new(0));
        let detach = canonical
            .subscribe(CanonicalFeedRuntimeListener {
                on_metadata_patch: {
                    let patches = patches.clone();
                    Arc::new(move |patch| patches.lock().unwrap().push(patch))
                },
                on_metadata_rebase_required: {
                    let rebases = rebases.clone();
                    Arc::new(move |snapshot| rebases.lock().unwrap().push(snapshot.revision))
                },
                on_close: {
                    let closes = closes.clone();
                    Arc::new(move || {
                        closes.fetch_add(1, Ordering::AcqRel);
                    })
                },
            })
            .unwrap();

        let patch = SourceMetadataPatch {
            metadata_epoch: initial.metadata_epoch,
            from_revision: initial.revision,
            through_revision: initial.revision + 1,
            upserts: Vec::new(),
            removals: Vec::new(),
        };
        let rebase = MetadataProjectionSnapshot {
            metadata_epoch: [0x44; 16],
            revision: 12,
            records: Vec::new(),
        };
        runtime
            .events
            .send(TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Patch(
                patch.clone(),
            )))
            .unwrap();
        runtime
            .events
            .send(TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Rebase(
                rebase,
            )))
            .unwrap();
        wait_until(|| patches.lock().unwrap().len() == 1 && rebases.lock().unwrap().len() == 1)
            .await;
        assert_eq!(
            patches.lock().unwrap().as_slice(),
            std::slice::from_ref(&patch)
        );
        assert_eq!(rebases.lock().unwrap().as_slice(), &[12]);

        runtime.canonical.sync_metadata(
            canonical.get_server_epoch(),
            MetadataProjectionSnapshot {
                metadata_epoch: [0x55; 16],
                revision: 77,
                records: Vec::new(),
            },
        );
        for index in 0..=RUNTIME_EVENT_QUEUE_CAPACITY {
            runtime
                .events
                .send(TmuxRuntimeEvent::Error {
                    device_id: "unit-device".to_owned(),
                    message: index.to_string(),
                })
                .unwrap();
        }
        wait_until(|| rebases.lock().unwrap().contains(&77)).await;

        let detached_patches = Arc::new(AtomicUsize::new(0));
        let detached = canonical
            .subscribe(CanonicalFeedRuntimeListener {
                on_metadata_patch: {
                    let count = detached_patches.clone();
                    Arc::new(move |_| {
                        count.fetch_add(1, Ordering::AcqRel);
                    })
                },
                on_metadata_rebase_required: Arc::new(|_| {}),
                on_close: Arc::new(|| {}),
            })
            .unwrap();
        detached.close();
        runtime
            .events
            .send(TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Patch(
                patch,
            )))
            .unwrap();
        wait_until(|| patches.lock().unwrap().len() == 2).await;
        tokio::task::yield_now().await;
        assert_eq!(detached_patches.load(Ordering::Acquire), 0);

        runtime
            .events
            .send(TmuxRuntimeEvent::Closed {
                device_id: "unit-device".to_owned(),
                manual: false,
            })
            .unwrap();
        wait_until(|| closes.load(Ordering::Acquire) == 1).await;
        detach.close();
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn canonical_commands_report_closed_channels() {
        let close_gate = Arc::new(Notify::new());
        let (factory, close_started, _close_finished) = fake_factory(Some(close_gate.clone()));
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();
        let canonical = super::super::DeviceCanonicalRuntime::new(runtime.clone()).unwrap();

        CanonicalFeedRuntime::send_input_bytes(&canonical, "%1", b"x")
            .await
            .unwrap();
        CanonicalFeedRuntime::resize_pane(&canonical, "%1", 80, 24)
            .await
            .unwrap();

        let shutdown = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.shutdown().await }
        });
        wait_for(&close_started).await;
        let input_error = CanonicalFeedRuntime::send_input_bytes(&canonical, "%1", b"closed")
            .await
            .unwrap_err();
        assert!(input_error.message.contains("runtime is closed"));
        let resize_error = CanonicalFeedRuntime::resize_pane(&canonical, "%1", 80, 24)
            .await
            .unwrap_err();
        assert!(resize_error.message.contains("runtime is closed"));
        close_gate.notify_waiters();
        shutdown.await.unwrap();
        assert!(super::super::DeviceCanonicalRuntime::new(runtime).is_err());
    }

    #[tokio::test]
    async fn working_dir_updates_are_fifo_bounded_and_closed_aware() {
        let (factory, _close_started, _close_finished, commands) = recording_fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        runtime
            .try_update_default_working_dir(Some("  /next-workspace  ".to_owned()))
            .unwrap();
        runtime.close_window("@1").await.unwrap();

        let commands = commands.lock().unwrap().clone();
        let update_index = commands
            .iter()
            .position(|args| {
                args == &strings([
                    "set-option",
                    "-t",
                    "tmex-runtime-lifecycle-test",
                    "default-path",
                    "/next-workspace",
                ])
            })
            .expect("working directory update command");
        let recovery_index = commands
            .iter()
            .position(|args| {
                args.first().map(String::as_str) == Some("new-window")
                    && args
                        .windows(2)
                        .any(|pair| pair[0] == "-c" && pair[1] == "/next-workspace")
            })
            .expect("recovery window uses updated working directory");
        assert!(update_index < recovery_index);

        runtime.shutdown().await;

        let (factory, _close_started, _close_finished) = fake_factory(None);
        let runtime = DeviceSessionRuntime::start(runtime_config(), factory)
            .await
            .unwrap();

        for _ in 0..RUNTIME_COMMAND_QUEUE_CAPACITY {
            runtime
                .try_update_default_working_dir(Some("/queued".to_owned()))
                .unwrap();
        }
        assert!(matches!(
            runtime.try_update_default_working_dir(Some("/overflow".to_owned())),
            Err(DeviceSessionRuntimeError::Backpressure)
        ));

        runtime.shutdown().await;
        assert!(matches!(
            runtime.try_update_default_working_dir(None),
            Err(DeviceSessionRuntimeError::Closed)
        ));
    }

    #[test]
    fn canonical_history_errors_preserve_reason_and_message() {
        let cases = [
            (
                PaneHistoryCursorErrorReason::EpochChanged,
                CanonicalHistoryCursorErrorReason::EpochChanged,
            ),
            (
                PaneHistoryCursorErrorReason::CacheEvicted,
                CanonicalHistoryCursorErrorReason::CacheEvicted,
            ),
            (
                PaneHistoryCursorErrorReason::ResourceExhausted,
                CanonicalHistoryCursorErrorReason::ResourceExhausted,
            ),
        ];
        for (source, expected) in cases {
            let mapped = super::super::canonical_runtime::canonical_history_error(
                PaneHistoryCursorError::new(source, "cursor rejected"),
            );
            assert_eq!(mapped.reason, expected);
            assert_eq!(mapped.message, "cursor rejected");
        }
    }
}
