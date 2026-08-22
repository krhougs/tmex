use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::FutureExt;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tmex_protocol::{
    decode_canonical_command, encode_envelope, encode_payload, BellEvent, CanonicalEvent,
    ClipboardWrite, DeviceEvent, Envelope, EventNotifyS2c, NotificationEvent, PaneActiveEvent,
    SettingsUpdateS2c, SiteThemeUpdateS2c, SourceMetadataPatch, SourceMetadataValue, StateSnapshot,
    StateSnapshotDiff, TmuxEvent, WatchEvent, AGENT_EVENT_CONFIRMATION_REQUEST,
    AGENT_EVENT_CONFIRMATION_RESOLVED, AGENT_EVENT_CREDENTIAL_WARNING, AGENT_EVENT_ERROR,
    AGENT_EVENT_MESSAGE_PERSISTED, AGENT_EVENT_QUEUE_UPDATED, AGENT_EVENT_REASONING_DELTA,
    AGENT_EVENT_STATUS, AGENT_EVENT_TEXT_DELTA, AGENT_EVENT_TOOL_CALL, AGENT_EVENT_TOOL_RESULT,
    AGENT_EVENT_TURN_FINISHED, SITE_THEME_DARK, SITE_THEME_LIGHT, SOURCE_ENTITY_PANE,
    SOURCE_ENTITY_SESSION, SOURCE_ENTITY_WINDOW, SOURCE_FIELD_ACTIVE, SOURCE_FIELD_CURRENT_COMMAND,
    SOURCE_FIELD_CURRENT_PATH, SOURCE_FIELD_CUSTOM_NAME, SOURCE_FIELD_HEIGHT, SOURCE_FIELD_INDEX,
    SOURCE_FIELD_LAYOUT, SOURCE_FIELD_LEFT, SOURCE_FIELD_NAME, SOURCE_FIELD_PANE_EPOCH,
    SOURCE_FIELD_TITLE, SOURCE_FIELD_TOP, SOURCE_FIELD_WIDTH,
};
use tmex_terminal::PaneStreamNotificationSource;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::agent::{
    AgentEvent, AgentEventEnvelope, AgentEventSink, AgentPortError, AgentSubscriptionSync,
    AgentSupervisor,
};
use crate::database::repository::{Repository, RepositorySiteSettingsDefaults, SiteSettingsUpdate};
use crate::events::{EventError, EventNotifyBroadcaster};
use crate::ipc::{
    CloseFrame, GatewayFrame, GatewaySession, GatewaySessionReceiver, GatewaySessionSender,
};
use crate::push::{DeviceEventBroadcaster, PushError};
use crate::state::{
    CanonicalFeedRuntime, CanonicalFeedSession, CanonicalFeedSessionOptions, CanonicalRuntimeError,
};
use crate::tmux::{
    CapturedTerminalHistory, DeviceCanonicalRuntime, DeviceSessionRuntime,
    DeviceSessionRuntimeError, MetadataProjectionFlush, MovePanePosition, ProjectionEntityKind,
    SplitDirection, ThemeMode, TmuxRuntimeEvent, TmuxRuntimeRegistry,
};

use super::{
    BackpressureConfig, BackpressureGuard, CapturedPaneHistory, LegacyBusinessEvent,
    LegacyBusinessRuntime, LegacyBusinessSession, LegacyFrameSink, LegacyPanePosition,
    LegacyRuntimeCommand, LegacySplitDirection, LegacyTmuxEventDelivery, SessionConfig,
    SessionProtocolError, GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
};

pub const GATEWAY_WS_SESSION_MAILBOX_CAPACITY: usize = 256;
pub const GATEWAY_WS_OUTBOUND_FRAME_CAPACITY: usize = 128;
pub const GATEWAY_WS_IPC_FRAME_CAPACITY: usize = 128;

const ACTOR_IDLE_POLL_MS: u64 = 250;
const STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON: u8 = 1;
const THEME_SIGNAL_DEDUP_MS: u64 = 1_000;
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

#[derive(Clone, Debug)]
pub struct GatewayWsHubConfig {
    pub session: SessionConfig,
    pub session_mailbox_capacity: usize,
    pub outbound_frame_capacity: usize,
    pub ipc_frame_capacity: usize,
    pub backpressure: BackpressureConfig,
    pub initial_theme: Option<ThemeMode>,
}

impl GatewayWsHubConfig {
    pub fn new(server_version: impl Into<String>) -> Self {
        Self {
            session: SessionConfig::new(server_version),
            session_mailbox_capacity: GATEWAY_WS_SESSION_MAILBOX_CAPACITY,
            outbound_frame_capacity: GATEWAY_WS_OUTBOUND_FRAME_CAPACITY,
            ipc_frame_capacity: GATEWAY_WS_IPC_FRAME_CAPACITY,
            backpressure: BackpressureConfig::default(),
            initial_theme: None,
        }
    }
}

impl Default for GatewayWsHubConfig {
    fn default() -> Self {
        Self::new("unknown")
    }
}

#[derive(Clone)]
pub struct GatewayWsHubDependencies {
    pub runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    pub repository: Repository,
    pub site_settings_defaults: RepositorySiteSettingsDefaults,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GatewayTreeCustomNames {
    pub windows: BTreeMap<String, String>,
    pub panes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
struct GatewayTreeOrder {
    windows: Vec<String>,
    panes: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayTreeOrderChange {
    Windows {
        device_id: String,
        window_ids: Vec<String>,
    },
    Panes {
        device_id: String,
        window_id: String,
        pane_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct GatewayWsHubError {
    message: String,
}

impl GatewayWsHubError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[async_trait]
pub trait AgentSyncProvider: Send + Sync {
    async fn sync_snapshot(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<AgentSubscriptionSync, GatewayWsHubError>;
}

#[async_trait]
impl AgentSyncProvider for AgentSupervisor {
    async fn sync_snapshot(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<AgentSubscriptionSync, GatewayWsHubError> {
        AgentSupervisor::sync_snapshot(self, session_id, generation)
            .await
            .map_err(|error| GatewayWsHubError::new(error.to_string()))
    }
}

pub trait WatchEventBroadcaster: Send + Sync {
    fn broadcast_watch_event(&self, event: WatchEvent) -> Result<(), GatewayWsHubError>;
}

#[derive(Clone)]
pub struct GatewayWsHub {
    inner: Arc<GatewayWsHubInner>,
}

struct GatewayWsHubInner {
    config: GatewayWsHubConfig,
    dependencies: GatewayWsHubDependencies,
    sessions: Mutex<HashMap<u64, SessionEntry>>,
    next_session_id: AtomicU64,
    last_theme_timestamp: AtomicU64,
    last_settings_timestamp: AtomicU64,
    stopped: AtomicBool,
    agent_sync: RwLock<Option<Arc<dyn AgentSyncProvider>>>,
    current_theme: RwLock<Option<ThemeMode>>,
    active_runtimes: Mutex<HashMap<String, Weak<DeviceSessionRuntime>>>,
    latest_snapshots: Mutex<HashMap<String, StateSnapshot>>,
    tree_custom_names: Mutex<HashMap<String, GatewayTreeCustomNames>>,
    tree_orders: Mutex<HashMap<String, GatewayTreeOrder>>,
    theme_apply: Mutex<ThemeApplyState>,
    theme_signal_last: Mutex<HashMap<String, (ThemeMode, u64)>>,
    tasks: SessionTaskGroup,
}

#[derive(Default)]
struct ThemeApplyState {
    generation: u64,
    running: bool,
    pending: Option<(u64, ThemeMode)>,
}

struct SessionEntry {
    sender: mpsc::Sender<ActorMessage>,
    abort: SessionAbort,
    task: JoinHandle<()>,
}

#[derive(Clone)]
struct SessionAbort {
    sender: watch::Sender<bool>,
}

#[derive(Clone)]
struct SessionTaskGroup {
    state: Arc<Mutex<SessionTaskGroupState>>,
    on_panic: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct SessionTaskGroupState {
    stopped: bool,
    handles: Vec<JoinHandle<()>>,
}

impl SessionTaskGroup {
    fn new(on_panic: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            state: Arc::new(Mutex::new(SessionTaskGroupState::default())),
            on_panic: Arc::new(on_panic),
        }
    }

    fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.stopped {
            let on_panic = self.on_panic.clone();
            state.handles.push(tokio::spawn(async move {
                if AssertUnwindSafe(future).catch_unwind().await.is_err() {
                    on_panic();
                }
            }));
        }
    }

    fn reap(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .handles
            .retain(|handle| !handle.is_finished());
    }

    async fn cancel_all(&self) {
        let handles = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.stopped = true;
            std::mem::take(&mut state.handles)
        };
        for handle in &handles {
            handle.abort();
        }
        for handle in handles {
            let _ = handle.await;
        }
    }

    fn abort_all(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stopped = true;
        for handle in state.handles.drain(..) {
            handle.abort();
        }
    }
}

impl Default for SessionTaskGroup {
    fn default() -> Self {
        Self::new(|| tracing::error!("Gateway background task panicked"))
    }
}

impl SessionAbort {
    fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }

    fn cancel(&self) {
        self.sender.send_replace(true);
    }

    fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    fn subscribe(&self) -> watch::Receiver<bool> {
        self.sender.subscribe()
    }
}

#[derive(Clone, Debug)]
enum HubBroadcast {
    Device(DeviceEvent),
    Agent(AgentEventEnvelope),
    Watch(WatchEvent),
    SiteTheme(SiteThemeUpdateS2c),
    Settings(SettingsUpdateS2c),
    Notify(EventNotifyS2c),
    TreeOrder(GatewayTreeOrderChange),
    TreeCustomName {
        device_id: String,
        kind: ProjectionEntityKind,
        native_id: String,
        name: Option<String>,
    },
}

enum ActorMessage {
    Poll,
    Shutdown {
        close: Option<CloseFrame>,
    },
    Broadcast(HubBroadcast),
    RuntimeEvent {
        device_id: String,
        generation: u64,
        event: TmuxRuntimeEvent,
    },
    RuntimeEventsLagged {
        device_id: String,
        generation: u64,
    },
    ConnectCompleted {
        device_id: String,
        generation: u64,
        result: Result<(Arc<DeviceSessionRuntime>, Option<StateSnapshot>), GatewayWsHubError>,
    },
    PreparedSnapshot {
        device_id: String,
        generation: u64,
        job: u64,
        snapshot: StateSnapshot,
    },
    ReconnectCompleted {
        device_id: String,
        generation: u64,
        attempt: u32,
        result: Result<(Arc<DeviceSessionRuntime>, Option<StateSnapshot>), GatewayWsHubError>,
    },
    CreateWindowCompleted {
        device_id: String,
        generation: u64,
        completion_id: u64,
        window_id: Option<String>,
    },
    HistoryCompleted {
        device_id: String,
        generation: u64,
        pane_id: String,
        request_token: [u8; 16],
        history: Option<CapturedPaneHistory>,
    },
    AgentSyncCompleted {
        session_id: String,
        generation: u64,
        payload: Option<Vec<u8>>,
    },
    CanonicalAttached {
        device_id: String,
    },
    CanonicalDetached {
        device_id: String,
        runtime: Arc<dyn CanonicalFeedRuntime>,
    },
    ThemePersisted {
        theme: ThemeMode,
    },
    #[cfg(test)]
    PanicForTest,
}

impl GatewayWsHub {
    pub fn new(
        config: GatewayWsHubConfig,
        dependencies: GatewayWsHubDependencies,
    ) -> Result<Self, GatewayWsHubError> {
        if config.session_mailbox_capacity == 0 {
            return Err(GatewayWsHubError::new(
                "WebSocket session mailbox capacity must be positive",
            ));
        }
        if config.outbound_frame_capacity == 0 {
            return Err(GatewayWsHubError::new(
                "WebSocket outbound frame capacity must be positive",
            ));
        }
        if config.ipc_frame_capacity == 0 {
            return Err(GatewayWsHubError::new(
                "WebSocket IPC frame capacity must be positive",
            ));
        }
        let initial_theme = config.initial_theme;
        Ok(Self {
            inner: Arc::new(GatewayWsHubInner {
                config,
                dependencies,
                sessions: Mutex::new(HashMap::new()),
                next_session_id: AtomicU64::new(1),
                last_theme_timestamp: AtomicU64::new(0),
                last_settings_timestamp: AtomicU64::new(0),
                stopped: AtomicBool::new(false),
                agent_sync: RwLock::new(None),
                current_theme: RwLock::new(initial_theme),
                active_runtimes: Mutex::new(HashMap::new()),
                latest_snapshots: Mutex::new(HashMap::new()),
                tree_custom_names: Mutex::new(HashMap::new()),
                tree_orders: Mutex::new(HashMap::new()),
                theme_apply: Mutex::new(ThemeApplyState::default()),
                theme_signal_last: Mutex::new(HashMap::new()),
                tasks: SessionTaskGroup::default(),
            }),
        })
    }

    pub fn set_agent_sync_provider(&self, provider: Arc<dyn AgentSyncProvider>) {
        *self
            .inner
            .agent_sync
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(provider);
    }

    pub fn open_session(&self) -> Result<GatewaySession, GatewayWsHubError> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.inner.stopped.load(Ordering::Acquire) {
            return Err(GatewayWsHubError::new("WebSocket hub is stopped"));
        }
        let session_id = self.inner.next_session_id.fetch_add(1, Ordering::AcqRel);
        let outbound_bytes = Arc::new(AtomicUsize::new(0));
        let (client, server) = GatewaySession::pair_with_server_outbound_counter(
            self.inner.config.ipc_frame_capacity,
            outbound_bytes.clone(),
        )
        .map_err(|error| GatewayWsHubError::new(error.to_string()))?;
        let (sender, receiver) = mpsc::channel(self.inner.config.session_mailbox_capacity);
        let abort = SessionAbort::new();
        let (outbound, outbound_receiver) = OutboundQueue::new(
            self.inner.config.outbound_frame_capacity,
            self.inner.config.backpressure,
            abort.clone(),
            outbound_bytes,
        );
        let actor = GatewaySessionActor::new(
            session_id,
            &self.inner,
            sender.clone(),
            receiver,
            abort.clone(),
            outbound,
        );
        let task = tokio::spawn(async move {
            actor.run(server, outbound_receiver).await;
        });
        sessions.insert(
            session_id,
            SessionEntry {
                sender,
                abort,
                task,
            },
        );
        Ok(client)
    }

    pub async fn stop_all(&self) {
        self.shutdown_sessions(None).await;
    }

    pub async fn close_all(&self, code: u16, reason: impl Into<String>) {
        self.shutdown_sessions(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))
        .await;
    }

    async fn shutdown_sessions(&self, close: Option<CloseFrame>) {
        let mut entries = {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.inner.stopped.store(true, Ordering::Release);
            sessions.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        let send_timeout = Duration::from_millis(self.inner.config.backpressure.timeout_ms);
        let task_timeout = Duration::from_millis(
            self.inner
                .config
                .backpressure
                .timeout_ms
                .saturating_add(250),
        );
        if let Some(close) = close {
            let sends = entries.iter().map(|entry| {
                let sender = entry.sender.clone();
                let abort = entry.abort.clone();
                let close = close.clone();
                async move {
                    if !matches!(
                        tokio::time::timeout(
                            send_timeout,
                            sender.send(ActorMessage::Shutdown { close: Some(close) }),
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        abort.cancel();
                    }
                }
            });
            futures_util::future::join_all(sends).await;
        } else {
            for entry in &entries {
                entry.abort.cancel();
            }
        }
        let waits = entries.iter_mut().map(|entry| async move {
            if tokio::time::timeout(task_timeout, &mut entry.task)
                .await
                .is_err()
            {
                entry.abort.cancel();
                entry.task.abort();
                let _ = (&mut entry.task).await;
            }
        });
        futures_util::future::join_all(waits).await;
        self.inner.tasks.cancel_all().await;
    }

    pub fn broadcast_site_theme(&self, theme: ThemeMode) {
        self.inner.schedule_theme_apply(theme);
        let timestamp = next_timestamp(&self.inner.last_theme_timestamp);
        let theme_code = match theme {
            ThemeMode::Dark => SITE_THEME_DARK,
            ThemeMode::Light => SITE_THEME_LIGHT,
        };
        self.inner
            .broadcast(HubBroadcast::SiteTheme(SiteThemeUpdateS2c {
                theme: theme_code,
                server_timestamp: timestamp,
            }));
    }

    pub fn broadcast_settings_update(&self, namespace: impl Into<String>) {
        self.inner
            .broadcast(HubBroadcast::Settings(SettingsUpdateS2c {
                namespace: namespace.into(),
                server_timestamp: next_timestamp(&self.inner.last_settings_timestamp),
            }));
    }

    pub fn tree_custom_names(&self, device_id: &str) -> GatewayTreeCustomNames {
        self.inner
            .tree_custom_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(device_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn tree_order_changed(&self, change: GatewayTreeOrderChange) {
        self.inner.apply_tree_order(change);
    }

    pub async fn rename_window(
        &self,
        device_id: &str,
        window_id: &str,
        name: Option<String>,
    ) -> Result<(), GatewayWsHubError> {
        self.inner
            .apply_tree_custom_name(device_id, ProjectionEntityKind::Window, window_id, name)
            .await
    }

    pub async fn rename_pane(
        &self,
        device_id: &str,
        pane_id: &str,
        name: Option<String>,
    ) -> Result<(), GatewayWsHubError> {
        self.inner
            .apply_tree_custom_name(device_id, ProjectionEntityKind::Pane, pane_id, name)
            .await
    }

    pub async fn latest_snapshot(
        &self,
        device_id: &str,
    ) -> Result<Option<StateSnapshot>, GatewayWsHubError> {
        if let Some(runtime) = self
            .inner
            .active_runtime(device_id)
            .filter(|runtime| !runtime.is_terminated())
        {
            let snapshot = runtime
                .current_snapshot()
                .await
                .map_err(|error| GatewayWsHubError::new(error.to_string()))?;
            if let Some(snapshot) = snapshot {
                let snapshot = prepare_snapshot(
                    Some(self.inner.dependencies.repository.clone()),
                    runtime,
                    snapshot,
                )
                .await;
                return Ok(snapshot.map(|snapshot| self.inner.record_snapshot(snapshot)));
            }
        }
        Ok(self
            .inner
            .latest_snapshots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(device_id)
            .cloned())
    }
}

impl Drop for GatewayWsHubInner {
    fn drop(&mut self) {
        self.tasks.abort_all();
        for entry in self
            .sessions
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            entry.abort.cancel();
        }
    }
}

impl GatewayWsHubInner {
    fn broadcast(&self, event: HubBroadcast) {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in sessions.values() {
            if entry
                .sender
                .try_send(ActorMessage::Broadcast(event.clone()))
                .is_err()
            {
                entry.abort.cancel();
            }
        }
    }

    fn remove_session(&self, session_id: u64) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_id);
    }

    fn agent_sync_provider(&self) -> Option<Arc<dyn AgentSyncProvider>> {
        self.agent_sync
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn register_runtime(&self, device_id: &str, runtime: &Arc<DeviceSessionRuntime>) -> bool {
        let replaced = self
            .active_runtimes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(device_id.to_owned(), Arc::downgrade(runtime))
            .and_then(|previous| previous.upgrade())
            .is_none_or(|previous| !Arc::ptr_eq(&previous, runtime));
        if replaced {
            self.theme_signal_last
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(device_id);
        }
        replaced
    }

    fn active_runtime(&self, device_id: &str) -> Option<Arc<DeviceSessionRuntime>> {
        self.active_runtimes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(device_id)
            .and_then(Weak::upgrade)
    }

    fn record_snapshot(&self, mut snapshot: StateSnapshot) -> StateSnapshot {
        self.apply_tree_overlays(&mut snapshot);
        self.latest_snapshots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(snapshot.device_id.clone(), snapshot.clone());
        snapshot
    }

    fn apply_tree_overlays(&self, snapshot: &mut StateSnapshot) {
        let Some(session) = snapshot.session.as_ref() else {
            return;
        };
        let live_windows = session
            .windows
            .iter()
            .map(|window| window.id.clone())
            .collect::<HashSet<_>>();
        let live_panes = session
            .windows
            .iter()
            .flat_map(|window| window.panes.iter().map(|pane| pane.id.clone()))
            .collect::<HashSet<_>>();
        let live_panes_by_window = session
            .windows
            .iter()
            .map(|window| {
                (
                    window.id.clone(),
                    window
                        .panes
                        .iter()
                        .map(|pane| pane.id.clone())
                        .collect::<HashSet<_>>(),
                )
            })
            .collect::<HashMap<_, _>>();

        let names = {
            let mut all_names = self
                .tree_custom_names
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let names = if let Some(names) = all_names.get_mut(&snapshot.device_id) {
                names.windows.retain(|id, _| live_windows.contains(id));
                names.panes.retain(|id, _| live_panes.contains(id));
                names.clone()
            } else {
                GatewayTreeCustomNames::default()
            };
            if names.windows.is_empty() && names.panes.is_empty() {
                all_names.remove(&snapshot.device_id);
            }
            names
        };
        let order = {
            let mut all_orders = self
                .tree_orders
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(order) = all_orders.get_mut(&snapshot.device_id) {
                order.windows.retain(|id| live_windows.contains(id));
                order.panes.retain(|window_id, pane_ids| {
                    let Some(live_panes) = live_panes_by_window.get(window_id) else {
                        return false;
                    };
                    pane_ids.retain(|id| live_panes.contains(id));
                    true
                });
            }
            all_orders.get(&snapshot.device_id).cloned()
        };

        for (window_id, name) in names.windows {
            apply_snapshot_custom_name(
                snapshot,
                ProjectionEntityKind::Window,
                &window_id,
                Some(&name),
            );
        }
        for (pane_id, name) in names.panes {
            apply_snapshot_custom_name(snapshot, ProjectionEntityKind::Pane, &pane_id, Some(&name));
        }
        if let (Some(order), Some(session)) = (order, snapshot.session.as_mut()) {
            stable_reorder(&mut session.windows, &order.windows, |window| &window.id);
            for window in &mut session.windows {
                if let Some(panes) = order.panes.get(&window.id) {
                    stable_reorder(&mut window.panes, panes, |pane| &pane.id);
                }
            }
        }
    }

    fn apply_tree_order(&self, change: GatewayTreeOrderChange) {
        {
            let mut orders = self
                .tree_orders
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &change {
                GatewayTreeOrderChange::Windows {
                    device_id,
                    window_ids,
                } => orders.entry(device_id.clone()).or_default().windows = window_ids.clone(),
                GatewayTreeOrderChange::Panes {
                    device_id,
                    window_id,
                    pane_ids,
                } => {
                    orders
                        .entry(device_id.clone())
                        .or_default()
                        .panes
                        .insert(window_id.clone(), pane_ids.clone());
                }
            }
        }
        {
            let mut snapshots = self
                .latest_snapshots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &change {
                GatewayTreeOrderChange::Windows {
                    device_id,
                    window_ids,
                } => {
                    if let Some(windows) = snapshots
                        .get_mut(device_id)
                        .and_then(|snapshot| snapshot.session.as_mut())
                        .map(|session| &mut session.windows)
                    {
                        stable_reorder(windows, window_ids, |window| &window.id);
                    }
                }
                GatewayTreeOrderChange::Panes {
                    device_id,
                    window_id,
                    pane_ids,
                } => {
                    if let Some(window) = snapshots
                        .get_mut(device_id)
                        .and_then(|snapshot| snapshot.session.as_mut())
                        .and_then(|session| {
                            session
                                .windows
                                .iter_mut()
                                .find(|window| window.id == *window_id)
                        })
                    {
                        stable_reorder(&mut window.panes, pane_ids, |pane| &pane.id);
                    }
                }
            }
        }
        self.broadcast(HubBroadcast::TreeOrder(change));
        self.broadcast_tree_settings();
    }

    async fn apply_tree_custom_name(
        &self,
        device_id: &str,
        kind: ProjectionEntityKind,
        native_id: &str,
        name: Option<String>,
    ) -> Result<(), GatewayWsHubError> {
        let name = name.and_then(|name| normalize_gateway_custom_name(&name));
        {
            let mut all_names = self
                .tree_custom_names
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let names = all_names.entry(device_id.to_owned()).or_default();
            let target = match kind {
                ProjectionEntityKind::Window => &mut names.windows,
                ProjectionEntityKind::Pane => &mut names.panes,
            };
            if let Some(name) = &name {
                target.insert(native_id.to_owned(), name.clone());
            } else {
                target.remove(native_id);
            }
        }
        {
            let mut snapshots = self
                .latest_snapshots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(snapshot) = snapshots.get_mut(device_id) {
                apply_snapshot_custom_name(snapshot, kind, native_id, name.as_deref());
            }
        }
        self.broadcast(HubBroadcast::TreeCustomName {
            device_id: device_id.to_owned(),
            kind,
            native_id: native_id.to_owned(),
            name: name.clone(),
        });
        self.broadcast_tree_settings();
        if let Some(runtime) = self.active_runtime(device_id) {
            runtime
                .set_custom_name(kind, native_id, name)
                .await
                .map_err(|error| GatewayWsHubError::new(error.to_string()))?;
        }
        Ok(())
    }

    fn broadcast_tree_settings(&self) {
        self.broadcast(HubBroadcast::Settings(SettingsUpdateS2c {
            namespace: "tree-order".to_owned(),
            server_timestamp: next_timestamp(&self.last_settings_timestamp),
        }));
    }

    fn active_runtimes(&self) -> Vec<(String, Arc<DeviceSessionRuntime>)> {
        let mut runtimes = self
            .active_runtimes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        runtimes.retain(|_, runtime| runtime.strong_count() > 0);
        let mut ordered = runtimes.iter().collect::<Vec<_>>();
        ordered.sort_by(|(left, _), (right, _)| left.cmp(right));
        ordered
            .into_iter()
            .filter_map(|(device_id, runtime)| {
                runtime
                    .upgrade()
                    .map(|runtime| (device_id.clone(), runtime))
            })
            .collect()
    }

    fn current_theme(&self) -> Option<ThemeMode> {
        *self
            .current_theme
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn schedule_theme_apply(self: &Arc<Self>, theme: ThemeMode) {
        *self
            .current_theme
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(theme);
        let start_runner = {
            let mut state = self
                .theme_apply
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.generation = state.generation.wrapping_add(1).max(1);
            let generation = state.generation;
            state.pending = Some((generation, theme));
            if state.running {
                false
            } else {
                state.running = true;
                true
            }
        };
        if !start_runner {
            return;
        }
        self.tasks.reap();
        let hub = Arc::downgrade(self);
        self.tasks.spawn(run_theme_apply(hub));
    }

    fn last_broadcast_theme(&self, device_id: &str) -> Option<ThemeMode> {
        self.theme_signal_last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(device_id)
            .map(|(theme, _)| *theme)
    }

    fn claim_theme_signal(&self, device_id: &str, theme: ThemeMode, at_ms: u64) -> bool {
        let mut last = self
            .theme_signal_last
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.get(device_id).is_some_and(|(previous, sent_at)| {
            *previous == theme && at_ms.saturating_sub(*sent_at) < THEME_SIGNAL_DEDUP_MS
        }) {
            return false;
        }
        last.insert(device_id.to_owned(), (theme, at_ms));
        true
    }
}

async fn run_theme_apply(hub: Weak<GatewayWsHubInner>) {
    loop {
        let Some(inner) = hub.upgrade() else {
            return;
        };
        let next = {
            let mut state = inner
                .theme_apply
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match state.pending.take() {
                Some(next) => Some(next),
                None => {
                    state.running = false;
                    None
                }
            }
        };
        let Some((_generation, theme)) = next else {
            return;
        };
        let runtimes = inner.active_runtimes();
        drop(inner);
        let style = theme_style(theme);
        let mut styled = Vec::new();
        for (device_id, runtime) in runtimes {
            if runtime.set_window_style(&style).await.is_ok() {
                styled.push((device_id, runtime));
            }
        }
        signal_theme_targets(&hub, theme, styled).await;
    }
}

async fn signal_theme_targets(
    hub: &Weak<GatewayWsHubInner>,
    theme: ThemeMode,
    runtimes: Vec<(String, Arc<DeviceSessionRuntime>)>,
) {
    for (device_id, runtime) in runtimes {
        let claimed = hub
            .upgrade()
            .is_some_and(|hub| hub.claim_theme_signal(&device_id, theme, now_ms()));
        if claimed {
            signal_runtime_theme(&runtime, theme).await;
        }
    }
}

async fn signal_theme_globally(hub: Weak<GatewayWsHubInner>, theme: ThemeMode) {
    let runtimes = hub
        .upgrade()
        .map(|hub| hub.active_runtimes())
        .unwrap_or_default();
    signal_theme_targets(&hub, theme, runtimes).await;
}

async fn set_window_style_and_broadcast_theme(
    hub: Weak<GatewayWsHubInner>,
    device_id: String,
    runtime: Arc<DeviceSessionRuntime>,
    style: String,
) -> Result<(), DeviceSessionRuntimeError> {
    runtime.set_window_style(&style).await?;
    let Some((theme, should_signal)) = hub.upgrade().and_then(|inner| {
        let theme = inner.current_theme()?;
        Some((theme, inner.last_broadcast_theme(&device_id) != Some(theme)))
    }) else {
        return Ok(());
    };
    if should_signal {
        signal_theme_globally(hub, theme).await;
    }
    Ok(())
}

async fn signal_runtime_theme(runtime: &DeviceSessionRuntime, theme: ThemeMode) {
    let Ok(Some(snapshot)) = runtime.current_snapshot().await else {
        return;
    };
    for pane in snapshot
        .session
        .iter()
        .flat_map(|session| &session.windows)
        .flat_map(|window| &window.panes)
    {
        let _ = runtime.signal_theme_change(&pane.id, theme).await;
    }
}

impl DeviceEventBroadcaster for GatewayWsHub {
    fn broadcast(&self, event: DeviceEvent) -> Result<(), PushError> {
        self.inner.broadcast(HubBroadcast::Device(event));
        Ok(())
    }
}

impl EventNotifyBroadcaster for GatewayWsHub {
    fn broadcast(&self, event: EventNotifyS2c) -> Result<(), EventError> {
        self.inner.broadcast(HubBroadcast::Notify(event));
        Ok(())
    }
}

impl WatchEventBroadcaster for GatewayWsHub {
    fn broadcast_watch_event(&self, event: WatchEvent) -> Result<(), GatewayWsHubError> {
        self.inner.broadcast(HubBroadcast::Watch(event));
        Ok(())
    }
}

#[async_trait]
impl AgentEventSink for GatewayWsHub {
    async fn emit(&self, event: AgentEventEnvelope) -> Result<(), AgentPortError> {
        self.inner.broadcast(HubBroadcast::Agent(event));
        Ok(())
    }
}

fn next_timestamp(counter: &AtomicU64) -> u64 {
    let now = now_ms();
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |previous| {
            Some(now.max(previous.saturating_add(1)))
        })
        .map(|previous| now.max(previous.saturating_add(1)))
        .unwrap_or_else(|previous| now.max(previous))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn runtime_error_event(
    device_id: String,
    generation: u64,
    error: impl std::fmt::Display,
) -> ActorMessage {
    ActorMessage::RuntimeEvent {
        device_id: device_id.clone(),
        generation,
        event: TmuxRuntimeEvent::Error {
            device_id,
            message: error.to_string(),
        },
    }
}

fn theme_style(theme: ThemeMode) -> String {
    match theme {
        ThemeMode::Dark => "fg=#d0d0d0,bg=#262626",
        ThemeMode::Light => "fg=#616161,bg=#e1e1e1",
    }
    .to_owned()
}

struct OutboundQueue {
    sender: mpsc::Sender<QueuedBatch>,
    queued_bytes: Arc<AtomicUsize>,
    guard: Mutex<BackpressureGuard>,
    abort: SessionAbort,
}

struct QueuedBatch {
    frames: Vec<(GatewayFrame, usize)>,
    bytes: usize,
    completion: Option<oneshot::Sender<bool>>,
}

impl OutboundQueue {
    fn new(
        capacity: usize,
        config: BackpressureConfig,
        abort: SessionAbort,
        queued_bytes: Arc<AtomicUsize>,
    ) -> (Arc<Self>, mpsc::Receiver<QueuedBatch>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (
            Arc::new(Self {
                sender,
                queued_bytes,
                guard: Mutex::new(BackpressureGuard::new(config)),
                abort,
            }),
            receiver,
        )
    }

    fn enqueue_envelopes(&self, envelopes: Vec<Envelope>, maximum: usize) -> bool {
        let frames = match envelopes
            .into_iter()
            .map(|envelope| {
                encode_envelope(
                    envelope.kind,
                    envelope.payload,
                    envelope.seq,
                    envelope.flags,
                    envelope.version,
                )
                .map(Bytes::from)
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(frames) => frames,
            Err(_) => {
                self.abort.cancel();
                return false;
            }
        };
        self.enqueue_frames(
            frames.into_iter().map(GatewayFrame::Binary).collect(),
            maximum,
        )
    }

    fn enqueue_control(&self, frame: GatewayFrame) -> bool {
        self.enqueue_frames_with_completion(vec![frame], usize::MAX, None)
    }

    fn enqueue_frames(&self, frames: Vec<GatewayFrame>, maximum: usize) -> bool {
        self.enqueue_frames_with_completion(frames, maximum, None)
    }

    fn enqueue_close(&self, close: CloseFrame) -> Option<oneshot::Receiver<bool>> {
        let (completion, receiver) = oneshot::channel();
        self.enqueue_frames_with_completion(
            vec![GatewayFrame::Close(Some(close))],
            usize::MAX,
            Some(completion),
        )
        .then_some(receiver)
    }

    fn enqueue_frames_with_completion(
        &self,
        frames: Vec<GatewayFrame>,
        maximum: usize,
        mut completion: Option<oneshot::Sender<bool>>,
    ) -> bool {
        if self.abort.is_cancelled() || frames.is_empty() {
            return !self.abort.is_cancelled();
        }
        let lengths = frames.iter().map(gateway_frame_size).collect::<Vec<_>>();
        let total = lengths.iter().copied().sum::<usize>();
        let mut guard = self
            .guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let currently_queued = self.queued_bytes.load(Ordering::Acquire);
        if !guard.can_send()
            || guard
                .validate_frame_lengths(lengths.iter().copied(), maximum)
                .is_some()
            || guard
                .observe_buffered_batch(currently_queued, total)
                .is_some()
            || self.sender.capacity() == 0
        {
            self.abort.cancel();
            return false;
        }
        self.queued_bytes.fetch_add(total, Ordering::AcqRel);
        if self
            .sender
            .try_send(QueuedBatch {
                frames: frames.into_iter().zip(lengths).collect(),
                bytes: total,
                completion: completion.take(),
            })
            .is_err()
        {
            self.queued_bytes.fetch_sub(total, Ordering::AcqRel);
            self.abort.cancel();
            return false;
        }
        drop(guard);
        true
    }
}

struct SessionFrameSink {
    outbound: Arc<OutboundQueue>,
    maximum: usize,
}

impl LegacyFrameSink for SessionFrameSink {
    fn can_send(&mut self) -> bool {
        !self.outbound.abort.is_cancelled()
    }

    fn send_batch(&mut self, frames: Vec<Envelope>) -> bool {
        self.outbound.enqueue_envelopes(frames, self.maximum)
    }

    fn mark_stream_gap(&mut self) {
        self.outbound
            .guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mark_stream_gap();
    }
}

async fn run_outbound_pump(
    sender: GatewaySessionSender,
    mut receiver: mpsc::Receiver<QueuedBatch>,
    queued_bytes: Arc<AtomicUsize>,
    abort: SessionAbort,
    timeout_ms: u64,
) {
    let mut cancelled = abort.subscribe();
    loop {
        tokio::select! {
            changed = cancelled.changed() => {
                if changed.is_err() || *cancelled.borrow() {
                    break;
                }
            }
            queued = receiver.recv() => {
                let Some(queued) = queued else { break; };
                let mut unsent_bytes = queued.bytes;
                let mut sent = true;
                for (frame, bytes) in queued.frames {
                    let result = tokio::time::timeout(
                        Duration::from_millis(timeout_ms),
                        sender.send_precounted(frame),
                    ).await;
                    if !matches!(result, Ok(Ok(()))) {
                        queued_bytes.fetch_sub(unsent_bytes, Ordering::AcqRel);
                        sent = false;
                        break;
                    }
                    unsent_bytes = unsent_bytes.saturating_sub(bytes);
                }
                if let Some(completion) = queued.completion {
                    let _ = completion.send(sent);
                }
                if !sent {
                    abort.cancel();
                    break;
                }
            }
        }
    }
    while let Ok(queued) = receiver.try_recv() {
        queued_bytes.fetch_sub(queued.bytes, Ordering::AcqRel);
        if let Some(completion) = queued.completion {
            let _ = completion.send(false);
        }
    }
}

fn gateway_frame_size(frame: &GatewayFrame) -> usize {
    match frame {
        GatewayFrame::Binary(data) | GatewayFrame::Ping(data) | GatewayFrame::Pong(data) => {
            data.len()
        }
        GatewayFrame::Text(text) => text.len(),
        GatewayFrame::Close(Some(frame)) => 2usize.saturating_add(frame.reason.len()),
        GatewayFrame::Close(None) => 0,
    }
}

struct RuntimePool {
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    entries: Mutex<HashMap<String, RuntimePoolEntry>>,
}

struct RuntimePoolEntry {
    runtime: Arc<DeviceSessionRuntime>,
    canonical_runtime: Arc<DeviceCanonicalRuntime>,
    legacy: bool,
    canonical: bool,
    canonical_confirmed: bool,
}

impl RuntimePool {
    fn new(registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>) -> Self {
        Self {
            registry,
            entries: Mutex::new(HashMap::new()),
        }
    }

    async fn acquire_legacy(
        &self,
        device_id: &str,
    ) -> Result<Arc<DeviceSessionRuntime>, GatewayWsHubError> {
        if let Some(runtime) = self.mark_existing(device_id, true) {
            return Ok(runtime);
        }
        let acquired = self
            .registry
            .acquire(device_id)
            .await
            .map_err(|error| GatewayWsHubError::new(error.to_string()))?;
        self.insert_or_release_extra(device_id, acquired, true)
            .await
    }

    async fn acquire_canonical(
        &self,
        device_id: &str,
    ) -> Result<Arc<dyn CanonicalFeedRuntime>, CanonicalRuntimeError> {
        if let Some(runtime) = self.mark_existing_canonical(device_id)? {
            return Ok(runtime);
        }
        let acquired = self
            .registry
            .acquire(device_id)
            .await
            .map_err(|error| CanonicalRuntimeError::new(error.to_string()))?;
        let runtime = self
            .insert_or_release_extra(device_id, acquired, false)
            .await
            .map_err(|error| CanonicalRuntimeError::new(error.to_string()))?;
        let canonical: Option<Arc<dyn CanonicalFeedRuntime>> = {
            let entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.get(device_id).map(|entry| {
                let canonical: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
                canonical
            })
        };
        let Some(canonical) = canonical else {
            self.registry.release(device_id, Some(&runtime)).await;
            return Err(CanonicalRuntimeError::new(
                "canonical runtime entry disappeared during acquisition",
            ));
        };
        drop(runtime);
        Ok(canonical)
    }

    fn mark_existing(&self, device_id: &str, legacy: bool) -> Option<Arc<DeviceSessionRuntime>> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = entries.get_mut(device_id)?;
        if legacy {
            entry.legacy = true;
        } else {
            entry.canonical = true;
        }
        Some(entry.runtime.clone())
    }

    fn mark_existing_canonical(
        &self,
        device_id: &str,
    ) -> Result<Option<Arc<dyn CanonicalFeedRuntime>>, CanonicalRuntimeError> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(entry) = entries.get_mut(device_id) else {
            return Ok(None);
        };
        if !entry.canonical {
            entry.canonical_runtime = Arc::new(
                DeviceCanonicalRuntime::new((*entry.runtime).clone())
                    .map_err(|error| CanonicalRuntimeError::new(error.to_string()))?,
            );
            entry.canonical_confirmed = false;
        }
        entry.canonical = true;
        let runtime: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
        Ok(Some(runtime))
    }

    async fn insert_or_release_extra(
        &self,
        device_id: &str,
        acquired: Arc<DeviceSessionRuntime>,
        legacy: bool,
    ) -> Result<Arc<DeviceSessionRuntime>, GatewayWsHubError> {
        let canonical_runtime = match DeviceCanonicalRuntime::new((*acquired).clone()) {
            Ok(runtime) => Arc::new(runtime),
            Err(error) => {
                self.registry.release(device_id, Some(&acquired)).await;
                return Err(GatewayWsHubError::new(error.to_string()));
            }
        };
        let mut release_extra = false;
        let runtime = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(entry) = entries.get_mut(device_id) {
                if legacy {
                    entry.legacy = true;
                } else {
                    entry.canonical = true;
                }
                release_extra = true;
                entry.runtime.clone()
            } else {
                entries.insert(
                    device_id.to_owned(),
                    RuntimePoolEntry {
                        runtime: acquired.clone(),
                        canonical_runtime,
                        legacy,
                        canonical: !legacy,
                        canonical_confirmed: false,
                    },
                );
                acquired.clone()
            }
        };
        if release_extra {
            self.registry.release(device_id, Some(&acquired)).await;
        }
        Ok(runtime)
    }

    async fn release_legacy(&self, device_id: &str, runtime: &Arc<DeviceSessionRuntime>) {
        self.release_role(device_id, runtime, None, true).await;
    }

    fn confirm_canonical(&self, device_id: &str, runtime: &Arc<dyn CanonicalFeedRuntime>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(entry) = entries.get_mut(device_id) else {
            return;
        };
        let candidate: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
        if entry.canonical && Arc::ptr_eq(&candidate, runtime) {
            entry.canonical_confirmed = true;
        }
    }

    fn invalidate_canonical(&self, device_id: &str, runtime: &Arc<dyn CanonicalFeedRuntime>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(entry) = entries.get_mut(device_id) else {
            return;
        };
        let candidate: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
        if entry.canonical && Arc::ptr_eq(&candidate, runtime) {
            entry.canonical = false;
            entry.canonical_confirmed = false;
        }
    }

    async fn release_canonical(
        &self,
        device_id: &str,
        runtime: &Arc<dyn CanonicalFeedRuntime>,
    ) -> bool {
        let concrete = {
            let entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.get(device_id).and_then(|entry| {
                let candidate: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
                Arc::ptr_eq(&candidate, runtime).then(|| entry.runtime.clone())
            })
        };
        if let Some(concrete) = concrete {
            self.release_role(device_id, &concrete, Some(runtime), false)
                .await;
            true
        } else {
            false
        }
    }

    async fn release_unconfirmed_canonical(&self) {
        let releases = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let device_ids = entries
                .iter()
                .filter(|(_, entry)| entry.canonical && !entry.canonical_confirmed)
                .map(|(device_id, _)| device_id.clone())
                .collect::<Vec<_>>();
            let mut releases = Vec::new();
            for device_id in device_ids {
                let Some(entry) = entries.get_mut(&device_id) else {
                    continue;
                };
                entry.canonical = false;
                if !entry.legacy {
                    if let Some(entry) = entries.remove(&device_id) {
                        releases.push((device_id.clone(), entry.runtime));
                    }
                }
            }
            releases
        };
        for (device_id, runtime) in releases {
            self.registry.release(&device_id, Some(&runtime)).await;
        }
    }

    async fn retire(&self, device_id: &str, runtime: &Arc<DeviceSessionRuntime>) {
        let removed = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if entries
                .get(device_id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.runtime, runtime))
            {
                entries.remove(device_id)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            self.registry.release(device_id, Some(&entry.runtime)).await;
        }
    }

    async fn release_role(
        &self,
        device_id: &str,
        runtime: &Arc<DeviceSessionRuntime>,
        canonical: Option<&Arc<dyn CanonicalFeedRuntime>>,
        legacy: bool,
    ) {
        let removed = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(entry) = entries.get_mut(device_id) else {
                return;
            };
            if !Arc::ptr_eq(&entry.runtime, runtime) {
                return;
            }
            if let Some(canonical) = canonical {
                let candidate: Arc<dyn CanonicalFeedRuntime> = entry.canonical_runtime.clone();
                if !Arc::ptr_eq(&candidate, canonical) {
                    return;
                }
            }
            if legacy {
                entry.legacy = false;
            } else {
                entry.canonical = false;
            }
            if !entry.legacy && !entry.canonical {
                entries.remove(device_id)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            self.registry.release(device_id, Some(&entry.runtime)).await;
        }
    }

    async fn runtime(&self, device_id: &str) -> Option<Arc<DeviceSessionRuntime>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(device_id)
            .map(|entry| entry.runtime.clone())
    }

    async fn release_all(&self) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .collect::<Vec<_>>();
        for (device_id, entry) in entries {
            self.registry
                .release(&device_id, Some(&entry.runtime))
                .await;
        }
    }
}

struct RuntimeSubscription {
    runtime: Arc<DeviceSessionRuntime>,
    generation: u64,
    legacy: bool,
    task: JoinHandle<()>,
}

struct ReconnectContext {
    generation: u64,
    attempt: u32,
    max_retries: u32,
    delay: Duration,
    restore_canonical: bool,
}

struct CommandCollector {
    commands: Vec<LegacyRuntimeCommand>,
}

impl LegacyBusinessRuntime for CommandCollector {
    fn dispatch(&mut self, command: LegacyRuntimeCommand) {
        self.commands.push(command);
    }
}

struct GatewaySessionActor {
    session_id: u64,
    hub: std::sync::Weak<GatewayWsHubInner>,
    sender: mpsc::Sender<ActorMessage>,
    receiver: mpsc::Receiver<ActorMessage>,
    abort: SessionAbort,
    tasks: SessionTaskGroup,
    business: Arc<Mutex<LegacyBusinessSession>>,
    canonical: Option<CanonicalFeedSession>,
    legacy_devices: Arc<RwLock<HashSet<String>>>,
    canonical_attached: HashSet<String>,
    outbound: Arc<OutboundQueue>,
    runtimes: Arc<RuntimePool>,
    runtime_subscriptions: HashMap<String, RuntimeSubscription>,
    pending_connects: HashMap<String, u64>,
    snapshots: HashMap<String, StateSnapshot>,
    snapshot_jobs: HashMap<String, u64>,
    reconnects: HashMap<String, ReconnectContext>,
    next_generation: u64,
    close_echoed: bool,
}

impl GatewaySessionActor {
    fn new(
        session_id: u64,
        hub: &Arc<GatewayWsHubInner>,
        sender: mpsc::Sender<ActorMessage>,
        receiver: mpsc::Receiver<ActorMessage>,
        abort: SessionAbort,
        outbound: Arc<OutboundQueue>,
    ) -> Self {
        let config = hub.config.session.clone();
        let runtimes = hub.dependencies.runtimes.clone();
        Self {
            session_id,
            hub: Arc::downgrade(hub),
            sender,
            receiver,
            abort: abort.clone(),
            tasks: SessionTaskGroup::new({
                let task_abort = abort.clone();
                move || {
                    tracing::error!("WebSocket session child task panicked");
                    task_abort.cancel();
                }
            }),
            business: Arc::new(Mutex::new(LegacyBusinessSession::new(config, now_ms()))),
            canonical: None,
            legacy_devices: Arc::new(RwLock::new(HashSet::new())),
            canonical_attached: HashSet::new(),
            outbound,
            runtimes: Arc::new(RuntimePool::new(runtimes)),
            runtime_subscriptions: HashMap::new(),
            pending_connects: HashMap::new(),
            snapshots: HashMap::new(),
            snapshot_jobs: HashMap::new(),
            reconnects: HashMap::new(),
            next_generation: 1,
            close_echoed: false,
        }
    }

    async fn run(mut self, server: GatewaySession, outbound_receiver: mpsc::Receiver<QueuedBatch>) {
        let backpressure = match self.hub.upgrade() {
            Some(hub) => hub.config.backpressure,
            None => {
                self.cleanup().await;
                return;
            }
        };
        let (ipc_sender, mut ipc_receiver) = server.into_split();
        let pump = tokio::spawn(run_outbound_pump(
            ipc_sender,
            outbound_receiver,
            self.outbound.queued_bytes.clone(),
            self.abort.clone(),
            backpressure.timeout_ms,
        ));
        let mut cancelled = self.abort.subscribe();

        if AssertUnwindSafe(self.run_loop(&mut ipc_receiver, &mut cancelled))
            .catch_unwind()
            .await
            .is_err()
        {
            tracing::error!(
                session_id = self.session_id,
                "WebSocket session actor panicked"
            );
            self.abort.cancel();
        }

        self.cleanup().await;
        let hub = self.hub.clone();
        let session_id = self.session_id;
        drop(self.outbound);
        let _ = pump.await;
        if let Some(hub) = hub.upgrade() {
            hub.remove_session(session_id);
        }
    }

    async fn run_loop(
        &mut self,
        ipc_receiver: &mut GatewaySessionReceiver,
        cancelled: &mut watch::Receiver<bool>,
    ) {
        loop {
            let sleep = tokio::time::sleep(Duration::from_millis(self.poll_delay_ms()));
            tokio::pin!(sleep);
            tokio::select! {
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        break;
                    }
                }
                frame = ipc_receiver.recv() => {
                    let Some(frame) = frame else { break; };
                    let stop = tokio::select! {
                        changed = cancelled.changed() => changed.is_err() || *cancelled.borrow(),
                        stop = self.handle_transport_frame(frame) => stop,
                    };
                    if stop {
                        break;
                    }
                }
                message = self.receiver.recv() => {
                    let Some(message) = message else { break; };
                    let stop = tokio::select! {
                        changed = cancelled.changed() => changed.is_err() || *cancelled.borrow(),
                        stop = self.handle_actor_message(message) => stop,
                    };
                    if stop {
                        break;
                    }
                }
                () = &mut sleep => {
                    self.poll_sessions();
                }
            }
            if self.abort.is_cancelled() {
                break;
            }
            self.tasks.reap();
        }
    }

    fn poll_delay_ms(&self) -> u64 {
        let now = now_ms();
        let business_deadline = self
            .business
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next_deadline_ms();
        let canonical_deadline = self
            .canonical
            .as_ref()
            .and_then(CanonicalFeedSession::next_deadline_ms);
        business_deadline
            .into_iter()
            .chain(canonical_deadline)
            .min()
            .map(|deadline| deadline.saturating_sub(now).max(1))
            .unwrap_or(ACTOR_IDLE_POLL_MS)
    }

    fn next_generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        generation
    }

    async fn handle_transport_frame(&mut self, frame: GatewayFrame) -> bool {
        match frame {
            GatewayFrame::Text(_) | GatewayFrame::Pong(_) => false,
            GatewayFrame::Ping(payload) => {
                self.outbound().enqueue_control(GatewayFrame::Pong(payload));
                false
            }
            GatewayFrame::Close(frame) => {
                if !self.close_echoed {
                    self.close_echoed = true;
                    self.outbound().enqueue_control(GatewayFrame::Close(frame));
                }
                true
            }
            GatewayFrame::Binary(frame) => {
                let (events, commands) = {
                    let mut business = self
                        .business
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let maximum = business.wire().outbound_max_frame_bytes();
                    let mut sink = SessionFrameSink {
                        outbound: self.outbound().clone(),
                        maximum,
                    };
                    let mut runtime = CommandCollector {
                        commands: Vec::new(),
                    };
                    let result = business.receive_frame(&frame, now_ms(), &mut runtime, &mut sink);
                    match result {
                        Ok(events) => (events, runtime.commands),
                        Err(error) => {
                            let _ = business.send_protocol_error(None, error, &mut sink);
                            (Vec::new(), runtime.commands)
                        }
                    }
                };
                self.process_business_events(events).await;
                self.dispatch_runtime_commands(commands).await;
                false
            }
        }
    }

    async fn handle_actor_message(&mut self, message: ActorMessage) -> bool {
        match message {
            ActorMessage::Shutdown { close } => {
                if let Some(close) = close {
                    let delivered = self.outbound().enqueue_close(close);
                    if let Some(delivered) = delivered {
                        let timeout_ms = self
                            .hub
                            .upgrade()
                            .map(|hub| hub.config.backpressure.timeout_ms)
                            .unwrap_or(GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS);
                        let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), delivered)
                            .await;
                    }
                }
                return true;
            }
            ActorMessage::Poll => self.poll_sessions(),
            ActorMessage::Broadcast(event) => self.handle_broadcast(event).await,
            ActorMessage::RuntimeEvent {
                device_id,
                generation,
                event,
            } => {
                if self.runtime_generation_matches(&device_id, generation) {
                    self.handle_runtime_event(&device_id, generation, event)
                        .await;
                }
            }
            ActorMessage::RuntimeEventsLagged {
                device_id,
                generation,
            } => {
                if self.runtime_generation_matches(&device_id, generation) {
                    if let Some(runtime) = self.runtimes.runtime(&device_id).await {
                        let _ = runtime.request_snapshot();
                    }
                    if let Some(canonical) = self.canonical.as_mut() {
                        canonical.detach_device(&device_id);
                    }
                    if let Ok(runtime) = self.runtimes.acquire_canonical(&device_id).await {
                        let _ = self.attach_canonical_device(device_id, runtime).await;
                    }
                }
            }
            ActorMessage::ConnectCompleted {
                device_id,
                generation,
                result,
            } => {
                self.handle_connect_completed(device_id, generation, result)
                    .await;
            }
            ActorMessage::PreparedSnapshot {
                device_id,
                generation,
                job,
                mut snapshot,
            } => {
                if self.runtime_generation_matches(&device_id, generation)
                    && self.snapshot_jobs.get(&device_id).copied() == Some(job)
                {
                    if let Some(hub) = self.hub.upgrade() {
                        snapshot = hub.record_snapshot(snapshot);
                    }
                    self.snapshots.insert(device_id.clone(), snapshot.clone());
                    let canonical = self.canonical_attached.contains(&device_id);
                    let mut business = self
                        .business
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if canonical {
                        business.update_snapshot_without_send(snapshot);
                    } else {
                        let maximum = business.wire().outbound_max_frame_bytes();
                        let mut sink = SessionFrameSink {
                            outbound: self.outbound().clone(),
                            maximum,
                        };
                        let _ = business.receive_snapshot(snapshot, &mut sink);
                    }
                }
            }
            ActorMessage::ReconnectCompleted {
                device_id,
                generation,
                attempt,
                result,
            } => {
                self.handle_reconnect_completed(device_id, generation, attempt, result)
                    .await;
            }
            ActorMessage::CreateWindowCompleted {
                device_id,
                generation,
                completion_id,
                window_id,
            } => {
                if self.runtime_generation_matches(&device_id, generation) {
                    let mut business = self
                        .business
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let maximum = business.wire().outbound_max_frame_bytes();
                    let mut sink = SessionFrameSink {
                        outbound: self.outbound().clone(),
                        maximum,
                    };
                    let _ = business.complete_create_window(completion_id, window_id, &mut sink);
                }
            }
            ActorMessage::HistoryCompleted {
                device_id,
                generation,
                pane_id,
                request_token,
                history,
            } => {
                if self.runtime_generation_matches(&device_id, generation) {
                    let mut business = self
                        .business
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let maximum = business.wire().outbound_max_frame_bytes();
                    let mut sink = SessionFrameSink {
                        outbound: self.outbound().clone(),
                        maximum,
                    };
                    let _ = business.complete_pane_history_request(
                        &device_id,
                        &pane_id,
                        request_token,
                        history,
                        &mut sink,
                    );
                }
            }
            ActorMessage::AgentSyncCompleted {
                session_id,
                generation,
                payload,
            } => {
                let mut business = self
                    .business
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let maximum = business.wire().outbound_max_frame_bytes();
                let mut sink = SessionFrameSink {
                    outbound: self.outbound().clone(),
                    maximum,
                };
                let _ = business.complete_agent_sync(&session_id, generation, payload, &mut sink);
            }
            ActorMessage::CanonicalAttached { device_id } => {
                self.canonical_attached.insert(device_id.clone());
                if !self.runtime_subscriptions.contains_key(&device_id) {
                    if let Some(runtime) = self.runtimes.runtime(&device_id).await {
                        let generation = self.next_generation();
                        self.start_runtime_subscription(
                            device_id.clone(),
                            generation,
                            runtime.clone(),
                            false,
                        );
                        Self::register_and_apply_current_theme(
                            self.hub.clone(),
                            device_id.clone(),
                            runtime.clone(),
                        )
                        .await;
                    }
                }
            }
            ActorMessage::CanonicalDetached { device_id, runtime } => {
                if !self.runtimes.release_canonical(&device_id, &runtime).await {
                    return false;
                }
                self.canonical_attached.remove(&device_id);
                let remove = self
                    .runtime_subscriptions
                    .get(&device_id)
                    .is_some_and(|subscription| !subscription.legacy);
                if remove {
                    if let Some(subscription) = self.runtime_subscriptions.remove(&device_id) {
                        subscription.task.abort();
                        let _ = subscription.task.await;
                    }
                    self.snapshots.remove(&device_id);
                    self.snapshot_jobs.remove(&device_id);
                }
            }
            ActorMessage::ThemePersisted { theme } => {
                if let Some(hub) = self.hub.upgrade() {
                    hub.schedule_theme_apply(theme);
                    let timestamp = next_timestamp(&hub.last_theme_timestamp);
                    hub.broadcast(HubBroadcast::SiteTheme(SiteThemeUpdateS2c {
                        theme: match theme {
                            ThemeMode::Dark => SITE_THEME_DARK,
                            ThemeMode::Light => SITE_THEME_LIGHT,
                        },
                        server_timestamp: timestamp,
                    }));
                    hub.broadcast(HubBroadcast::Settings(SettingsUpdateS2c {
                        namespace: "theme".to_owned(),
                        server_timestamp: next_timestamp(&hub.last_settings_timestamp),
                    }));
                }
            }
            #[cfg(test)]
            ActorMessage::PanicForTest => panic!("WebSocket actor test panic"),
        }
        false
    }

    async fn process_business_events(&mut self, events: Vec<LegacyBusinessEvent>) {
        for event in events {
            match event {
                LegacyBusinessEvent::Unhandled(envelope) => {
                    self.handle_canonical_command(envelope).await;
                }
                LegacyBusinessEvent::DetachDevice { device_id } => {
                    self.detach_device_runtime(&device_id).await;
                }
                LegacyBusinessEvent::Warning { kind, message } => {
                    tracing::warn!(kind = kind.as_str(), %message, "legacy WebSocket message ignored");
                }
                LegacyBusinessEvent::Negotiated
                | LegacyBusinessEvent::Barrier(_)
                | LegacyBusinessEvent::Closed => {}
            }
        }
    }

    fn poll_sessions(&mut self) {
        let now = now_ms();
        {
            let mut business = self
                .business
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let maximum = business.wire().outbound_max_frame_bytes();
            let mut sink = SessionFrameSink {
                outbound: self.outbound().clone(),
                maximum,
            };
            let _ = business.poll(now, &mut sink);
        }
        if let Some(canonical) = self.canonical.as_mut() {
            canonical.advance(now);
        }
    }

    async fn handle_canonical_command(&mut self, envelope: Envelope) {
        let decoded = match decode_canonical_command(&envelope.payload) {
            Ok(decoded) => decoded.command,
            Err(error) => {
                self.send_protocol_error(Some(envelope.seq), SessionProtocolError::from(error));
                return;
            }
        };
        if self.canonical.is_none() {
            if let Err(error) = self.create_canonical_session() {
                self.send_protocol_error(
                    Some(envelope.seq),
                    SessionProtocolError::new(
                        tmex_protocol::ProtocolErrorCode::Internal,
                        error.to_string(),
                        false,
                    ),
                );
                return;
            }
        }
        let Some(canonical) = self.canonical.as_mut() else {
            self.send_protocol_error(
                Some(envelope.seq),
                SessionProtocolError::new(
                    tmex_protocol::ProtocolErrorCode::Internal,
                    "canonical session is unavailable",
                    false,
                ),
            );
            return;
        };
        let result = canonical.handle_command(decoded).await;
        self.runtimes.release_unconfirmed_canonical().await;
        if let Err(error) = result {
            self.send_protocol_error(
                Some(envelope.seq),
                SessionProtocolError::new(
                    tmex_protocol::ProtocolErrorCode::Internal,
                    error.to_string(),
                    false,
                ),
            );
        }
    }

    fn create_canonical_session(&mut self) -> Result<(), GatewayWsHubError> {
        let maximum = self
            .business
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .wire()
            .outbound_max_frame_bytes();
        let business = self.business.clone();
        let outbound = self.outbound().clone();
        let resolver_pool = self.runtimes.clone();
        let attach_pool = self.runtimes.clone();
        let detach_pool = self.runtimes.clone();
        let tasks = self.tasks.clone();
        let poll_sender = self.sender.clone();
        let attach_sender = self.sender.clone();
        let detach_sender = self.sender.clone();
        let abort = self.abort.clone();
        let poll_abort = self.abort.clone();
        let attach_abort = self.abort.clone();
        let detach_abort = self.abort.clone();
        let initial_devices = self.legacy_devices.clone();
        let options = CanonicalFeedSessionOptions {
            max_frame_bytes: maximum,
            gateway_epoch: rand::random(),
            send_event: Arc::new(move |event: CanonicalEvent| {
                let mut business = business
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let maximum = business.wire().outbound_max_frame_bytes();
                let mut sink = SessionFrameSink {
                    outbound: outbound.clone(),
                    maximum,
                };
                business
                    .send_canonical_event(event, &mut sink)
                    .unwrap_or_else(|_| {
                        abort.cancel();
                        false
                    })
            }),
            resolve_runtime: Arc::new(move |device_id| {
                let pool = resolver_pool.clone();
                Box::pin(async move { pool.acquire_canonical(&device_id).await.map(Some) })
            }),
            spawn_task: Arc::new(move |task| {
                tasks.spawn(task);
            }),
            request_poll: Arc::new(move || {
                if poll_sender.try_send(ActorMessage::Poll).is_err() {
                    poll_abort.cancel();
                }
            }),
            now_ms: Arc::new(now_ms),
            create_snapshot_id: Arc::new(rand::random),
            initial_device_ids: Some(Arc::new(move || {
                initial_devices
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .iter()
                    .cloned()
                    .collect()
            })),
            on_device_attached: Some(Arc::new(move |device_id, runtime| {
                attach_pool.confirm_canonical(device_id, &runtime);
                if attach_sender
                    .try_send(ActorMessage::CanonicalAttached {
                        device_id: device_id.to_owned(),
                    })
                    .is_err()
                {
                    attach_abort.cancel();
                }
            })),
            on_device_detached: Some(Arc::new(move |device_id, runtime| {
                detach_pool.invalidate_canonical(device_id, &runtime);
                if detach_sender
                    .try_send(ActorMessage::CanonicalDetached {
                        device_id: device_id.to_owned(),
                        runtime,
                    })
                    .is_err()
                {
                    detach_abort.cancel();
                }
            })),
            max_pending_pane_gaps: None,
        };
        self.canonical = Some(
            CanonicalFeedSession::new(options)
                .map_err(|error| GatewayWsHubError::new(error.to_string()))?,
        );
        Ok(())
    }

    fn send_protocol_error(&self, ref_seq: Option<u32>, error: SessionProtocolError) {
        let mut business = self
            .business
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let maximum = business.wire().outbound_max_frame_bytes();
        let mut sink = SessionFrameSink {
            outbound: self.outbound().clone(),
            maximum,
        };
        let _ = business.send_protocol_error(ref_seq, error, &mut sink);
    }

    fn outbound(&self) -> &Arc<OutboundQueue> {
        &self.outbound
    }

    fn runtime_generation_matches(&self, device_id: &str, generation: u64) -> bool {
        self.runtime_subscriptions
            .get(device_id)
            .is_some_and(|subscription| subscription.generation == generation)
    }
}

impl GatewaySessionActor {
    async fn handle_broadcast(&mut self, event: HubBroadcast) {
        match event {
            HubBroadcast::Device(event) => {
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_device_event(event, &mut sink);
            }
            HubBroadcast::Agent(event) => {
                let Ok((event_type, payload)) = encode_agent_event(&event.event) else {
                    return;
                };
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_agent_event(
                    &event.session_id,
                    u32::try_from(event.seq).unwrap_or(u32::MAX),
                    event_type,
                    payload,
                    &mut sink,
                );
            }
            HubBroadcast::Watch(event) => {
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_watch_event(
                    &event.rule_id,
                    &event.device_id,
                    &event.pane_id,
                    event.event_type,
                    event.payload,
                    &mut sink,
                );
            }
            HubBroadcast::SiteTheme(update) => {
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_site_theme_update(update, &mut sink);
            }
            HubBroadcast::Settings(update) => {
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_settings_update(update, &mut sink);
            }
            HubBroadcast::Notify(event) => {
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let _ = business.receive_notify_event(event, &mut sink);
            }
            HubBroadcast::TreeOrder(change) => match change {
                GatewayTreeOrderChange::Windows {
                    device_id,
                    window_ids,
                } => self.apply_window_order(&device_id, &window_ids),
                GatewayTreeOrderChange::Panes {
                    device_id,
                    window_id,
                    pane_ids,
                } => self.apply_pane_order(&device_id, &window_id, &pane_ids),
            },
            HubBroadcast::TreeCustomName {
                device_id,
                kind,
                native_id,
                name,
            } => self.apply_custom_name_overlay(&device_id, kind, &native_id, name.as_deref()),
        }
    }

    async fn handle_runtime_event(
        &mut self,
        device_id: &str,
        generation: u64,
        event: TmuxRuntimeEvent,
    ) {
        match event {
            TmuxRuntimeEvent::Connected { .. } => {}
            TmuxRuntimeEvent::Reconnecting { attempt, .. } => {
                self.send_device_event(DeviceEvent {
                    device_id: device_id.to_owned(),
                    event_type: 3,
                    error_type: Some("reconnecting".to_owned()),
                    message: Some(format!("Reconnecting (attempt {attempt})")),
                    raw_message: None,
                });
            }
            TmuxRuntimeEvent::Closed { .. } => {
                self.handle_runtime_closed(device_id, generation).await;
            }
            TmuxRuntimeEvent::Error { message, .. } => {
                self.send_runtime_error(device_id, message);
            }
            TmuxRuntimeEvent::Snapshot(snapshot) => {
                self.spawn_prepare_snapshot(device_id.to_owned(), generation, snapshot);
            }
            TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Patch(patch)) => {
                let mut current_snapshot = self.snapshots.get_mut(device_id).map(|snapshot| {
                    apply_metadata_patch(snapshot, &patch);
                    snapshot.clone()
                });
                if let Some(snapshot) = current_snapshot.take() {
                    let snapshot = self
                        .hub
                        .upgrade()
                        .map_or(snapshot.clone(), |hub| hub.record_snapshot(snapshot));
                    self.snapshots
                        .insert(device_id.to_owned(), snapshot.clone());
                    current_snapshot = Some(snapshot);
                }
                if !self.canonical_attached.contains(device_id) {
                    if let Some(diff) = legacy_metadata_diff(device_id, &patch) {
                        let mut business = self.business_lock();
                        let mut sink = self.frame_sink(&business);
                        let _ = business.receive_snapshot_diff(diff, current_snapshot, &mut sink);
                    }
                }
            }
            TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Rebase(_)) => {
                if let Some(runtime) = self.runtimes.runtime(device_id).await {
                    if let Ok(Some(snapshot)) = runtime.current_snapshot().await {
                        self.spawn_prepare_snapshot(device_id.to_owned(), generation, snapshot);
                    }
                }
            }
            TmuxRuntimeEvent::Terminal(segment) => {
                if !self.canonical_attached.contains(device_id) {
                    let mut business = self.business_lock();
                    let mut sink = self.frame_sink(&business);
                    let _ = business.receive_terminal_output(
                        device_id,
                        &segment.pane_id,
                        &segment.data,
                        now_ms(),
                        &mut sink,
                    );
                }
            }
            TmuxRuntimeEvent::TerminalHistory { pane_id, history } => {
                if !self.canonical_attached.contains(device_id) {
                    self.send_terminal_history(device_id, &pane_id, history);
                }
            }
            TmuxRuntimeEvent::PaneActivated { window_id, pane_id } => {
                self.send_tmux_payload(
                    device_id,
                    7,
                    encode_payload(&PaneActiveEvent { window_id, pane_id }).ok(),
                    LegacyTmuxEventDelivery::Broadcast,
                );
            }
            TmuxRuntimeEvent::ClipboardWrite { pane_id, text } => {
                let clipboard = ClipboardWrite {
                    device_id: device_id.to_owned(),
                    pane_id,
                    text,
                };
                let canonical = self.canonical_attached.contains(device_id);
                let mut business = self.business_lock();
                let mut sink = self.frame_sink(&business);
                let result = if canonical {
                    business.receive_clipboard_write_unfiltered(clipboard, &mut sink)
                } else {
                    business.receive_clipboard_write(clipboard, &mut sink)
                };
                let _ = result;
            }
            TmuxRuntimeEvent::SourceMetadata(_) => {}
            TmuxRuntimeEvent::Bell { pane_id } => {
                self.send_bell_event(device_id, &pane_id).await;
            }
            TmuxRuntimeEvent::Notification {
                pane_id,
                notification,
            } => {
                self.send_notification_event(device_id, &pane_id, notification)
                    .await;
            }
            TmuxRuntimeEvent::Lifecycle(_) => {}
            TmuxRuntimeEvent::ReplayGap(_)
            | TmuxRuntimeEvent::History(_)
            | TmuxRuntimeEvent::PromptMarker { .. }
            | TmuxRuntimeEvent::Title { .. } => {}
        }
    }

    fn send_device_event(&self, event: DeviceEvent) {
        let mut business = self.business_lock();
        let mut sink = self.frame_sink(&business);
        let _ = business.receive_device_event(event, &mut sink);
    }

    fn send_terminal_history(
        &self,
        device_id: &str,
        pane_id: &str,
        history: CapturedTerminalHistory,
    ) {
        let history = CapturedPaneHistory {
            data: history.data.into_bytes(),
            alternate_screen: history.alternate_screen,
            modes: history.modes,
        };
        let mut business = self.business_lock();
        let mut sink = self.frame_sink(&business);
        let _ =
            business.receive_terminal_history(device_id, pane_id, &history, now_ms(), &mut sink);
    }

    fn send_tmux_payload(
        &self,
        device_id: &str,
        event_type: u8,
        event_data: Option<Vec<u8>>,
        delivery: LegacyTmuxEventDelivery,
    ) {
        let Some(event_data) = event_data else {
            return;
        };
        let mut business = self.business_lock();
        let mut sink = self.frame_sink(&business);
        let _ = business.receive_tmux_event(
            TmuxEvent {
                device_id: device_id.to_owned(),
                event_type,
                event_data,
            },
            delivery,
            now_ms(),
            &mut sink,
        );
    }

    fn business_lock(&self) -> std::sync::MutexGuard<'_, LegacyBusinessSession> {
        self.business
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn frame_sink(&self, business: &LegacyBusinessSession) -> SessionFrameSink {
        SessionFrameSink {
            outbound: self.outbound().clone(),
            maximum: business.wire().outbound_max_frame_bytes(),
        }
    }
}

impl GatewaySessionActor {
    async fn dispatch_runtime_commands(&mut self, commands: Vec<LegacyRuntimeCommand>) {
        for command in commands {
            match command {
                LegacyRuntimeCommand::ConnectDevice { device_id } => {
                    self.connect_device(device_id).await;
                }
                LegacyRuntimeCommand::DisconnectDevice { device_id } => {
                    if let Some(canonical) = self.canonical.as_mut() {
                        canonical.detach_device(&device_id);
                    }
                    self.detach_device_runtime(&device_id).await;
                }
                LegacyRuntimeCommand::RequestSnapshot { device_id } => {
                    if let Some(runtime) = self.runtimes.runtime(&device_id).await {
                        if let Err(error) = runtime.request_snapshot() {
                            self.send_runtime_error(&device_id, error.to_string());
                        }
                    }
                }
                LegacyRuntimeCommand::SelectWindow {
                    device_id,
                    window_id,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.select_window(&window_id).await
                    });
                }
                LegacyRuntimeCommand::SelectPane {
                    device_id,
                    window_id,
                    pane_id,
                    size,
                } => {
                    if let Some((runtime, generation)) = self.runtime_with_generation(&device_id) {
                        match runtime
                            .enqueue_select_pane(&window_id, &pane_id, size)
                            .await
                        {
                            Ok(completion) => {
                                let sender = self.sender.clone();
                                self.tasks.spawn(async move {
                                    let event = match completion.wait().await {
                                        Ok(()) => {
                                            if let Err(error) =
                                                runtime.fetch_pane_history(&pane_id).await
                                            {
                                                let _ = sender
                                                    .send(runtime_error_event(
                                                        device_id.clone(),
                                                        generation,
                                                        error,
                                                    ))
                                                    .await;
                                            }
                                            TmuxRuntimeEvent::PaneActivated { window_id, pane_id }
                                        }
                                        Err(error) => TmuxRuntimeEvent::Error {
                                            device_id: device_id.clone(),
                                            message: error.to_string(),
                                        },
                                    };
                                    let _ = sender
                                        .send(ActorMessage::RuntimeEvent {
                                            device_id,
                                            generation,
                                            event,
                                        })
                                        .await;
                                });
                            }
                            Err(error) => {
                                self.send_runtime_error(&device_id, error.to_string());
                            }
                        }
                    }
                }
                LegacyRuntimeCommand::CreateWindow {
                    completion_id,
                    device_id,
                    name,
                    cwd,
                } => {
                    if let Some((runtime, generation)) = self.runtime_with_generation(&device_id) {
                        let sender = self.sender.clone();
                        let completed_device_id = device_id.clone();
                        self.tasks.spawn(async move {
                            let window_id = match runtime
                                .create_window(name.as_deref(), cwd.as_deref())
                                .await
                            {
                                Ok(window_id) => window_id,
                                Err(error) => {
                                    let _ = sender
                                        .send(runtime_error_event(
                                            completed_device_id.clone(),
                                            generation,
                                            error,
                                        ))
                                        .await;
                                    None
                                }
                            };
                            let _ = sender
                                .send(ActorMessage::CreateWindowCompleted {
                                    device_id: completed_device_id,
                                    generation,
                                    completion_id,
                                    window_id,
                                })
                                .await;
                        });
                    }
                }
                LegacyRuntimeCommand::CloseWindow {
                    device_id,
                    window_id,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.close_window(&window_id).await
                    });
                }
                LegacyRuntimeCommand::ClosePane { device_id, pane_id } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.close_pane(&pane_id).await
                    });
                }
                LegacyRuntimeCommand::RenameWindow {
                    device_id,
                    window_id,
                    name,
                } => {
                    if let Some(hub) = self.hub.upgrade() {
                        let _ = hub
                            .apply_tree_custom_name(
                                &device_id,
                                ProjectionEntityKind::Window,
                                &window_id,
                                name,
                            )
                            .await;
                    } else {
                        self.apply_custom_name_overlay(
                            &device_id,
                            ProjectionEntityKind::Window,
                            &window_id,
                            name.as_deref(),
                        );
                    }
                }
                LegacyRuntimeCommand::SetWindowStyle { device_id, style } => {
                    let hub = self.hub.clone();
                    let signal_device_id = device_id.clone();
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        set_window_style_and_broadcast_theme(hub, signal_device_id, runtime, style)
                            .await
                    });
                }
                LegacyRuntimeCommand::ReorderWindows {
                    device_id,
                    window_ids,
                } => {
                    if let Some(hub) = self.hub.upgrade() {
                        let repository = hub.dependencies.repository.clone();
                        self.tasks.spawn(async move {
                            if repository
                                .set_window_order(&device_id, &window_ids)
                                .await
                                .is_ok()
                            {
                                hub.apply_tree_order(GatewayTreeOrderChange::Windows {
                                    device_id,
                                    window_ids,
                                });
                            }
                        });
                    }
                }
                LegacyRuntimeCommand::ReorderPanes {
                    device_id,
                    window_id,
                    pane_ids,
                } => {
                    if let Some(hub) = self.hub.upgrade() {
                        let repository = hub.dependencies.repository.clone();
                        self.tasks.spawn(async move {
                            if repository
                                .set_pane_order(&device_id, &window_id, &pane_ids)
                                .await
                                .is_ok()
                            {
                                hub.apply_tree_order(GatewayTreeOrderChange::Panes {
                                    device_id,
                                    window_id,
                                    pane_ids,
                                });
                            }
                        });
                    }
                }
                LegacyRuntimeCommand::ApplyStackedLayout {
                    device_id,
                    window_id,
                    cols,
                    rows,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.apply_stacked_layout(&window_id, cols, rows).await
                    });
                }
                LegacyRuntimeCommand::SplitPane {
                    device_id,
                    pane_id,
                    direction,
                    cwd,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime
                            .split_pane(
                                &pane_id,
                                match direction {
                                    LegacySplitDirection::Horizontal => SplitDirection::Horizontal,
                                    LegacySplitDirection::Vertical => SplitDirection::Vertical,
                                },
                                cwd.as_deref(),
                            )
                            .await
                            .map(|_| ())
                    });
                }
                LegacyRuntimeCommand::FocusPane {
                    device_id,
                    window_id,
                    pane_id,
                } => {
                    if let Some((runtime, generation)) = self.runtime_with_generation(&device_id) {
                        match runtime
                            .enqueue_select_pane(&window_id, &pane_id, None)
                            .await
                        {
                            Ok(completion) => {
                                let sender = self.sender.clone();
                                self.tasks.spawn(async move {
                                    let event = match completion.wait().await {
                                        Ok(()) => {
                                            TmuxRuntimeEvent::PaneActivated { window_id, pane_id }
                                        }
                                        Err(error) => TmuxRuntimeEvent::Error {
                                            device_id: device_id.clone(),
                                            message: error.to_string(),
                                        },
                                    };
                                    let _ = sender
                                        .send(ActorMessage::RuntimeEvent {
                                            device_id,
                                            generation,
                                            event,
                                        })
                                        .await;
                                });
                            }
                            Err(error) => {
                                self.send_runtime_error(&device_id, error.to_string());
                            }
                        }
                    }
                }
                LegacyRuntimeCommand::RenamePane {
                    device_id,
                    pane_id,
                    name,
                } => {
                    if let Some(hub) = self.hub.upgrade() {
                        let _ = hub
                            .apply_tree_custom_name(
                                &device_id,
                                ProjectionEntityKind::Pane,
                                &pane_id,
                                name,
                            )
                            .await;
                    } else {
                        self.apply_custom_name_overlay(
                            &device_id,
                            ProjectionEntityKind::Pane,
                            &pane_id,
                            name.as_deref(),
                        );
                    }
                }
                LegacyRuntimeCommand::MovePane {
                    device_id,
                    source_pane_id,
                    destination_pane_id,
                    position,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime
                            .move_pane(
                                &source_pane_id,
                                &destination_pane_id,
                                match position {
                                    LegacyPanePosition::Left => MovePanePosition::Left,
                                    LegacyPanePosition::Right => MovePanePosition::Right,
                                    LegacyPanePosition::Top => MovePanePosition::Top,
                                    LegacyPanePosition::Bottom => MovePanePosition::Bottom,
                                },
                            )
                            .await
                    });
                }
                LegacyRuntimeCommand::BreakPane { device_id, pane_id } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.break_pane(&pane_id).await.map(|_| ())
                    });
                }
                LegacyRuntimeCommand::SendInput {
                    device_id,
                    pane_id,
                    data,
                } => {
                    if let Some(runtime) = self
                        .runtime_subscriptions
                        .get(&device_id)
                        .map(|subscription| subscription.runtime.clone())
                    {
                        if let Err(error) =
                            runtime.enqueue_input_bytes(&pane_id, data.as_bytes()).await
                        {
                            self.send_runtime_error(&device_id, error.to_string());
                        }
                    }
                }
                LegacyRuntimeCommand::SendKey {
                    device_id,
                    pane_id,
                    key,
                    modifiers,
                    action,
                } => {
                    if let Some(runtime) = self
                        .runtime_subscriptions
                        .get(&device_id)
                        .map(|subscription| subscription.runtime.clone())
                    {
                        if let Err(error) = runtime
                            .send_key_input(&pane_id, key, modifiers, action)
                            .await
                        {
                            self.send_runtime_error(&device_id, error.to_string());
                        }
                    }
                }
                LegacyRuntimeCommand::SendInputBatch {
                    device_id,
                    pane_id,
                    chunks,
                } => {
                    if let Some(runtime) = self
                        .runtime_subscriptions
                        .get(&device_id)
                        .map(|subscription| subscription.runtime.clone())
                    {
                        let chunks = chunks
                            .into_iter()
                            .map(String::into_bytes)
                            .collect::<Vec<_>>();
                        if let Err(error) = runtime.enqueue_input_batch(&pane_id, chunks).await {
                            self.send_runtime_error(&device_id, error.to_string());
                        }
                    }
                }
                LegacyRuntimeCommand::ResizeWindow {
                    device_id,
                    window_id,
                    cols,
                    rows,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.resize_window(&window_id, cols, rows).await
                    });
                }
                LegacyRuntimeCommand::ResizePane {
                    device_id,
                    pane_id,
                    cols,
                    rows,
                } => {
                    if let Some(runtime) = self
                        .runtime_subscriptions
                        .get(&device_id)
                        .map(|subscription| subscription.runtime.clone())
                    {
                        if let Err(error) = runtime
                            .enqueue_resize_window_for_pane(&pane_id, cols, rows)
                            .await
                        {
                            self.send_runtime_error(&device_id, error.to_string());
                        }
                    }
                }
                LegacyRuntimeCommand::ResizePaneById {
                    device_id,
                    pane_id,
                    cols,
                    rows,
                } => {
                    self.spawn_runtime_action(&device_id, move |runtime| async move {
                        runtime.resize_pane(&pane_id, cols, rows).await
                    });
                }
                LegacyRuntimeCommand::FetchPaneHistory {
                    device_id,
                    pane_id,
                    request_token,
                } => {
                    if let Some((runtime, generation)) = self.runtime_with_generation(&device_id) {
                        let sender = self.sender.clone();
                        let completed_device_id = device_id.clone();
                        self.tasks.spawn(async move {
                            let history = match runtime.fetch_pane_history(&pane_id).await {
                                Ok(history) => history.map(|history| CapturedPaneHistory {
                                    data: history.data.into_bytes(),
                                    alternate_screen: history.alternate_screen,
                                    modes: history.modes,
                                }),
                                Err(error) => {
                                    let _ = sender
                                        .send(runtime_error_event(
                                            completed_device_id.clone(),
                                            generation,
                                            error,
                                        ))
                                        .await;
                                    None
                                }
                            };
                            let _ = sender
                                .send(ActorMessage::HistoryCompleted {
                                    device_id: completed_device_id,
                                    generation,
                                    pane_id,
                                    request_token,
                                    history,
                                })
                                .await;
                        });
                    }
                }
                LegacyRuntimeCommand::LoadAgentSync {
                    session_id,
                    generation,
                } => {
                    let provider = self.hub.upgrade().and_then(|hub| hub.agent_sync_provider());
                    if let Some(provider) = provider {
                        let sender = self.sender.clone();
                        self.tasks.spawn(async move {
                            let payload = provider
                                .sync_snapshot(&session_id, generation)
                                .await
                                .ok()
                                .and_then(|sync| sync.snapshot)
                                .and_then(|snapshot| encode_agent_sync(snapshot).ok());
                            let _ = sender
                                .send(ActorMessage::AgentSyncCompleted {
                                    session_id,
                                    generation,
                                    payload,
                                })
                                .await;
                        });
                    }
                }
                LegacyRuntimeCommand::UpdateSiteTheme { theme } => {
                    let Some(theme) = (match theme {
                        SITE_THEME_DARK => Some(ThemeMode::Dark),
                        SITE_THEME_LIGHT => Some(ThemeMode::Light),
                        _ => None,
                    }) else {
                        continue;
                    };
                    if let Some(hub) = self.hub.upgrade() {
                        let repository = hub.dependencies.repository.clone();
                        let defaults = hub.dependencies.site_settings_defaults.clone();
                        let sender = self.sender.clone();
                        self.tasks.spawn(async move {
                            if repository
                                .update_site_settings(
                                    &defaults,
                                    SiteSettingsUpdate {
                                        theme: Some(
                                            match theme {
                                                ThemeMode::Dark => "dark",
                                                ThemeMode::Light => "light",
                                            }
                                            .to_owned(),
                                        ),
                                        ..SiteSettingsUpdate::default()
                                    },
                                )
                                .await
                                .is_ok()
                            {
                                let _ = sender.send(ActorMessage::ThemePersisted { theme }).await;
                            }
                        });
                    }
                }
            }
        }
    }

    async fn connect_device(&mut self, device_id: String) {
        if self.runtime_subscriptions.contains_key(&device_id) {
            let Ok(runtime) = self.runtimes.acquire_legacy(&device_id).await else {
                return;
            };
            if let Some(subscription) = self.runtime_subscriptions.get_mut(&device_id) {
                subscription.legacy = true;
            }
            let snapshot = self.snapshots.get(&device_id).cloned();
            self.finish_device_connected(device_id, runtime, snapshot)
                .await;
            return;
        }
        if self.pending_connects.contains_key(&device_id) {
            return;
        }
        let generation = self.next_generation();
        self.pending_connects.insert(device_id.clone(), generation);
        let pool = self.runtimes.clone();
        let sender = self.sender.clone();
        let abort = self.abort.clone();
        self.tasks.spawn(async move {
            let result = match pool.acquire_legacy(&device_id).await {
                Ok(runtime) => match runtime.current_snapshot().await {
                    Ok(snapshot) => Ok((runtime, snapshot)),
                    Err(error) => {
                        pool.release_legacy(&device_id, &runtime).await;
                        Err(GatewayWsHubError::new(error.to_string()))
                    }
                },
                Err(error) => Err(error),
            };
            let acquired = result.as_ref().ok().map(|(runtime, _)| runtime.clone());
            if sender
                .send(ActorMessage::ConnectCompleted {
                    device_id: device_id.clone(),
                    generation,
                    result,
                })
                .await
                .is_err()
            {
                if let Some(runtime) = acquired {
                    pool.release_legacy(&device_id, &runtime).await;
                }
                abort.cancel();
            }
        });
    }

    async fn handle_connect_completed(
        &mut self,
        device_id: String,
        generation: u64,
        result: Result<(Arc<DeviceSessionRuntime>, Option<StateSnapshot>), GatewayWsHubError>,
    ) {
        if self.pending_connects.get(&device_id).copied() != Some(generation) {
            if let Ok((runtime, _)) = result {
                self.runtimes.release_legacy(&device_id, &runtime).await;
            }
            return;
        }
        self.pending_connects.remove(&device_id);
        let (runtime, snapshot) = match result {
            Ok(result) => result,
            Err(error) => {
                self.business_lock()
                    .device_connect_failed(&device_id, now_ms());
                self.send_device_event(DeviceEvent {
                    device_id,
                    event_type: 3,
                    error_type: Some("connection_failed".to_owned()),
                    message: Some(error.to_string()),
                    raw_message: None,
                });
                return;
            }
        };
        Self::register_and_apply_current_theme(
            self.hub.clone(),
            device_id.clone(),
            runtime.clone(),
        )
        .await;
        self.start_runtime_subscription(device_id.clone(), generation, runtime.clone(), true);
        let snapshot = if let Some(snapshot) = snapshot {
            prepare_snapshot(
                self.hub
                    .upgrade()
                    .map(|hub| hub.dependencies.repository.clone()),
                runtime.clone(),
                snapshot,
            )
            .await
        } else {
            None
        };
        self.finish_device_connected(device_id, runtime, snapshot)
            .await;
    }

    async fn handle_runtime_closed(&mut self, device_id: &str, generation: u64) {
        let Some(subscription) = self.runtime_subscriptions.remove(device_id) else {
            return;
        };
        if subscription.generation != generation {
            self.runtime_subscriptions
                .insert(device_id.to_owned(), subscription);
            return;
        }
        subscription.task.abort();
        let _ = subscription.task.await;
        let restore_canonical = self.canonical_attached.remove(device_id);
        if restore_canonical {
            if let Some(canonical) = self.canonical.as_mut() {
                canonical.detach_device(device_id);
            }
        }
        self.snapshot_jobs.remove(device_id);
        self.runtimes.retire(device_id, &subscription.runtime).await;

        let attached = self
            .legacy_devices
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(device_id)
            || restore_canonical;
        if !attached || self.abort.is_cancelled() {
            return;
        }
        let settings = match self.hub.upgrade() {
            Some(hub) => hub
                .dependencies
                .repository
                .get_site_settings(&hub.dependencies.site_settings_defaults)
                .await
                .ok(),
            None => None,
        };
        let max_retries = settings
            .as_ref()
            .map(|settings| settings.ssh_reconnect_max_retries.max(0) as u32)
            .unwrap_or(0);
        let delay = Duration::from_secs(
            settings
                .as_ref()
                .map(|settings| settings.ssh_reconnect_delay_seconds.max(1) as u64)
                .unwrap_or(1),
        );
        if max_retries == 0 {
            self.finish_disconnected(device_id, restore_canonical);
            return;
        }
        let reconnect_generation = self.next_generation();
        self.reconnects.insert(
            device_id.to_owned(),
            ReconnectContext {
                generation: reconnect_generation,
                attempt: 1,
                max_retries,
                delay,
                restore_canonical,
            },
        );
        self.schedule_reconnect(device_id.to_owned(), reconnect_generation, 1, delay);
        self.send_reconnecting(device_id, 1, max_retries, delay);
    }

    fn schedule_reconnect(
        &self,
        device_id: String,
        generation: u64,
        attempt: u32,
        delay: Duration,
    ) {
        let pool = self.runtimes.clone();
        let sender = self.sender.clone();
        let abort = self.abort.clone();
        self.tasks.spawn(async move {
            tokio::time::sleep(delay).await;
            let result = match pool.acquire_legacy(&device_id).await {
                Ok(runtime) => match runtime.current_snapshot().await {
                    Ok(snapshot) => Ok((runtime, snapshot)),
                    Err(error) => {
                        pool.release_legacy(&device_id, &runtime).await;
                        Err(GatewayWsHubError::new(error.to_string()))
                    }
                },
                Err(error) => Err(error),
            };
            let acquired = result.as_ref().ok().map(|(runtime, _)| runtime.clone());
            if sender
                .send(ActorMessage::ReconnectCompleted {
                    device_id: device_id.clone(),
                    generation,
                    attempt,
                    result,
                })
                .await
                .is_err()
            {
                if let Some(runtime) = acquired {
                    pool.release_legacy(&device_id, &runtime).await;
                }
                abort.cancel();
            }
        });
    }

    async fn handle_reconnect_completed(
        &mut self,
        device_id: String,
        generation: u64,
        attempt: u32,
        result: Result<(Arc<DeviceSessionRuntime>, Option<StateSnapshot>), GatewayWsHubError>,
    ) {
        let matches = self
            .reconnects
            .get(&device_id)
            .is_some_and(|context| context.generation == generation && context.attempt == attempt);
        if !matches {
            if let Ok((runtime, _)) = result {
                self.runtimes.release_legacy(&device_id, &runtime).await;
            }
            return;
        }
        match result {
            Ok((runtime, snapshot)) => {
                let restore_canonical = self
                    .reconnects
                    .remove(&device_id)
                    .is_some_and(|context| context.restore_canonical);
                Self::register_and_apply_current_theme(
                    self.hub.clone(),
                    device_id.clone(),
                    runtime.clone(),
                )
                .await;
                self.start_runtime_subscription(
                    device_id.clone(),
                    generation,
                    runtime.clone(),
                    true,
                );
                if let Some(snapshot) = snapshot {
                    if let Some(mut snapshot) = prepare_snapshot(
                        self.hub
                            .upgrade()
                            .map(|hub| hub.dependencies.repository.clone()),
                        runtime.clone(),
                        snapshot,
                    )
                    .await
                    {
                        if let Some(hub) = self.hub.upgrade() {
                            snapshot = hub.record_snapshot(snapshot);
                        }
                        self.snapshots.insert(device_id.clone(), snapshot.clone());
                        self.business_lock().update_snapshot_without_send(snapshot);
                    }
                }
                if restore_canonical {
                    if let Ok(runtime) = self.runtimes.acquire_canonical(&device_id).await {
                        let _ = self
                            .attach_canonical_device(device_id.clone(), runtime)
                            .await;
                    }
                }
                self.send_device_event(DeviceEvent {
                    device_id: device_id.clone(),
                    event_type: 4,
                    error_type: None,
                    message: Some("Reconnected".to_owned()),
                    raw_message: None,
                });
                let _ = runtime.request_snapshot();
            }
            Err(error) => {
                self.send_device_event(DeviceEvent {
                    device_id: device_id.clone(),
                    event_type: 3,
                    error_type: Some("connection_failed".to_owned()),
                    message: Some(error.to_string()),
                    raw_message: None,
                });
                let Some(context) = self.reconnects.get_mut(&device_id) else {
                    return;
                };
                if attempt >= context.max_retries {
                    let restore_canonical = context.restore_canonical;
                    self.reconnects.remove(&device_id);
                    self.send_device_event(DeviceEvent {
                        device_id: device_id.clone(),
                        event_type: 3,
                        error_type: Some("reconnect_failed".to_owned()),
                        message: Some("Reconnect failed".to_owned()),
                        raw_message: None,
                    });
                    self.finish_disconnected(&device_id, restore_canonical);
                    return;
                }
                context.attempt = context.attempt.saturating_add(1);
                let next_attempt = context.attempt;
                let max_retries = context.max_retries;
                let delay = context.delay;
                self.schedule_reconnect(device_id.clone(), generation, next_attempt, delay);
                self.send_reconnecting(&device_id, next_attempt, max_retries, delay);
            }
        }
    }

    fn send_reconnecting(&self, device_id: &str, attempt: u32, max_retries: u32, delay: Duration) {
        self.send_device_event(DeviceEvent {
            device_id: device_id.to_owned(),
            event_type: 3,
            error_type: Some("reconnecting".to_owned()),
            message: Some(format!(
                "Reconnecting in {}s (attempt {attempt}/{max_retries})",
                delay.as_secs()
            )),
            raw_message: None,
        });
    }

    fn finish_disconnected(&mut self, device_id: &str, restore_canonical: bool) {
        self.send_device_event(DeviceEvent {
            device_id: device_id.to_owned(),
            event_type: 2,
            error_type: None,
            message: None,
            raw_message: None,
        });
        if restore_canonical {
            if let Some(canonical) = self.canonical.as_mut() {
                canonical.detach_device(device_id);
            }
        }
        self.legacy_devices
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(device_id);
        self.canonical_attached.remove(device_id);
        self.snapshots.remove(device_id);
        self.snapshot_jobs.remove(device_id);
        self.business_lock().detach_runtime(device_id, now_ms());
    }

    async fn register_and_apply_current_theme(
        hub: Weak<GatewayWsHubInner>,
        device_id: String,
        runtime: Arc<DeviceSessionRuntime>,
    ) {
        let Some(hub) = hub.upgrade() else {
            return;
        };
        let apply_names = hub.register_runtime(&device_id, &runtime);
        let theme = hub.current_theme();
        let names = apply_names.then(|| {
            hub.tree_custom_names
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&device_id)
                .cloned()
                .unwrap_or_default()
        });
        drop(hub);
        if let Some(theme) = theme {
            let _ = runtime.set_window_style(&theme_style(theme)).await;
        }
        if let Some(names) = names {
            for (window_id, name) in names.windows {
                let _ = runtime
                    .set_custom_name(ProjectionEntityKind::Window, &window_id, Some(name))
                    .await;
            }
            for (pane_id, name) in names.panes {
                let _ = runtime
                    .set_custom_name(ProjectionEntityKind::Pane, &pane_id, Some(name))
                    .await;
            }
        }
    }

    async fn attach_canonical_device(
        &mut self,
        device_id: String,
        runtime: Arc<dyn CanonicalFeedRuntime>,
    ) -> bool {
        let result = match self.canonical.as_mut() {
            Some(canonical) => {
                canonical
                    .attach_device(device_id.clone(), Some(runtime.clone()))
                    .await
            }
            None => Ok(false),
        };
        if result.as_ref().is_ok_and(|attached| *attached) {
            self.canonical_attached.insert(device_id);
            true
        } else {
            self.runtimes.release_canonical(&device_id, &runtime).await;
            false
        }
    }

    async fn finish_device_connected(
        &mut self,
        device_id: String,
        runtime: Arc<DeviceSessionRuntime>,
        mut snapshot: Option<StateSnapshot>,
    ) {
        self.legacy_devices
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(device_id.clone());
        let mut canonical_attached = false;
        if self.canonical.is_some() {
            if let Ok(runtime) = self.runtimes.acquire_canonical(&device_id).await {
                canonical_attached = self
                    .attach_canonical_device(device_id.clone(), runtime)
                    .await;
            }
        }
        if let Some(current) = snapshot.take() {
            snapshot = Some(
                self.hub
                    .upgrade()
                    .map_or(current.clone(), |hub| hub.record_snapshot(current)),
            );
        }
        if let Some(snapshot) = &snapshot {
            self.snapshots.insert(device_id.clone(), snapshot.clone());
        }
        let (commands, result) = {
            let mut business = self.business_lock();
            let mut sink = self.frame_sink(&business);
            let mut runtime = CommandCollector {
                commands: Vec::new(),
            };
            let result = if canonical_attached {
                business.device_connected_without_legacy_snapshot(
                    &device_id,
                    snapshot,
                    now_ms(),
                    &mut runtime,
                    &mut sink,
                )
            } else {
                business.device_connected(&device_id, snapshot, now_ms(), &mut runtime, &mut sink)
            };
            (runtime.commands, result)
        };
        if result.is_ok()
            && commands
                .iter()
                .any(|command| matches!(command, LegacyRuntimeCommand::RequestSnapshot { .. }))
        {
            let _ = runtime.request_snapshot();
        }
    }

    fn start_runtime_subscription(
        &mut self,
        device_id: String,
        generation: u64,
        runtime: Arc<DeviceSessionRuntime>,
        legacy: bool,
    ) {
        if let Some(previous) = self.runtime_subscriptions.remove(&device_id) {
            previous.task.abort();
        }
        let mut events = runtime.subscribe();
        let sender = self.sender.clone();
        let abort = self.abort.clone();
        let task_device_id = device_id.clone();
        let task = tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        if sender
                            .try_send(ActorMessage::RuntimeEvent {
                                device_id: task_device_id.clone(),
                                generation,
                                event,
                            })
                            .is_err()
                        {
                            abort.cancel();
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if sender
                            .try_send(ActorMessage::RuntimeEventsLagged {
                                device_id: task_device_id.clone(),
                                generation,
                            })
                            .is_err()
                        {
                            abort.cancel();
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        self.runtime_subscriptions.insert(
            device_id,
            RuntimeSubscription {
                runtime,
                generation,
                legacy,
                task,
            },
        );
    }

    async fn detach_device_runtime(&mut self, device_id: &str) {
        self.pending_connects.remove(device_id);
        self.reconnects.remove(device_id);
        self.legacy_devices
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(device_id);
        self.canonical_attached.remove(device_id);
        self.snapshots.remove(device_id);
        self.snapshot_jobs.remove(device_id);
        self.business_lock().detach_runtime(device_id, now_ms());
        let legacy_runtime =
            self.runtime_subscriptions
                .get_mut(device_id)
                .and_then(|subscription| {
                    subscription.legacy.then(|| {
                        subscription.legacy = false;
                        subscription.runtime.clone()
                    })
                });
        if let Some(runtime) = legacy_runtime {
            self.runtimes.release_legacy(device_id, &runtime).await;
        }
        let remove = self
            .runtime_subscriptions
            .get(device_id)
            .is_some_and(|subscription| !subscription.legacy)
            && !self.canonical_attached.contains(device_id);
        if remove {
            if let Some(subscription) = self.runtime_subscriptions.remove(device_id) {
                subscription.task.abort();
                let _ = subscription.task.await;
            }
        }
    }

    fn runtime_with_generation(&self, device_id: &str) -> Option<(Arc<DeviceSessionRuntime>, u64)> {
        let subscription = self.runtime_subscriptions.get(device_id)?;
        Some((subscription.runtime.clone(), subscription.generation))
    }

    fn spawn_runtime_action<F, Fut>(&self, device_id: &str, action: F)
    where
        F: FnOnce(Arc<DeviceSessionRuntime>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), DeviceSessionRuntimeError>> + Send + 'static,
    {
        if let Some((runtime, generation)) = self.runtime_with_generation(device_id) {
            let sender = self.sender.clone();
            let device_id = device_id.to_owned();
            self.tasks.spawn(async move {
                if let Err(error) = action(runtime).await {
                    let _ = sender
                        .send(runtime_error_event(device_id, generation, error))
                        .await;
                }
            });
        }
    }

    fn send_runtime_error(&self, device_id: &str, message: String) {
        self.send_device_event(DeviceEvent {
            device_id: device_id.to_owned(),
            event_type: 3,
            error_type: Some("tmux_error".to_owned()),
            message: Some(message.clone()),
            raw_message: Some(message),
        });
    }

    fn apply_window_order(&mut self, device_id: &str, window_ids: &[String]) {
        self.invalidate_snapshot_job(device_id);
        if let Some(snapshot) = self.snapshots.get_mut(device_id) {
            if let Some(session) = snapshot.session.as_mut() {
                stable_reorder(&mut session.windows, window_ids, |window| &window.id);
            }
        }
        self.publish_cached_snapshot(device_id);
    }

    fn apply_pane_order(&mut self, device_id: &str, window_id: &str, pane_ids: &[String]) {
        self.invalidate_snapshot_job(device_id);
        if let Some(snapshot) = self.snapshots.get_mut(device_id) {
            if let Some(window) = snapshot.session.as_mut().and_then(|session| {
                session
                    .windows
                    .iter_mut()
                    .find(|window| window.id == window_id)
            }) {
                stable_reorder(&mut window.panes, pane_ids, |pane| &pane.id);
            }
        }
        self.publish_cached_snapshot(device_id);
    }

    fn apply_custom_name_overlay(
        &mut self,
        device_id: &str,
        kind: ProjectionEntityKind,
        native_id: &str,
        name: Option<&str>,
    ) {
        self.invalidate_snapshot_job(device_id);
        if let Some(snapshot) = self.snapshots.get_mut(device_id) {
            apply_snapshot_custom_name(snapshot, kind, native_id, name);
        }
        self.publish_cached_snapshot(device_id);
    }

    fn invalidate_snapshot_job(&mut self, device_id: &str) {
        let job = self.next_generation();
        self.snapshot_jobs.insert(device_id.to_owned(), job);
    }

    fn publish_cached_snapshot(&mut self, device_id: &str) {
        let Some(mut snapshot) = self.snapshots.get(device_id).cloned() else {
            return;
        };
        if let Some(hub) = self.hub.upgrade() {
            snapshot = hub.record_snapshot(snapshot);
            self.snapshots
                .insert(device_id.to_owned(), snapshot.clone());
        }
        let mut business = self.business_lock();
        if self.canonical_attached.contains(device_id) {
            business.update_snapshot_without_send(snapshot);
            return;
        }
        let mut sink = self.frame_sink(&business);
        let _ = business.receive_snapshot(snapshot, &mut sink);
    }

    fn spawn_prepare_snapshot(
        &mut self,
        device_id: String,
        generation: u64,
        snapshot: StateSnapshot,
    ) {
        let job = self.next_generation();
        self.snapshot_jobs.insert(device_id.clone(), job);
        let repository = self
            .hub
            .upgrade()
            .map(|hub| hub.dependencies.repository.clone());
        let runtime = self
            .runtime_subscriptions
            .get(&device_id)
            .map(|subscription| subscription.runtime.clone());
        let sender = self.sender.clone();
        self.tasks.spawn(async move {
            let snapshot = if let Some(runtime) = runtime {
                prepare_snapshot(repository, runtime, snapshot)
                    .await
                    .unwrap_or_else(|| StateSnapshot {
                        device_id: device_id.clone(),
                        session: None,
                    })
            } else {
                snapshot
            };
            let _ = sender
                .send(ActorMessage::PreparedSnapshot {
                    device_id,
                    generation,
                    job,
                    snapshot,
                })
                .await;
        });
    }

    async fn send_bell_event(&mut self, device_id: &str, pane_id: &str) {
        let (context, throttle) = self.pane_event_context(device_id, pane_id).await;
        let event = BellEvent {
            window_id: context.window_id,
            pane_id: Some(pane_id.to_owned()),
            window_index: context.window_index,
            pane_index: context.pane_index,
            pane_url: context.pane_url,
            pane_title: context.pane_title,
            pane_current_command: context.pane_current_command,
            pane_current_path: context.pane_current_path,
        };
        self.send_tmux_payload(
            device_id,
            9,
            encode_payload(&event).ok(),
            LegacyTmuxEventDelivery::Bell {
                pane_id: pane_id.to_owned(),
                throttle_seconds: throttle.0,
            },
        );
    }

    async fn send_notification_event(
        &mut self,
        device_id: &str,
        pane_id: &str,
        notification: tmex_terminal::PaneStreamNotification,
    ) {
        if notification.title.as_deref().unwrap_or_default().is_empty()
            && notification.body.is_empty()
        {
            return;
        }
        let source_name = match notification.source {
            PaneStreamNotificationSource::Osc9 => "osc9",
            PaneStreamNotificationSource::Osc99 => "osc99",
            PaneStreamNotificationSource::Osc777 => "osc777",
            PaneStreamNotificationSource::Osc1337 => "osc1337",
        };
        let source = match notification.source {
            PaneStreamNotificationSource::Osc9 => 1,
            PaneStreamNotificationSource::Osc777 => 2,
            PaneStreamNotificationSource::Osc1337 => 3,
            PaneStreamNotificationSource::Osc99 => 4,
        };
        let (context, throttle) = self.pane_event_context(device_id, pane_id).await;
        let event = NotificationEvent {
            source,
            title: notification.title,
            body: notification.body,
            window_id: context.window_id,
            pane_id: Some(pane_id.to_owned()),
            window_index: context.window_index,
            pane_index: context.pane_index,
            pane_url: context.pane_url,
            pane_title: context.pane_title,
            pane_current_command: context.pane_current_command,
            pane_current_path: context.pane_current_path,
        };
        self.send_tmux_payload(
            device_id,
            11,
            encode_payload(&event).ok(),
            LegacyTmuxEventDelivery::Notification {
                pane_id: pane_id.to_owned(),
                source: source_name.to_owned(),
                throttle_seconds: throttle.1,
            },
        );
    }

    async fn pane_event_context(
        &mut self,
        device_id: &str,
        pane_id: &str,
    ) -> (PaneEventContext, (u64, u64)) {
        let settings = if let Some(hub) = self.hub.upgrade() {
            hub.dependencies
                .repository
                .get_site_settings(&hub.dependencies.site_settings_defaults)
                .await
                .ok()
        } else {
            None
        };
        let site_url = settings
            .as_ref()
            .map(|settings| settings.site_url.trim_end_matches('/').to_owned())
            .unwrap_or_default();
        let context = self
            .snapshots
            .get(device_id)
            .and_then(|snapshot| snapshot.session.as_ref())
            .and_then(|session| {
                session.windows.iter().find_map(|window| {
                    window
                        .panes
                        .iter()
                        .find(|pane| pane.id == pane_id)
                        .map(|pane| PaneEventContext {
                            window_id: Some(window.id.clone()),
                            window_index: Some(window.index),
                            pane_index: Some(pane.index),
                            pane_url: (!site_url.is_empty()).then(|| {
                                format!(
                                    "{site_url}/devices/{}/windows/{}/panes/{}",
                                    encode_uri_component(device_id),
                                    encode_uri_component(&window.id),
                                    encode_uri_component(&pane.id),
                                )
                            }),
                            pane_title: pane.custom_name.clone().or_else(|| pane.title.clone()),
                            pane_current_command: pane.current_command.clone(),
                            pane_current_path: pane.current_path.clone(),
                        })
                })
            })
            .unwrap_or_default();
        let throttles = settings.map_or((0, 0), |settings| {
            (
                u64::try_from(settings.bell_throttle_seconds.max(0)).unwrap_or(0),
                u64::try_from(settings.notification_throttle_seconds.max(0)).unwrap_or(0),
            )
        });
        (context, throttles)
    }

    async fn cleanup(&mut self) {
        if let Some(canonical) = self.canonical.as_mut() {
            canonical.close();
        }
        self.canonical = None;
        self.canonical_attached.clear();
        self.legacy_devices
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        let events = self.business_lock().close();
        for event in events {
            if let LegacyBusinessEvent::DetachDevice { device_id } = event {
                self.snapshots.remove(&device_id);
            }
        }
        let subscriptions = self
            .runtime_subscriptions
            .drain()
            .map(|(_, subscription)| subscription)
            .collect::<Vec<_>>();
        for subscription in subscriptions {
            subscription.task.abort();
            let _ = subscription.task.await;
        }
        self.tasks.cancel_all().await;
        self.runtimes.release_all().await;
    }
}

#[derive(Default)]
struct PaneEventContext {
    window_id: Option<String>,
    window_index: Option<u16>,
    pane_index: Option<u16>,
    pane_url: Option<String>,
    pane_title: Option<String>,
    pane_current_command: Option<String>,
    pane_current_path: Option<String>,
}

async fn prepare_snapshot(
    repository: Option<Repository>,
    runtime: Arc<DeviceSessionRuntime>,
    mut snapshot: StateSnapshot,
) -> Option<StateSnapshot> {
    let order = if let Some(repository) = repository {
        repository
            .get_device_tree_order(&snapshot.device_id)
            .await
            .ok()
    } else {
        None
    };
    let metadata = runtime.metadata_snapshot().await.ok();
    let Some(session) = snapshot.session.as_mut() else {
        return Some(snapshot);
    };
    if let Some(metadata) = metadata {
        let mut window_names = HashMap::new();
        let mut pane_names = HashMap::new();
        for record in metadata.records {
            let name = record.fields.iter().find_map(|field| {
                (field.field == SOURCE_FIELD_CUSTOM_NAME).then_some(&field.value)
            });
            let Some(SourceMetadataValue::String(name)) = name else {
                continue;
            };
            match record.key.entity_kind {
                SOURCE_ENTITY_WINDOW => {
                    window_names.insert(record.key.native_id, name.clone());
                }
                SOURCE_ENTITY_PANE => {
                    pane_names.insert(record.key.native_id, name.clone());
                }
                _ => {}
            }
        }
        for window in &mut session.windows {
            window.custom_name = window_names.get(&window.id).cloned();
            for pane in &mut window.panes {
                pane.custom_name = pane_names.get(&pane.id).cloned();
            }
        }
    }
    if let Some(order) = order {
        stable_reorder(&mut session.windows, &order.windows, |window| &window.id);
        for window in &mut session.windows {
            if let Some(panes) = order.panes.get(&window.id) {
                stable_reorder(&mut window.panes, panes, |pane| &pane.id);
            }
        }
    }
    Some(snapshot)
}

fn stable_reorder<T>(values: &mut [T], preferred: &[String], id: impl Fn(&T) -> &str) {
    let order = preferred
        .iter()
        .enumerate()
        .map(|(index, value)| (value.as_str(), index))
        .collect::<HashMap<_, _>>();
    values.sort_by_key(|value| order.get(id(value)).copied().unwrap_or(usize::MAX));
}

fn normalize_gateway_custom_name(value: &str) -> Option<String> {
    let normalized = value.trim().chars().take(64).collect::<String>();
    (!normalized.is_empty()).then_some(normalized)
}

fn apply_snapshot_custom_name(
    snapshot: &mut StateSnapshot,
    kind: ProjectionEntityKind,
    native_id: &str,
    name: Option<&str>,
) {
    let normalized = name.and_then(normalize_gateway_custom_name);
    let Some(session) = snapshot.session.as_mut() else {
        return;
    };
    match kind {
        ProjectionEntityKind::Window => {
            if let Some(window) = session
                .windows
                .iter_mut()
                .find(|window| window.id == native_id)
            {
                window.custom_name = normalized;
            }
        }
        ProjectionEntityKind::Pane => {
            if let Some(pane) = session
                .windows
                .iter_mut()
                .flat_map(|window| &mut window.panes)
                .find(|pane| pane.id == native_id)
            {
                pane.custom_name = normalized;
            }
        }
    }
}

fn apply_metadata_patch(snapshot: &mut StateSnapshot, patch: &SourceMetadataPatch) {
    let Some(session) = snapshot.session.as_mut() else {
        return;
    };
    for key in &patch.removals {
        match key.entity_kind {
            SOURCE_ENTITY_WINDOW => session.windows.retain(|window| window.id != key.native_id),
            SOURCE_ENTITY_PANE => {
                for window in &mut session.windows {
                    window.panes.retain(|pane| pane.id != key.native_id);
                }
            }
            _ => {}
        }
    }
    for record in &patch.upserts {
        match record.key.entity_kind {
            SOURCE_ENTITY_SESSION => {
                for field in &record.fields {
                    if field.field == SOURCE_FIELD_NAME {
                        if let SourceMetadataValue::String(value) = &field.value {
                            session.name.clone_from(value);
                        }
                    }
                }
            }
            SOURCE_ENTITY_WINDOW => {
                let Some(window) = session
                    .windows
                    .iter_mut()
                    .find(|window| window.id == record.key.native_id)
                else {
                    continue;
                };
                for field in &record.fields {
                    match (field.field, &field.value) {
                        (SOURCE_FIELD_NAME, SourceMetadataValue::String(value)) => {
                            window.name.clone_from(value);
                        }
                        (SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::String(value)) => {
                            window.custom_name = Some(value.clone());
                        }
                        (SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::Unset) => {
                            window.custom_name = None;
                        }
                        (SOURCE_FIELD_INDEX, SourceMetadataValue::U16(value)) => {
                            window.index = *value;
                        }
                        (SOURCE_FIELD_ACTIVE, SourceMetadataValue::Bool(value)) => {
                            window.active = *value;
                        }
                        (SOURCE_FIELD_LAYOUT, SourceMetadataValue::String(value)) => {
                            window.layout = Some(value.clone());
                        }
                        (SOURCE_FIELD_LAYOUT, SourceMetadataValue::Unset) => {
                            window.layout = None;
                        }
                        _ => {}
                    }
                }
            }
            SOURCE_ENTITY_PANE => {
                let Some(pane) = session
                    .windows
                    .iter_mut()
                    .flat_map(|window| &mut window.panes)
                    .find(|pane| pane.id == record.key.native_id)
                else {
                    continue;
                };
                for field in &record.fields {
                    match (field.field, &field.value) {
                        (SOURCE_FIELD_TITLE, SourceMetadataValue::String(value)) => {
                            pane.title = Some(value.clone());
                        }
                        (SOURCE_FIELD_TITLE, SourceMetadataValue::Unset) => pane.title = None,
                        (SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::String(value)) => {
                            pane.custom_name = Some(value.clone());
                        }
                        (SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::Unset) => {
                            pane.custom_name = None;
                        }
                        (SOURCE_FIELD_INDEX, SourceMetadataValue::U16(value)) => {
                            pane.index = *value;
                        }
                        (SOURCE_FIELD_ACTIVE, SourceMetadataValue::Bool(value)) => {
                            pane.active = *value;
                        }
                        (SOURCE_FIELD_WIDTH, SourceMetadataValue::U16(value)) => {
                            pane.width = *value;
                        }
                        (SOURCE_FIELD_HEIGHT, SourceMetadataValue::U16(value)) => {
                            pane.height = *value;
                        }
                        (SOURCE_FIELD_LEFT, SourceMetadataValue::U16(value)) => {
                            pane.left = Some(*value);
                        }
                        (SOURCE_FIELD_LEFT, SourceMetadataValue::Unset) => pane.left = None,
                        (SOURCE_FIELD_TOP, SourceMetadataValue::U16(value)) => {
                            pane.top = Some(*value);
                        }
                        (SOURCE_FIELD_TOP, SourceMetadataValue::Unset) => pane.top = None,
                        (SOURCE_FIELD_CURRENT_PATH, SourceMetadataValue::String(value)) => {
                            pane.current_path = Some(value.clone());
                        }
                        (SOURCE_FIELD_CURRENT_PATH, SourceMetadataValue::Unset) => {
                            pane.current_path = None;
                        }
                        (SOURCE_FIELD_CURRENT_COMMAND, SourceMetadataValue::String(value)) => {
                            pane.current_command = Some(value.clone());
                        }
                        (SOURCE_FIELD_CURRENT_COMMAND, SourceMetadataValue::Unset) => {
                            pane.current_command = None;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMetadataEntityDiff {
    entity_kind: u8,
    native_id: String,
    parent_kind: Option<u8>,
    parent_id: Option<String>,
    fields: Vec<(u8, JsonValue)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMetadataRemoval {
    entity_kind: u8,
    native_id: String,
}

#[derive(Serialize)]
struct LegacyMetadataDiff {
    upserts: Vec<LegacyMetadataEntityDiff>,
    removals: Vec<LegacyMetadataRemoval>,
}

fn legacy_metadata_diff(device_id: &str, patch: &SourceMetadataPatch) -> Option<StateSnapshotDiff> {
    let allowed = |kind| {
        matches!(
            kind,
            SOURCE_ENTITY_SESSION | SOURCE_ENTITY_WINDOW | SOURCE_ENTITY_PANE
        )
    };
    let upserts = patch
        .upserts
        .iter()
        .filter(|record| allowed(record.key.entity_kind))
        .map(|record| LegacyMetadataEntityDiff {
            entity_kind: record.key.entity_kind,
            native_id: record.key.native_id.clone(),
            parent_kind: record.parent.as_ref().map(|parent| parent.entity_kind),
            parent_id: record
                .parent
                .as_ref()
                .map(|parent| parent.native_id.clone()),
            fields: record
                .fields
                .iter()
                .filter(|field| field.field != SOURCE_FIELD_PANE_EPOCH)
                .filter_map(|field| {
                    metadata_json_value(&field.value).map(|value| (field.field, value))
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    let removals = patch
        .removals
        .iter()
        .filter(|key| allowed(key.entity_kind))
        .map(|key| LegacyMetadataRemoval {
            entity_kind: key.entity_kind,
            native_id: key.native_id.clone(),
        })
        .collect::<Vec<_>>();
    if upserts.is_empty() && removals.is_empty() {
        return None;
    }
    let diff_bytes = serde_json::to_vec(&LegacyMetadataDiff { upserts, removals }).ok()?;
    Some(StateSnapshotDiff {
        device_id: device_id.to_owned(),
        base_revision: patch.from_revision as u32,
        revision: patch.through_revision as u32,
        diff_format: STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON,
        diff_bytes,
    })
}

fn metadata_json_value(value: &SourceMetadataValue) -> Option<JsonValue> {
    match value {
        SourceMetadataValue::Unset => Some(JsonValue::Null),
        SourceMetadataValue::String(value) => Some(json!(value)),
        SourceMetadataValue::Bool(value) => Some(json!(value)),
        SourceMetadataValue::U16(value) => Some(json!(value)),
        SourceMetadataValue::U32(value) => Some(json!(value)),
        SourceMetadataValue::Bytes16(_) => None,
    }
}

fn encode_agent_sync(
    snapshot: crate::agent::AgentSyncSnapshot,
) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&json!({
        "status": snapshot.status,
        "lastError": snapshot.last_error,
        "inProgressText": snapshot.in_progress_text,
        "inProgressReasoning": snapshot.in_progress_reasoning,
        "pendingConfirmations": snapshot.pending_confirmations.into_iter().map(|confirmation| json!({
            "confirmationId": confirmation.confirmation_id,
            "toolCallId": confirmation.tool_call_id,
            "toolName": confirmation.tool_name,
            "input": confirmation.input,
            "createdAt": confirmation.created_at,
        })).collect::<Vec<_>>(),
        "queuedMessages": snapshot.queued_messages.into_iter().map(|message| json!({
            "id": message.id,
            "seq": message.seq,
            "text": message.text,
            "createdAt": message.created_at,
        })).collect::<Vec<_>>(),
        "lastMessageSeq": snapshot.last_message_seq,
    }))
}

fn encode_agent_event(event: &AgentEvent) -> Result<(u8, Vec<u8>), serde_json::Error> {
    let (event_type, value) = match event {
        AgentEvent::Status { status, last_error } => (
            AGENT_EVENT_STATUS,
            json!({ "status": status, "lastError": last_error }),
        ),
        AgentEvent::TextDelta { message_id, delta } => (
            AGENT_EVENT_TEXT_DELTA,
            json!({ "messageId": message_id, "delta": delta }),
        ),
        AgentEvent::ReasoningDelta { message_id, delta } => (
            AGENT_EVENT_REASONING_DELTA,
            json!({ "messageId": message_id, "delta": delta }),
        ),
        AgentEvent::ToolCall {
            tool_call_id,
            tool_name,
            input,
        } => (
            AGENT_EVENT_TOOL_CALL,
            json!({ "toolCallId": tool_call_id, "toolName": tool_name, "input": input }),
        ),
        AgentEvent::ToolResult {
            tool_call_id,
            tool_name,
            output,
        } => (
            AGENT_EVENT_TOOL_RESULT,
            json!({ "toolCallId": tool_call_id, "toolName": tool_name, "output": output }),
        ),
        AgentEvent::ToolError {
            tool_call_id,
            tool_name,
            output,
        } => (
            AGENT_EVENT_TOOL_RESULT,
            json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "output": output,
                "isError": true,
            }),
        ),
        AgentEvent::ConfirmationRequest(confirmation) => (
            AGENT_EVENT_CONFIRMATION_REQUEST,
            json!({
                "confirmationId": confirmation.confirmation_id,
                "toolCallId": confirmation.tool_call_id,
                "toolName": confirmation.tool_name,
                "input": confirmation.input,
                "createdAt": confirmation.created_at,
            }),
        ),
        AgentEvent::ConfirmationResolved {
            confirmation_id,
            status,
            reason,
        } => (
            AGENT_EVENT_CONFIRMATION_RESOLVED,
            json!({ "confirmationId": confirmation_id, "status": status, "reason": reason }),
        ),
        AgentEvent::MessagePersisted {
            message_id,
            seq,
            role,
        } => (
            AGENT_EVENT_MESSAGE_PERSISTED,
            json!({ "messageId": message_id, "seq": seq, "role": role }),
        ),
        AgentEvent::QueueUpdated { queued } => (
            AGENT_EVENT_QUEUE_UPDATED,
            json!({
                "queued": queued.iter().map(|message| json!({
                    "id": message.id,
                    "seq": message.seq,
                    "text": message.text,
                    "createdAt": message.created_at,
                })).collect::<Vec<_>>()
            }),
        ),
        AgentEvent::CredentialWarning { message_id, types } => (
            AGENT_EVENT_CREDENTIAL_WARNING,
            json!({ "messageId": message_id, "types": types }),
        ),
        AgentEvent::TurnFinished {
            session_status,
            last_message_seq,
        } => (
            AGENT_EVENT_TURN_FINISHED,
            json!({ "sessionStatus": session_status, "lastMessageSeq": last_message_seq }),
        ),
        AgentEvent::Error { message } => (AGENT_EVENT_ERROR, json!({ "message": message })),
    };
    Ok((event_type, serde_json::to_vec(&value)?))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tmex_db::DbConfig;
    use tmex_protocol::{
        decode_envelope, decode_payload, encode_canonical_command, encode_envelope, encode_payload,
        CanonicalCommand, DeviceConnect, DeviceEvent, HelloC2s, MessageKind, SetPaneSubscriptions,
        TermInput, TermPaste, TmuxCloseWindow, CURRENT_VERSION, DEFAULT_MAX_FRAME_BYTES,
    };
    use tokio::sync::Notify;
    use tokio::time::{timeout, Duration};

    use crate::database::DatabaseBootstrap;
    use crate::tmux::{
        ControlClient, DeviceSessionConfig, LifecycleEvent, LifecycleEventKind,
        LifecycleTmuxContext, LocalTmuxConfig, RuntimeRegistryError, SourceMetadataEvent,
        StandaloneSpawnPolicy, TmuxCommandResult, TmuxTransport, TmuxTransportConfig,
        TmuxTransportError, TmuxTransportFactory, PANE_SNAPSHOT_FORMAT,
        RUNTIME_COMMAND_QUEUE_CAPACITY, SESSION_SNAPSHOT_FORMAT, TMEX_SERVER_EPOCH_OPTION,
        WINDOW_SNAPSHOT_FORMAT,
    };

    use super::*;

    #[derive(Default)]
    struct HubTestState {
        creates: AtomicUsize,
        runtime_ready: AtomicUsize,
        closes: AtomicUsize,
        transports: Mutex<HashMap<String, Arc<HubTestTransport>>>,
        hold_factory_device: Mutex<Option<String>>,
        factory_gate_open: AtomicBool,
        factory_gate: Notify,
        block_theme_device: Mutex<Option<String>>,
        theme_gate_open: AtomicBool,
        theme_gate: Notify,
        block_input_device: Mutex<Option<String>>,
        input_gate_open: AtomicBool,
        input_gate: Notify,
        rejected_command: Mutex<Option<String>>,
    }

    impl HubTestState {
        fn hold_factory_for(&self, device_id: &str) {
            *self
                .hold_factory_device
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(device_id.to_owned());
        }

        fn release_factory(&self) {
            self.factory_gate_open.store(true, Ordering::Release);
            self.factory_gate.notify_waiters();
        }

        fn block_theme_for(&self, device_id: &str) {
            *self
                .block_theme_device
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(device_id.to_owned());
        }

        fn release_theme(&self) {
            self.theme_gate_open.store(true, Ordering::Release);
            self.theme_gate.notify_waiters();
        }

        fn block_input_for(&self, device_id: &str) {
            *self
                .block_input_device
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(device_id.to_owned());
        }

        fn release_input(&self) {
            self.input_gate_open.store(true, Ordering::Release);
            self.input_gate.notify_waiters();
        }

        fn reject_command(&self, command: &str) {
            *self
                .rejected_command
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(command.to_owned());
        }

        fn transport(&self, device_id: &str) -> Arc<HubTestTransport> {
            self.transports
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(device_id)
                .cloned()
                .expect("test transport exists")
        }
    }

    struct HubTestTransport {
        device_id: String,
        state: Arc<HubTestState>,
        commands: Mutex<Vec<Vec<String>>>,
        theme_styles_started: AtomicUsize,
    }

    impl HubTestTransport {
        fn command_count(&self, command: &str) -> usize {
            self.commands
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|args| args.first().is_some_and(|value| value == command))
                .count()
        }

        fn command_contains(&self, command: &str, needle: &str) -> usize {
            self.commands
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|args| {
                    args.first().is_some_and(|value| value == command)
                        && args.iter().any(|value| value.contains(needle))
                })
                .count()
        }

        fn is_requested_theme_style(args: &[String]) -> bool {
            args.first().is_some_and(|value| value == "set-hook")
                && args.last().is_some_and(|value| {
                    value.contains("fg=#d0d0d0,bg=#262626")
                        || value.contains("fg=#616161,bg=#e1e1e1")
                })
        }
    }

    #[async_trait]
    impl TmuxTransport for HubTestTransport {
        async fn run_tmux(
            &self,
            args: &[String],
            _deadline: Duration,
            _output_limit: usize,
        ) -> Result<TmuxCommandResult, TmuxTransportError> {
            self.commands
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(args.to_vec());
            if Self::is_requested_theme_style(args) {
                self.theme_styles_started.fetch_add(1, Ordering::AcqRel);
                let blocked = self
                    .state
                    .block_theme_device
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_deref()
                    == Some(self.device_id.as_str());
                while blocked && !self.state.theme_gate_open.load(Ordering::Acquire) {
                    self.state.theme_gate.notified().await;
                }
            }
            if args.first().is_some_and(|value| value == "send-keys") {
                let blocked = self
                    .state
                    .block_input_device
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_deref()
                    == Some(self.device_id.as_str());
                while blocked && !self.state.input_gate_open.load(Ordering::Acquire) {
                    self.state.input_gate.notified().await;
                }
            }
            if self
                .state
                .rejected_command
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_deref()
                == args.first().map(String::as_str)
            {
                return Ok(TmuxCommandResult {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "forced tmux failure".to_owned(),
                });
            }
            let stdout = if args == ["-V"] {
                "tmux 3.4\n"
            } else if args.first().map(String::as_str) == Some("show-options")
                && args.last().map(String::as_str) == Some(TMEX_SERVER_EPOCH_OPTION)
            {
                "00000000000000000000000000000000\n"
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some(SESSION_SNAPSHOT_FORMAT)
            {
                "$1|tmex\n"
            } else if args.first().map(String::as_str) == Some("list-windows")
                && args.last().map(String::as_str) == Some(WINDOW_SNAPSHOT_FORMAT)
            {
                if self.device_id == "tree-device" {
                    "@1|0|1|abcd|main\n@2|1|0|efgh|logs\n"
                } else {
                    "@1|0|1|abcd|main\n"
                }
            } else if args.first().map(String::as_str) == Some("list-windows")
                && args.last().map(String::as_str) == Some("#{window_id}")
            {
                if self.device_id == "tree-device" {
                    "@1\n@2\n"
                } else {
                    "@1\n"
                }
            } else if args.first().map(String::as_str) == Some("list-panes")
                && args.last().map(String::as_str) == Some(PANE_SNAPSHOT_FORMAT)
            {
                if self.device_id == "tree-device" {
                    "%1|@1|0|1|80|24|0|0|1|shell|zsh|/tmp\n%2|@1|1|0|80|24|0|0|1|shell|zsh|/tmp\n%3|@2|0|1|80|24|0|0|1|shell|zsh|/tmp\n"
                } else {
                    "%1|@1|0|1|80|24|0|0|1|shell|zsh|/tmp\n"
                }
            } else if args.first().map(String::as_str) == Some("list-panes")
                && args.last().map(String::as_str) == Some("#{pane_id}|#{@tmex_2031}")
            {
                if self.device_id == "tree-device" {
                    "%1|on\n%2|on\n%3|on\n"
                } else {
                    "%1|on\n"
                }
            } else {
                ""
            };
            Ok(TmuxCommandResult {
                exit_code: 0,
                stdout: stdout.to_owned(),
                stderr: String::new(),
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
            self.state.closes.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    struct HubTestTransportFactory {
        transport: Arc<HubTestTransport>,
    }

    #[async_trait]
    impl TmuxTransportFactory for HubTestTransportFactory {
        async fn create(
            &self,
            _config: &DeviceSessionConfig,
        ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError> {
            Ok(self.transport.clone())
        }
    }

    fn runtime_config(device_id: &str) -> DeviceSessionConfig {
        DeviceSessionConfig {
            device_id: device_id.to_owned(),
            device_name: Some(device_id.to_owned()),
            session_name: "tmex".to_owned(),
            default_working_dir: Some("/tmp".to_owned()),
            tmux_term_program: "off".to_owned(),
            tmux_window_style: "fg=#000000".to_owned(),
            allow_passthrough: false,
            enable_control_mode: false,
            transport: TmuxTransportConfig::Local(LocalTmuxConfig {
                tmux_bin: "unused".to_owned(),
                socket_name: Some(format!("hub-test-{device_id}")),
                environment: BTreeMap::new(),
            }),
            spawn_policy: Arc::new(StandaloneSpawnPolicy),
        }
    }

    fn test_registry(state: Arc<HubTestState>) -> Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>> {
        Arc::new(TmuxRuntimeRegistry::new(Arc::new(
            move |device_id: String| {
                let state = state.clone();
                async move {
                    state.creates.fetch_add(1, Ordering::AcqRel);
                    let transport = Arc::new(HubTestTransport {
                        device_id: device_id.clone(),
                        state: state.clone(),
                        commands: Mutex::new(Vec::new()),
                        theme_styles_started: AtomicUsize::new(0),
                    });
                    state
                        .transports
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(device_id.clone(), transport.clone());
                    let runtime = DeviceSessionRuntime::start(
                        runtime_config(&device_id),
                        Arc::new(HubTestTransportFactory { transport }),
                    )
                    .await
                    .map_err(|error| RuntimeRegistryError::new(error.to_string()))?;
                    state.runtime_ready.fetch_add(1, Ordering::AcqRel);
                    let held = state
                        .hold_factory_device
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .as_deref()
                        == Some(device_id.as_str());
                    while held && !state.factory_gate_open.load(Ordering::Acquire) {
                        state.factory_gate.notified().await;
                    }
                    Ok(Arc::new(runtime))
                }
            },
        )))
    }

    fn site_defaults() -> RepositorySiteSettingsDefaults {
        RepositorySiteSettingsDefaults {
            site_name: "test".to_owned(),
            site_url: "http://127.0.0.1".to_owned(),
            bell_throttle_seconds: 0,
            notification_throttle_seconds: 0,
            ssh_reconnect_max_retries: 0,
            ssh_reconnect_delay_seconds: 1,
            language: "en-US".to_owned(),
        }
    }

    async fn test_repository() -> Repository {
        Repository::new(
            DatabaseBootstrap::new(DbConfig::in_memory())
                .run()
                .await
                .expect("bootstrap WS hub test database"),
        )
    }

    async fn test_hub(
        state: Arc<HubTestState>,
        config: GatewayWsHubConfig,
    ) -> (GatewayWsHub, Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>) {
        let runtimes = test_registry(state);
        let hub = GatewayWsHub::new(
            config,
            GatewayWsHubDependencies {
                runtimes: runtimes.clone(),
                repository: test_repository().await,
                site_settings_defaults: site_defaults(),
            },
        )
        .expect("valid WS hub test config");
        (hub, runtimes)
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        timeout(Duration::from_secs(3), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition became true");
    }

    async fn send_envelope(
        session: &GatewaySession,
        kind: MessageKind,
        seq: u32,
        payload: Vec<u8>,
    ) {
        let frame = encode_envelope(kind as u16, payload, seq, 0, CURRENT_VERSION)
            .expect("encode test envelope");
        session
            .send(GatewayFrame::Binary(Bytes::from(frame)))
            .await
            .expect("send test envelope");
    }

    async fn recv_envelope(session: &mut GatewaySession) -> Envelope {
        loop {
            let frame = timeout(Duration::from_secs(3), session.recv())
                .await
                .expect("receive WS frame before timeout")
                .expect("WS session remains open");
            if let GatewayFrame::Binary(frame) = frame {
                return decode_envelope(&frame).expect("decode outbound envelope");
            }
        }
    }

    async fn recv_kind(session: &mut GatewaySession, expected: MessageKind) -> Envelope {
        loop {
            let envelope = recv_envelope(session).await;
            if envelope.kind == expected as u16 {
                return envelope;
            }
        }
    }

    async fn negotiate(session: &GatewaySession) {
        send_envelope(
            session,
            MessageKind::HelloC2s,
            1,
            encode_payload(&HelloC2s {
                client_impl: "hub-test".to_owned(),
                client_version: "1".to_owned(),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u32,
                supports_compression: false,
                supports_diff_snapshot: true,
            })
            .expect("encode HELLO"),
        )
        .await;
    }

    async fn connect(session: &GatewaySession, device_id: &str) {
        send_envelope(
            session,
            MessageKind::DeviceConnect,
            2,
            encode_payload(&DeviceConnect {
                device_id: device_id.to_owned(),
            })
            .expect("encode device connect"),
        )
        .await;
    }

    async fn runtime_custom_name(
        runtime: &DeviceSessionRuntime,
        kind: ProjectionEntityKind,
        native_id: &str,
    ) -> Option<String> {
        runtime
            .metadata_snapshot()
            .await
            .expect("runtime metadata snapshot")
            .records
            .into_iter()
            .find(|record| {
                record.key.entity_kind
                    == match kind {
                        ProjectionEntityKind::Window => SOURCE_ENTITY_WINDOW,
                        ProjectionEntityKind::Pane => SOURCE_ENTITY_PANE,
                    }
                    && record.key.native_id == native_id
            })
            .and_then(|record| {
                record.fields.into_iter().find_map(|field| {
                    (field.field == SOURCE_FIELD_CUSTOM_NAME).then_some(field.value)
                })
            })
            .and_then(|value| match value {
                SourceMetadataValue::String(value) => Some(value),
                _ => None,
            })
    }

    #[tokio::test]
    async fn legacy_tmux_command_failures_remain_observable_as_device_errors() {
        let state = Arc::new(HubTestState::default());
        let (hub, _registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut session = hub.open_session().expect("open WS session");

        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        state.reject_command("kill-window");
        send_envelope(
            &session,
            MessageKind::TmuxCloseWindow,
            3,
            encode_payload(&TmuxCloseWindow {
                device_id: "device".to_owned(),
                window_id: "@1".to_owned(),
            })
            .expect("encode close-window command"),
        )
        .await;

        let event: DeviceEvent = decode_payload(
            &recv_kind(&mut session, MessageKind::DeviceEvent)
                .await
                .payload,
        )
        .expect("decode device error");
        assert_eq!(event.device_id, "device");
        assert_eq!(event.error_type.as_deref(), Some("tmux_error"));
        assert!(event.message.is_some_and(|message| {
            message.contains("kill-window") && message.contains("forced tmux failure")
        }));

        hub.stop_all().await;
    }

    #[tokio::test]
    async fn hello_legacy_and_canonical_share_one_runtime_and_close_releases_it() {
        let state = Arc::new(HubTestState::default());
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut session = hub.open_session().expect("open WS session");

        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        let canonical = encode_canonical_command(CanonicalCommand::SetPaneSubscriptions(
            SetPaneSubscriptions {
                generation: 1,
                active_panes: Vec::new(),
                hot_panes: Vec::new(),
            },
        ))
        .expect("encode canonical command");
        let frame = encode_envelope(
            MessageKind::CanonicalCommand as u16,
            canonical,
            3,
            0,
            CURRENT_VERSION,
        )
        .expect("encode canonical envelope");
        session
            .send(GatewayFrame::Binary(Bytes::from(frame)))
            .await
            .expect("send canonical command");
        recv_kind(&mut session, MessageKind::CanonicalEvent).await;
        assert_eq!(state.creates.load(Ordering::Acquire), 1);

        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close session");
        loop {
            if session.recv().await == Some(GatewayFrame::Close(None)) {
                break;
            }
        }
        hub.stop_all().await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 1).await;
        assert!(registry.peek("device").await.is_none());
    }

    #[tokio::test]
    async fn session_actor_panic_runs_cleanup_and_releases_runtime_ownership() {
        let state = Arc::new(HubTestState::default());
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        let sender = hub
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .next()
            .expect("active session")
            .sender
            .clone();
        sender
            .send(ActorMessage::PanicForTest)
            .await
            .expect("inject actor panic");

        wait_until(|| {
            hub.inner
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        })
        .await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 1).await;
        assert!(registry.peek("device").await.is_none());
        assert!(session.recv().await.is_none());
        hub.stop_all().await;
    }

    #[tokio::test]
    async fn closing_during_runtime_creation_cannot_leave_a_registry_reference() {
        let state = Arc::new(HubTestState::default());
        state.hold_factory_for("device");
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        wait_until(|| state.runtime_ready.load(Ordering::Acquire) == 1).await;

        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close pending session");
        state.release_factory();
        let _ = session.recv().await;
        hub.stop_all().await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 1).await;
        assert!(registry.peek("device").await.is_none());
    }

    #[tokio::test]
    async fn outbound_saturation_terminates_only_the_slow_session_and_releases_runtime() {
        let state = Arc::new(HubTestState::default());
        let mut config = GatewayWsHubConfig::new("test");
        config.ipc_frame_capacity = 4;
        config.outbound_frame_capacity = 4;
        config.backpressure.timeout_ms = 50;
        let (hub, registry) = test_hub(state.clone(), config).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        config_ping_flood(&session).await;
        wait_until(|| {
            hub.inner
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        })
        .await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 1).await;
        assert!(registry.peek("device").await.is_none());
        hub.stop_all().await;
    }

    #[tokio::test]
    async fn legacy_input_waits_for_runtime_capacity_without_reordering_or_dropping_bytes() {
        let state = Arc::new(HubTestState::default());
        state.block_input_for("device");
        let mut config = GatewayWsHubConfig::new("test");
        config.ipc_frame_capacity = 1;
        let (hub, _) = test_hub(state.clone(), config).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        let inputs = (0..RUNTIME_COMMAND_QUEUE_CAPACITY + 4)
            .map(|index| format!("{index:03}|"))
            .collect::<Vec<_>>();
        let expected = inputs
            .iter()
            .flat_map(|data| crate::tmux::send_input_commands("%1", data.as_bytes()))
            .collect::<Vec<_>>();
        let send = tokio::spawn(async move {
            for (index, data) in inputs.iter().enumerate() {
                send_envelope(
                    &session,
                    MessageKind::TermInput,
                    3 + index as u32,
                    encode_payload(&TermInput {
                        device_id: "device".to_owned(),
                        pane_id: "%1".to_owned(),
                        encoding: 2,
                        data: data.as_bytes().to_vec(),
                        is_composing: false,
                    })
                    .expect("encode terminal input"),
                )
                .await;
            }
            session
        });

        wait_until(|| state.transport("device").command_count("send-keys") == 1).await;
        tokio::task::yield_now().await;
        assert!(!send.is_finished());
        state.release_input();
        let session = timeout(Duration::from_secs(3), send)
            .await
            .expect("all input frames accepted")
            .expect("input sender task");
        wait_until(|| state.transport("device").command_count("send-keys") == expected.len()).await;
        let actual = state
            .transport("device")
            .commands
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|args| args.first().is_some_and(|value| value == "send-keys"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);

        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close session");
        hub.stop_all().await;
    }

    #[tokio::test]
    async fn large_paste_uses_one_runtime_admission_and_does_not_block_session_control_frames() {
        let state = Arc::new(HubTestState::default());
        state.block_input_for("device");
        let (hub, _) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;

        send_envelope(
            &session,
            MessageKind::TermPaste,
            3,
            encode_payload(&TermPaste {
                device_id: "device".to_owned(),
                pane_id: "%1".to_owned(),
                encoding: 1,
                data: vec![b'x'; 400 * 1024],
                is_composing: false,
            })
            .expect("encode large paste"),
        )
        .await;
        wait_until(|| state.transport("device").command_count("send-keys") == 1).await;

        let nonce = Bytes::from_static(b"paste-control");
        session
            .send(GatewayFrame::Ping(nonce.clone()))
            .await
            .expect("send ping while paste is executing");
        let pong = timeout(Duration::from_secs(1), async {
            loop {
                if let Some(GatewayFrame::Pong(payload)) = session.recv().await {
                    break payload;
                }
            }
        })
        .await
        .expect("session actor remains responsive during paste");
        assert_eq!(pong, nonce);

        state.release_input();
        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close session");
        hub.stop_all().await;
    }

    async fn config_ping_flood(session: &GatewaySession) {
        for nonce in 0..32u8 {
            if session
                .send(GatewayFrame::Ping(Bytes::from(vec![nonce])))
                .await
                .is_err()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn mailbox_saturation_aborts_one_session_without_blocking_broadcast() {
        let state = Arc::new(HubTestState::default());
        let mut config = GatewayWsHubConfig::new("test");
        config.session_mailbox_capacity = 1;
        let (hub, _) = test_hub(state, config).await;
        let _session = hub.open_session().expect("open WS session");
        let update = SettingsUpdateS2c {
            namespace: "test".to_owned(),
            server_timestamp: 1,
        };
        hub.inner.broadcast(HubBroadcast::Settings(update.clone()));
        hub.inner.broadcast(HubBroadcast::Settings(update));
        wait_until(|| {
            hub.inner
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        })
        .await;
        hub.stop_all().await;
    }

    #[tokio::test]
    async fn restart_close_waits_for_a_transiently_full_mailbox_and_delivers_1012() {
        let state = Arc::new(HubTestState::default());
        state.block_theme_for("device");
        let mut config = GatewayWsHubConfig::new("test");
        config.session_mailbox_capacity = 1;
        config.initial_theme = Some(ThemeMode::Dark);
        config.backpressure.timeout_ms = 500;
        let (hub, _) = test_hub(state.clone(), config).await;
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        wait_until(|| state.runtime_ready.load(Ordering::Acquire) == 1).await;
        wait_until(|| {
            state
                .transport("device")
                .theme_styles_started
                .load(Ordering::Acquire)
                == 1
        })
        .await;
        hub.inner
            .broadcast(HubBroadcast::Settings(SettingsUpdateS2c {
                namespace: "queued".to_owned(),
                server_timestamp: 1,
            }));

        let close_hub = hub.clone();
        let close = tokio::spawn(async move {
            close_hub
                .close_all(1012, "Gateway runtime restarting")
                .await;
        });
        tokio::task::yield_now().await;
        assert!(!close.is_finished());
        state.release_theme();

        let received = timeout(Duration::from_secs(3), async {
            loop {
                if let Some(GatewayFrame::Close(Some(frame))) = session.recv().await {
                    break frame;
                }
            }
        })
        .await
        .expect("restart close frame");
        assert_eq!(received.code, 1012);
        assert_eq!(received.reason, "Gateway runtime restarting");
        close.await.expect("close-all task");
    }

    #[tokio::test]
    async fn tree_bridge_updates_every_session_but_sets_runtime_name_once() {
        let state = Arc::new(HubTestState::default());
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let mut first = hub.open_session().expect("first WS session");
        let mut second = hub.open_session().expect("second WS session");
        for session in [&first, &second] {
            negotiate(session).await;
        }
        recv_kind(&mut first, MessageKind::HelloS2c).await;
        recv_kind(&mut second, MessageKind::HelloS2c).await;
        for session in [&first, &second] {
            connect(session, "device").await;
        }
        for session in [&mut first, &mut second] {
            recv_kind(session, MessageKind::DeviceConnected).await;
            recv_kind(session, MessageKind::StateSnapshot).await;
        }
        assert_eq!(state.creates.load(Ordering::Acquire), 1);

        hub.rename_window("device", "@1", Some("  Shared name  ".to_owned()))
            .await
            .expect("rename through tree bridge");
        let first_snapshot: StateSnapshot = decode_payload(
            &recv_kind(&mut first, MessageKind::StateSnapshot)
                .await
                .payload,
        )
        .expect("first renamed snapshot");
        let second_snapshot: StateSnapshot = decode_payload(
            &recv_kind(&mut second, MessageKind::StateSnapshot)
                .await
                .payload,
        )
        .expect("second renamed snapshot");
        for snapshot in [&first_snapshot, &second_snapshot] {
            assert_eq!(
                snapshot.session.as_ref().unwrap().windows[0]
                    .custom_name
                    .as_deref(),
                Some("Shared name")
            );
        }
        assert_eq!(hub.tree_custom_names("device").windows["@1"], "Shared name");
        assert_eq!(
            runtime_custom_name(
                &hub.inner
                    .active_runtime("device")
                    .expect("active shared runtime"),
                ProjectionEntityKind::Window,
                "@1",
            )
            .await,
            Some("Shared name".to_owned())
        );

        hub.tree_order_changed(GatewayTreeOrderChange::Windows {
            device_id: "device".to_owned(),
            window_ids: vec!["@1".to_owned()],
        });
        recv_kind(&mut first, MessageKind::StateSnapshot).await;
        recv_kind(&mut second, MessageKind::StateSnapshot).await;
        assert_eq!(
            hub.latest_snapshot("device")
                .await
                .expect("latest snapshot")
                .unwrap()
                .session
                .unwrap()
                .windows[0]
                .custom_name
                .as_deref(),
            Some("Shared name")
        );

        first
            .send(GatewayFrame::Close(None))
            .await
            .expect("close first");
        second
            .send(GatewayFrame::Close(None))
            .await
            .expect("close second");
        hub.stop_all().await;
        assert!(registry.peek("device").await.is_none());
    }

    #[tokio::test]
    async fn offline_tree_overlay_applies_on_connect_and_prunes_disappeared_entities() {
        let state = Arc::new(HubTestState::default());
        let (hub, registry) = test_hub(state, GatewayWsHubConfig::new("test")).await;
        hub.rename_window("tree-device", "@1", Some("Primary".to_owned()))
            .await
            .expect("store offline window name");
        hub.rename_window("tree-device", "@2", Some("Removed".to_owned()))
            .await
            .expect("store second offline window name");
        hub.rename_pane("tree-device", "%1", Some("Shell".to_owned()))
            .await
            .expect("store offline pane name");
        hub.rename_pane("tree-device", "%3", Some("Removed pane".to_owned()))
            .await
            .expect("store second offline pane name");
        hub.tree_order_changed(GatewayTreeOrderChange::Windows {
            device_id: "tree-device".to_owned(),
            window_ids: vec!["@2".to_owned(), "@1".to_owned()],
        });
        hub.tree_order_changed(GatewayTreeOrderChange::Panes {
            device_id: "tree-device".to_owned(),
            window_id: "@1".to_owned(),
            pane_ids: vec!["%2".to_owned(), "%1".to_owned()],
        });

        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "tree-device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        let snapshot: StateSnapshot = decode_payload(
            &recv_kind(&mut session, MessageKind::StateSnapshot)
                .await
                .payload,
        )
        .expect("decode overlaid snapshot");
        let windows = &snapshot.session.as_ref().expect("tmux session").windows;
        assert_eq!(
            windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["@2", "@1"]
        );
        assert_eq!(windows[0].custom_name.as_deref(), Some("Removed"));
        assert_eq!(windows[1].custom_name.as_deref(), Some("Primary"));
        assert_eq!(
            windows[1]
                .panes
                .iter()
                .map(|pane| pane.id.as_str())
                .collect::<Vec<_>>(),
            ["%2", "%1"]
        );
        assert_eq!(windows[1].panes[1].custom_name.as_deref(), Some("Shell"));

        let mut after_close = snapshot;
        let session_snapshot = after_close.session.as_mut().expect("tmux session");
        session_snapshot.windows.retain(|window| window.id == "@1");
        session_snapshot.windows[0]
            .panes
            .retain(|pane| pane.id == "%1");
        let after_close = hub.inner.record_snapshot(after_close);
        let names = hub.tree_custom_names("tree-device");
        assert_eq!(names.windows.keys().collect::<Vec<_>>(), ["@1"]);
        assert_eq!(names.panes.keys().collect::<Vec<_>>(), ["%1"]);
        let order = hub
            .inner
            .tree_orders
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get("tree-device")
            .cloned()
            .expect("retained tree order");
        assert_eq!(order.windows, ["@1"]);
        assert_eq!(order.panes["@1"], ["%1"]);
        let remaining = &after_close.session.expect("remaining tmux session").windows[0];
        assert_eq!(remaining.custom_name.as_deref(), Some("Primary"));
        assert_eq!(remaining.panes[0].custom_name.as_deref(), Some("Shell"));

        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close session");
        hub.stop_all().await;
        assert!(registry.peek("tree-device").await.is_none());
    }

    #[tokio::test]
    async fn runtime_close_reconnects_one_generation_and_releases_both_instances() {
        let state = Arc::new(HubTestState::default());
        let registry = test_registry(state.clone());
        let mut defaults = site_defaults();
        defaults.ssh_reconnect_max_retries = 1;
        let hub = GatewayWsHub::new(
            GatewayWsHubConfig::new("test"),
            GatewayWsHubDependencies {
                runtimes: registry.clone(),
                repository: test_repository().await,
                site_settings_defaults: defaults,
            },
        )
        .expect("valid WS hub test config");
        let mut session = hub.open_session().expect("open WS session");
        negotiate(&session).await;
        recv_kind(&mut session, MessageKind::HelloS2c).await;
        connect(&session, "device").await;
        recv_kind(&mut session, MessageKind::DeviceConnected).await;
        recv_kind(&mut session, MessageKind::StateSnapshot).await;
        let canonical = encode_canonical_command(CanonicalCommand::SetPaneSubscriptions(
            SetPaneSubscriptions {
                generation: 1,
                active_panes: Vec::new(),
                hot_panes: Vec::new(),
            },
        ))
        .expect("encode canonical command");
        let canonical = encode_envelope(
            MessageKind::CanonicalCommand as u16,
            canonical,
            3,
            0,
            CURRENT_VERSION,
        )
        .expect("encode canonical envelope");
        session
            .send(GatewayFrame::Binary(Bytes::from(canonical)))
            .await
            .expect("attach canonical feed");
        recv_kind(&mut session, MessageKind::CanonicalEvent).await;
        let first = registry.peek("device").await.expect("first runtime");
        first.shutdown().await;

        let reconnecting: DeviceEvent = decode_payload(
            &recv_kind(&mut session, MessageKind::DeviceEvent)
                .await
                .payload,
        )
        .expect("reconnecting event");
        assert_eq!(reconnecting.event_type, 3);
        assert_eq!(reconnecting.error_type.as_deref(), Some("reconnecting"));
        let reconnected: DeviceEvent = decode_payload(
            &recv_kind(&mut session, MessageKind::DeviceEvent)
                .await
                .payload,
        )
        .expect("reconnected event");
        assert_eq!(reconnected.event_type, 4);
        wait_until(|| state.creates.load(Ordering::Acquire) == 2).await;
        let second = registry.peek("device").await.expect("replacement runtime");
        assert!(!Arc::ptr_eq(&first, &second));

        session
            .send(GatewayFrame::Close(None))
            .await
            .expect("close reconnected session");
        hub.stop_all().await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 2).await;
        assert!(registry.peek("device").await.is_none());
    }

    #[tokio::test]
    async fn dropping_the_last_hub_handle_cancels_sessions_without_a_strong_cycle() {
        let state = Arc::new(HubTestState::default());
        let (hub, _) = test_hub(state, GatewayWsHubConfig::new("test")).await;
        let weak = Arc::downgrade(&hub.inner);
        let mut session = hub.open_session().expect("open WS session");
        drop(hub);
        assert!(weak.upgrade().is_none());
        timeout(Duration::from_secs(1), async {
            while session.recv().await.is_some() {}
        })
        .await
        .expect("session cancelled when hub drops");
    }

    #[tokio::test]
    async fn theme_apply_finishes_all_styles_before_signals_and_keeps_only_latest_pending() {
        let state = Arc::new(HubTestState::default());
        state.block_theme_for("device-b");
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let runtime_a = registry.acquire("device-a").await.expect("runtime A");
        let runtime_b = registry.acquire("device-b").await.expect("runtime B");
        hub.inner.register_runtime("device-a", &runtime_a);
        hub.inner.register_runtime("device-b", &runtime_b);

        hub.broadcast_site_theme(ThemeMode::Light);
        wait_until(|| {
            state
                .transport("device-b")
                .theme_styles_started
                .load(Ordering::Acquire)
                == 1
        })
        .await;
        assert_eq!(state.transport("device-a").command_count("send-keys"), 0);
        hub.broadcast_site_theme(ThemeMode::Dark);
        hub.broadcast_site_theme(ThemeMode::Light);
        tokio::task::yield_now().await;
        assert_eq!(
            state
                .transport("device-a")
                .theme_styles_started
                .load(Ordering::Acquire),
            1
        );

        state.release_theme();
        wait_until(|| {
            state
                .transport("device-a")
                .theme_styles_started
                .load(Ordering::Acquire)
                == 2
                && state.transport("device-a").command_count("send-keys") == 1
                && state.transport("device-b").command_count("send-keys") == 1
        })
        .await;
        assert_eq!(
            state
                .transport("device-b")
                .theme_styles_started
                .load(Ordering::Acquire),
            2
        );
        assert_eq!(
            state
                .transport("device-a")
                .command_contains("set-hook", "fg=#d0d0d0,bg=#262626"),
            0
        );

        hub.stop_all().await;
        registry.release("device-a", Some(&runtime_a)).await;
        registry.release("device-b", Some(&runtime_b)).await;
    }

    #[tokio::test]
    async fn set_window_style_targets_one_runtime_then_globally_signals_with_dedup() {
        let state = Arc::new(HubTestState::default());
        let (hub, registry) = test_hub(state.clone(), GatewayWsHubConfig::new("test")).await;
        let runtime_a = registry.acquire("device-a").await.expect("runtime A");
        let runtime_b = registry.acquire("device-b").await.expect("runtime B");
        hub.inner.register_runtime("device-a", &runtime_a);
        hub.inner.register_runtime("device-b", &runtime_b);
        *hub.inner
            .current_theme
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ThemeMode::Dark);

        set_window_style_and_broadcast_theme(
            Arc::downgrade(&hub.inner),
            "device-a".to_owned(),
            runtime_a.clone(),
            "fg=#123456".to_owned(),
        )
        .await
        .expect("set target style");
        assert_eq!(
            state
                .transport("device-a")
                .command_contains("set-hook", "fg=#123456"),
            1
        );
        assert_eq!(
            state
                .transport("device-b")
                .command_contains("set-hook", "fg=#123456"),
            0
        );
        assert_eq!(state.transport("device-a").command_count("send-keys"), 1);
        assert_eq!(state.transport("device-b").command_count("send-keys"), 1);

        set_window_style_and_broadcast_theme(
            Arc::downgrade(&hub.inner),
            "device-a".to_owned(),
            runtime_a.clone(),
            "fg=#abcdef".to_owned(),
        )
        .await
        .expect("set repeated target style");
        assert_eq!(state.transport("device-a").command_count("send-keys"), 1);
        assert_eq!(state.transport("device-b").command_count("send-keys"), 1);

        hub.stop_all().await;
        registry.release("device-a", Some(&runtime_a)).await;
        registry.release("device-b", Some(&runtime_b)).await;
    }

    #[tokio::test]
    async fn unconfirmed_canonical_acquire_and_stale_snapshot_job_are_discarded() {
        let state = Arc::new(HubTestState::default());
        let registry = test_registry(state.clone());
        let pool = Arc::new(RuntimePool::new(registry.clone()));
        let _runtime = pool
            .acquire_canonical("unconfirmed")
            .await
            .expect("acquire canonical runtime");
        pool.release_unconfirmed_canonical().await;
        wait_until(|| state.closes.load(Ordering::Acquire) == 1).await;
        assert!(registry.peek("unconfirmed").await.is_none());

        let (hub, _) = test_hub(
            Arc::new(HubTestState::default()),
            GatewayWsHubConfig::new("test"),
        )
        .await;
        let (sender, receiver) = mpsc::channel(1);
        let (outbound, _outbound_receiver) = OutboundQueue::new(
            1,
            BackpressureConfig::default(),
            SessionAbort::new(),
            Arc::new(AtomicUsize::new(0)),
        );
        let mut actor = GatewaySessionActor::new(
            99,
            &hub.inner,
            sender,
            receiver,
            SessionAbort::new(),
            outbound,
        );
        let runtime = test_registry(Arc::new(HubTestState::default()))
            .acquire("snapshot-device")
            .await
            .expect("snapshot runtime");
        actor.runtime_subscriptions.insert(
            "snapshot-device".to_owned(),
            RuntimeSubscription {
                runtime,
                generation: 7,
                legacy: false,
                task: tokio::spawn(std::future::pending()),
            },
        );
        actor.snapshot_jobs.insert("snapshot-device".to_owned(), 2);
        actor
            .handle_actor_message(ActorMessage::PreparedSnapshot {
                device_id: "snapshot-device".to_owned(),
                generation: 7,
                job: 1,
                snapshot: StateSnapshot {
                    device_id: "stale".to_owned(),
                    session: None,
                },
            })
            .await;
        assert!(!actor.snapshots.contains_key("snapshot-device"));
        actor.cleanup().await;
        hub.stop_all().await;
    }

    #[tokio::test]
    async fn source_metadata_and_lifecycle_do_not_invent_legacy_tmux_events() {
        let (hub, _) = test_hub(
            Arc::new(HubTestState::default()),
            GatewayWsHubConfig::new("test"),
        )
        .await;
        let (sender, receiver) = mpsc::channel(1);
        let abort = SessionAbort::new();
        let (outbound, mut outbound_receiver) = OutboundQueue::new(
            4,
            BackpressureConfig::default(),
            abort.clone(),
            Arc::new(AtomicUsize::new(0)),
        );
        let mut actor =
            GatewaySessionActor::new(100, &hub.inner, sender, receiver, abort.clone(), outbound);

        actor
            .handle_runtime_event(
                "device",
                1,
                TmuxRuntimeEvent::SourceMetadata(SourceMetadataEvent::WindowRenamed {
                    window_id: "@1".to_owned(),
                    name: "renamed".to_owned(),
                }),
            )
            .await;
        actor
            .handle_runtime_event(
                "device",
                1,
                TmuxRuntimeEvent::Lifecycle(LifecycleEvent {
                    kind: LifecycleEventKind::TmuxWindowClose,
                    tmux: LifecycleTmuxContext {
                        window_id: Some("@1".to_owned()),
                        ..LifecycleTmuxContext::default()
                    },
                    payload: BTreeMap::new(),
                }),
            )
            .await;
        assert!(matches!(
            outbound_receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        actor.cleanup().await;
        hub.stop_all().await;
    }
}
