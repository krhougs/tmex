mod canonical_runtime;
mod capture_history;
mod command_builder;
mod connection_types;
mod control_mode_capture;
mod control_mode_subscription;
mod control_runtime;
mod control_stream_metrics;
mod device_session_runtime;
mod input_encoder;
mod key_input;
mod lifecycle_emitter;
mod local_shell_path;
mod metadata_projection;
mod pane_emulator;
mod pane_history_reader;
mod pane_retention;
mod runtime_factory;
mod runtime_registry;
mod server_epoch;
mod snapshot_diff;
mod snapshot_directory;
mod snapshot_format;
mod snapshot_refresh_coordinator;
mod spawn_policy;
mod ssh_auth;
mod ssh_bootstrap;
mod ssh_connect_config;
mod target_missing;
mod terminfo;
mod theme_broadcaster;
mod theme_subscriptions;
mod tmux_commands;
mod tmux_version;
mod transport;
mod window_style;

pub use canonical_runtime::DeviceCanonicalRuntime;
pub use capture_history::{
    append_cursor_restore, parse_pane_history_capture_info, parse_pane_meta,
    parse_pane_screen_info, PaneHistoryCaptureInfo, PaneInfo, PaneScreenInfo,
    ParsePaneHistoryCaptureInfoError, PANE_HISTORY_CAPTURE_INFO_FORMAT, PANE_META_FORMAT,
    PANE_SCREEN_INFO_FORMAT,
};
pub use command_builder::{join_shell_args, quote_shell_arg};
pub use connection_types::{
    is_no_server_running_message, is_tmux_server_gone_message, CapturedTerminalHistory,
    DeviceSessionConfig, LocalTmuxConfig, MovePanePosition, SplitDirection, TargetMissingMode,
    ThemeMode, TmuxRuntimeEvent, TmuxRuntimeKind, TmuxTransportConfig,
    CONTROL_ATTACH_READY_TIMEOUT, CONTROL_CHUNK_QUEUE_CAPACITY, CONTROL_MAX_RESTARTS,
    CONTROL_RESTART_DELAY, CONTROL_STABLE_RESET, CONTROL_STDERR_TAIL_LIMIT, HEARTBEAT_INTERVAL,
    HEARTBEAT_TIMEOUT, LOCAL_RUN_TIMEOUT, NO_SERVER_RUNNING_MAX_RETRIES,
    NO_SERVER_RUNNING_RETRY_DELAY, PARKING_WINDOW_NAME, REMOTE_RUN_TIMEOUT,
    RUNTIME_COMMAND_QUEUE_CAPACITY, RUNTIME_EVENT_QUEUE_CAPACITY,
};

pub use control_mode_capture::{
    capture_pane_frame_at_control_barrier, AtomicPaneCapture, AtomicPaneCaptureError,
    ControlCommand, ControlCommandOptions, ControlModeCommandQueue, ControlModeQueueError,
    ControlModeQueueGuard, PaneModeFlags,
};
pub use control_mode_subscription::{
    ControlModeSubscription, ControlModeSubscriptionEvent, SourceMetadataEvent,
    SOURCE_METADATA_SUBSCRIPTION_COMMANDS, STRUCTURE_RECONCILE_MS,
};
pub use control_runtime::{start_control_runtime, ControlRuntimeError, ControlRuntimeHandle};
pub use control_stream_metrics::{
    ControlStreamMetrics, ControlStreamMetricsError, ControlStreamMetricsSnapshot,
    CONTROL_STREAM_METRICS_INTERVAL_MS,
};
pub use device_session_runtime::{
    DefaultTmuxTransportFactory, DeviceSessionRuntime, DeviceSessionRuntimeError,
    TmuxTransportFactory,
};
pub use input_encoder::{
    encode_bytes_to_hex_chunks, encode_bytes_to_hex_chunks_with_size, encode_input_to_hex_chunks,
    encode_input_to_hex_chunks_with_size, InputEncodingError, SEND_KEYS_HEX_CHUNK_BYTES,
};
pub use key_input::{encode_terminal_key, TerminalKeyEncodeError};
pub use lifecycle_emitter::{
    ConnectionLifecycleEmitter, LifecycleEvent, LifecycleEventKind, LifecycleTmuxContext,
    TmuxLifecycleSink,
};
pub use local_shell_path::{
    build_local_tmux_env, extract_path_from_shell_env, get_local_parking_command,
    inherited_environment, HostPlatform, LocalShellPathResolver, SHELL_ENV_BEGIN_MARKER,
    SHELL_ENV_END_MARKER, SHELL_ENV_PROBE_COMMAND,
};
pub use metadata_projection::{
    MetadataProjection, MetadataProjectionError, MetadataProjectionFlush,
    MetadataProjectionSnapshot, ProjectionEntityKind, DEFAULT_METADATA_FLUSH_INTERVAL_MS,
    MAX_PENDING_METADATA_BYTES, MAX_UNKNOWN_PANES, MAX_UNKNOWN_PANE_BYTES,
};
pub use pane_emulator::{PaneEmulator, PaneEmulatorError};
pub use pane_history_reader::{
    CapturedPaneHistoryPage, PaneHistoryCursor, PaneHistoryCursorError,
    PaneHistoryCursorErrorReason, PaneHistoryReader, PaneHistoryReaderOptions, PaneHistorySource,
    DEFAULT_HISTORY_SESSION_TTL_MS, DEFAULT_MAX_HISTORY_PAGE_BYTES, DEFAULT_MAX_HISTORY_SESSIONS,
    HISTORY_CAPTURE_OUTPUT_OVERHEAD_BYTES, MAX_HISTORY_CAPTURE_LINES,
};
pub use pane_retention::{
    PaneDataSegment, PaneHistoryPage, PaneIdentity, PaneReplayGap, PaneReplayGapReason,
    PaneReplayPlan, PaneRetention, PaneRetentionConsumerCallbacks, PaneRetentionConsumerLease,
    PaneRetentionError, PaneRetentionEvictionReason, PaneRetentionLimits, PaneRetentionMode,
    PaneRetentionOptions, PaneRetentionStats, PaneScreenCheckpoint, PaneSubscriptionApplyResult,
    PaneSubscriptionRejection, PaneSubscriptionRejectionReason, PaneSubscriptionRequest,
    PaneTerminalCursor, DEFAULT_HOT_TTL_MS, DEFAULT_MAX_ACTIVE_PANES,
    DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE, DEFAULT_MAX_HOT_PANES,
    DEFAULT_MAX_REPLAY_BYTES_PER_PANE, DEFAULT_MAX_RETENTION_BYTES, DEFAULT_REPLAY_TTL_MS,
    DEFAULT_ROUTE_GRACE_MS,
};
pub use runtime_factory::{RepositoryTmuxRuntimeConfig, RepositoryTmuxRuntimeFactory};
pub use runtime_registry::{
    ManagedTmuxRuntime, RuntimeRegistryError, TmuxRuntimeFactory, TmuxRuntimeRegistry,
};
pub use server_epoch::{
    decode_server_epoch, encode_server_epoch, ensure_stable_server_epoch,
    ensure_stable_server_epoch_with_candidate, new_server_epoch, ServerEpochError,
    TmuxCommandResult, TMEX_SERVER_EPOCH_OPTION,
};
pub use snapshot_diff::{diff_snapshot_closures, ClosedPane, SnapshotClosures};
pub use snapshot_directory::SnapshotDirectory;
pub use snapshot_format::{
    format_snapshot_row_for_log, format_snapshot_row_for_log_with_limit, is_tmux_pane_id,
    is_tmux_session_id, is_tmux_window_id, parse_pane_snapshot_row, parse_snapshot_integer,
    parse_window_snapshot_row, split_snapshot_fields, PaneSnapshotRow, WindowSnapshotRow,
    PANE_SNAPSHOT_FORMAT, SNAPSHOT_FIELD_SEPARATOR, WINDOW_SNAPSHOT_FORMAT,
};
pub use snapshot_refresh_coordinator::{
    SnapshotRefreshAction, SnapshotRefreshCoordinator, SnapshotRefreshRunResult,
};
pub use spawn_policy::{
    CommandOutput, CommandSpec, CommandStdin, SpawnError, SpawnExecutor, SpawnIsolation,
    SpawnPolicy, SpawnPurpose, SpawnRequest, SpawnedChild, StandaloneSpawnPolicy,
};
pub use ssh_auth::{
    resolve_ssh_agent_socket, resolve_ssh_username, SecretString, SshAuthError, SshAuthMode,
};
pub use ssh_bootstrap::{
    build_ssh_bootstrap_script, parse_ssh_bootstrap_output, ParsedSshBootstrap,
    SSH_BOOTSTRAP_SCRIPT,
};
pub use ssh_connect_config::{
    parse_ssh_config_output, resolve_ssh_connect_config, ProcessSshConfigLookup, ResolvedSshAuth,
    ResolvedSshConfigRef, SshConfigError, SshConfigLookup, SshConnectConfig, SshDeviceConfig,
};
pub use target_missing::{is_target_missing_message, TmuxTargetMissingError};
pub use terminfo::{build_ensure_ghostty_terminfo_script, XTERM_GHOSTTY_TERMINFO_SOURCE};
pub use theme_broadcaster::ThemeBroadcaster;
pub use theme_subscriptions::ThemeSubscriptionTracker;
pub use tmux_commands::{
    capture_history_range_command, capture_pane_text_command, configure_window_style_commands,
    create_window_command, ensure_session_commands, move_pane_command, pane_history_info_command,
    pane_info_command, pane_screen_info_command, parse_state_snapshot, resize_pane_command,
    resize_window_command, send_input_commands, session_configuration_commands, snapshot_commands,
    split_pane_command, SESSION_SNAPSHOT_FORMAT,
};
pub use tmux_version::{
    is_control_mode_supported, normalize_tmux_version_output, parse_tmux_version,
    tmux_client_matches_server, tmux_version_identity, TmuxVersion, TmuxVersionOutput,
    MIN_CONTROL_MODE_VERSION,
};
pub use transport::{
    build_local_tmux_argv, build_ssh_shell_command_frame, is_openssh_askpass_helper_request,
    run_openssh_askpass_helper, ControlClient, ControlClientParts, LocalTmuxTransport,
    OpenSshAskpassExecutable, OpenSshCredentialFileKind, OpenSshCredentialFileWriter,
    OpenSshCredentialLease, SshInvocationBuilder, SshTmuxTransport,
    SystemOpenSshCredentialFileWriter, SystemOpenSshInvocationBuilder, TmuxTransport,
    TmuxTransportError, TMEX_SSH_ASKPASS_MODE_ENV, TMEX_SSH_ASKPASS_SECRET_FILE_ENV,
};
pub use window_style::{resolve_tmux_window_style, WINDOW_STYLE_PATTERN_DESCRIPTION};
