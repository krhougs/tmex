use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tmex_protocol::{
    SourceMetadataValue, WatchEvent, SOURCE_ENTITY_PANE, SOURCE_ENTITY_WINDOW,
    SOURCE_FIELD_CUSTOM_NAME,
};
use tokio::runtime::Handle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::agent::{AgentStopReason, AgentSupervisor};
use crate::events::{EventDraft, EventNotifier, EventType};
use crate::i18n::GatewayI18n;
use crate::state::CanonicalFeedRuntime;
use crate::tmux::{
    DeviceCanonicalRuntime, DeviceSessionRuntime, DeviceSessionRuntimeError, TmuxRuntimeEvent,
    TmuxRuntimeRegistry,
};
use crate::ws::WatchEventBroadcaster;

use super::{
    WatchDevice, WatchDeviceListener, WatchFuture, WatchIntervalCallback, WatchLlmRequest,
    WatchLlmResponse, WatchMessage, WatchRuntime, WatchRuntimeError, WatchSchedule,
    WatchSubscription, WatchTmuxEntityKind,
};

type WatchLeaseMap = HashMap<usize, Weak<TmuxWatchDevice>>;
type SharedWatchLeaseMap = Arc<Mutex<WatchLeaseMap>>;
type WeakWatchLeaseMap = Weak<Mutex<WatchLeaseMap>>;
type WatchTranslation = (&'static str, Vec<(&'static str, String)>);

#[async_trait]
pub trait WatchModelGenerator: Send + Sync {
    async fn generate(
        &self,
        request: WatchLlmRequest,
    ) -> Result<WatchLlmResponse, WatchRuntimeError>;
}

#[async_trait]
pub trait WatchNotificationSink: Send + Sync {
    async fn notify(
        &self,
        event_type: EventType,
        event: EventDraft,
    ) -> Result<(), WatchRuntimeError>;
}

#[async_trait]
impl WatchNotificationSink for EventNotifier {
    async fn notify(
        &self,
        event_type: EventType,
        event: EventDraft,
    ) -> Result<(), WatchRuntimeError> {
        EventNotifier::notify(self, event_type, event)
            .await
            .map(|_| ())
            .map_err(|error| WatchRuntimeError::new(error.to_string()))
    }
}

pub trait WatchMessageFormatter: Send + Sync {
    fn format_message(&self, message: &WatchMessage) -> String;
}

impl WatchMessageFormatter for GatewayI18n {
    fn format_message(&self, message: &WatchMessage) -> String {
        let (key, parameters) = watch_message_translation(message);
        let parameters = parameters.into_iter().collect::<HashMap<_, _>>();
        let translated = self.translate_with(key, &parameters);
        if translated == key {
            message.fallback_english()
        } else {
            translated
        }
    }
}

#[async_trait]
pub trait WatchDeviceCloseSink: Send + Sync {
    async fn device_closed(&self, device_id: &str) -> Result<(), WatchRuntimeError>;
}

#[async_trait]
impl WatchDeviceCloseSink for AgentSupervisor {
    async fn device_closed(&self, device_id: &str) -> Result<(), WatchRuntimeError> {
        self.stop_sessions_for_device(device_id, AgentStopReason::PaneLost)
            .await
            .map_err(|error| WatchRuntimeError::new(error.to_string()))
    }
}

pub struct GatewayWatchRuntimeDependencies {
    pub runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    pub notifications: Arc<dyn WatchNotificationSink>,
    pub watch_events: Arc<dyn WatchEventBroadcaster>,
    pub messages: Arc<dyn WatchMessageFormatter>,
    pub model_generator: Option<Arc<dyn WatchModelGenerator>>,
    pub device_close: Arc<dyn WatchDeviceCloseSink>,
}

pub struct GatewayWatchRuntime {
    dependencies: GatewayWatchRuntimeDependencies,
    leases: SharedWatchLeaseMap,
}

impl GatewayWatchRuntime {
    pub fn new(dependencies: GatewayWatchRuntimeDependencies) -> Self {
        Self {
            dependencies,
            leases: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl WatchRuntime for GatewayWatchRuntime {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn schedule_interval(
        &self,
        interval: Duration,
        callback: WatchIntervalCallback,
    ) -> Result<Arc<dyn WatchSchedule>, WatchRuntimeError> {
        if interval.is_zero() {
            return Err(WatchRuntimeError::new(
                "watch interval must be greater than zero",
            ));
        }
        let handle = Handle::try_current()
            .map_err(|_| WatchRuntimeError::new("watch scheduler requires a Tokio runtime"))?;
        Ok(Arc::new(TokioWatchSchedule::start(
            handle, interval, callback,
        )))
    }

    fn spawn(&self, future: WatchFuture) {
        match Handle::try_current() {
            Ok(handle) => drop(handle.spawn(future)),
            Err(error) => {
                tracing::error!(%error, "watch task requires a Tokio runtime");
                drop(future);
            }
        }
    }

    async fn acquire_device(
        &self,
        device_id: &str,
    ) -> Result<Arc<dyn WatchDevice>, WatchRuntimeError> {
        let runtime = self
            .dependencies
            .runtimes
            .acquire(device_id)
            .await
            .map_err(|error| {
                WatchRuntimeError::new(format!(
                    "failed to acquire tmux runtime for device {device_id}: {error}"
                ))
            })?;
        let handle = match Handle::try_current() {
            Ok(handle) => handle,
            Err(error) => {
                self.dependencies
                    .runtimes
                    .release(device_id, Some(&runtime))
                    .await;
                return Err(WatchRuntimeError::new(format!(
                    "watch device lease requires a Tokio runtime: {error}"
                )));
            }
        };
        let device = match TmuxWatchDevice::new(
            device_id.to_owned(),
            runtime.clone(),
            self.dependencies.runtimes.clone(),
            handle,
            Arc::downgrade(&self.leases),
        ) {
            Ok(device) => Arc::new(device),
            Err(error) => {
                self.dependencies
                    .runtimes
                    .release(device_id, Some(&runtime))
                    .await;
                return Err(error);
            }
        };
        let erased: Arc<dyn WatchDevice> = device.clone();
        let key = watch_device_key(&erased);
        device.set_lease_key(key);
        lock(&self.leases).insert(key, Arc::downgrade(&device));
        Ok(erased)
    }

    async fn release_device(
        &self,
        device_id: &str,
        device: Arc<dyn WatchDevice>,
    ) -> Result<(), WatchRuntimeError> {
        let key = watch_device_key(&device);
        let concrete = {
            let mut leases = lock(&self.leases);
            leases.retain(|_, lease| lease.strong_count() > 0);
            let lease = leases.get(&key).cloned().ok_or_else(|| {
                WatchRuntimeError::new("watch device lease is not owned by this runtime")
            })?;
            let concrete = lease
                .upgrade()
                .ok_or_else(|| WatchRuntimeError::new("watch device lease is no longer active"))?;
            let erased: Arc<dyn WatchDevice> = concrete.clone();
            if !Arc::ptr_eq(&erased, &device) {
                return Err(WatchRuntimeError::new(
                    "watch device lease identity does not match",
                ));
            }
            if concrete.device_id != device_id {
                return Err(WatchRuntimeError::new(format!(
                    "watch device lease belongs to {}, not {device_id}",
                    concrete.device_id
                )));
            }
            leases.remove(&key);
            concrete
        };
        concrete.release().await;
        Ok(())
    }

    async fn generate(
        &self,
        request: WatchLlmRequest,
    ) -> Result<WatchLlmResponse, WatchRuntimeError> {
        let generator = self
            .dependencies
            .model_generator
            .as_ref()
            .ok_or_else(|| WatchRuntimeError::new("watch model generator is not configured"))?;
        generator.generate(request).await
    }

    async fn notify(
        &self,
        event_type: EventType,
        event: EventDraft,
    ) -> Result<(), WatchRuntimeError> {
        self.dependencies
            .notifications
            .notify(event_type, event)
            .await
    }

    fn broadcast(&self, event: WatchEvent) -> Result<(), WatchRuntimeError> {
        self.dependencies
            .watch_events
            .broadcast_watch_event(event)
            .map_err(|error| WatchRuntimeError::new(error.to_string()))
    }

    fn device_closed(&self, device_id: &str) -> Result<(), WatchRuntimeError> {
        let handle = Handle::try_current().map_err(|_| {
            WatchRuntimeError::new("watch device-close notification requires a Tokio runtime")
        })?;
        let sink = self.dependencies.device_close.clone();
        let device_id = device_id.to_owned();
        drop(handle.spawn(async move {
            if let Err(error) = sink.device_closed(&device_id).await {
                tracing::error!(device_id, %error, "watch device-close notification failed");
            }
        }));
        Ok(())
    }

    fn format_message(&self, message: &WatchMessage) -> String {
        self.dependencies.messages.format_message(message)
    }
}

pub struct TmuxWatchDevice {
    device_id: String,
    runtime: Arc<DeviceSessionRuntime>,
    canonical: DeviceCanonicalRuntime,
    lease_key: Mutex<Option<usize>>,
    leases: WeakWatchLeaseMap,
    release: Arc<RegistryRelease>,
}

impl TmuxWatchDevice {
    fn new(
        device_id: String,
        runtime: Arc<DeviceSessionRuntime>,
        registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
        handle: Handle,
        leases: WeakWatchLeaseMap,
    ) -> Result<Self, WatchRuntimeError> {
        let canonical = DeviceCanonicalRuntime::new(runtime.as_ref().clone())
            .map_err(|error| WatchRuntimeError::new(error.to_string()))?;
        Ok(Self {
            device_id: device_id.clone(),
            runtime: runtime.clone(),
            canonical,
            lease_key: Mutex::new(None),
            leases,
            release: Arc::new(RegistryRelease {
                device_id,
                runtime,
                registry,
                handle,
                started: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                finished_notify: tokio::sync::Notify::new(),
            }),
        })
    }

    fn ensure_active(&self) -> Result<(), WatchRuntimeError> {
        if self.release.started.load(Ordering::Acquire) || self.runtime.is_terminated() {
            Err(WatchRuntimeError::new(format!(
                "tmux runtime for device {} is closed",
                self.device_id
            )))
        } else {
            Ok(())
        }
    }

    async fn release(&self) {
        self.release.wait().await;
    }

    fn set_lease_key(&self, key: usize) {
        *lock(&self.lease_key) = Some(key);
    }
}

impl Drop for TmuxWatchDevice {
    fn drop(&mut self) {
        if let (Some(key), Some(leases)) = (*lock(&self.lease_key), self.leases.upgrade()) {
            lock(&leases).remove(&key);
        }
        self.release.start();
    }
}

#[async_trait]
impl WatchDevice for TmuxWatchDevice {
    async fn connect(&self) -> Result<(), WatchRuntimeError> {
        self.ensure_active()
    }

    async fn capture_pane_text(&self, pane_id: &str) -> Result<String, WatchRuntimeError> {
        self.ensure_active()?;
        self.runtime
            .capture_pane_text(pane_id, None)
            .await
            .map_err(|error| {
                WatchRuntimeError::new(format!(
                    "failed to capture pane {pane_id} on device {}: {error}",
                    self.device_id
                ))
            })
    }

    fn subscribe(
        &self,
        listener: Arc<dyn WatchDeviceListener>,
    ) -> Result<Arc<dyn WatchSubscription>, WatchRuntimeError> {
        self.ensure_active()?;
        let mut events = self.runtime.subscribe();
        if self.runtime.is_terminated() {
            return Err(WatchRuntimeError::new(format!(
                "tmux runtime for device {} is closed",
                self.device_id
            )));
        }
        let handle = Handle::try_current().map_err(|_| {
            WatchRuntimeError::new("watch tmux subscription requires a Tokio runtime")
        })?;
        let active = Arc::new(AtomicBool::new(true));
        let active_for_task = active.clone();
        let runtime = self.runtime.clone();
        let task = handle.spawn(async move {
            loop {
                match events.recv().await {
                    Ok(TmuxRuntimeEvent::Snapshot(next)) => {
                        if active_for_task.load(Ordering::Acquire) {
                            listener.on_snapshot(next);
                        }
                    }
                    Ok(TmuxRuntimeEvent::Closed { manual, .. }) => {
                        if active_for_task.swap(false, Ordering::AcqRel) && !manual {
                            listener.on_close();
                        }
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        match runtime.request_snapshot() {
                            Ok(()) => {}
                            Err(DeviceSessionRuntimeError::Closed) => {
                                if active_for_task.swap(false, Ordering::AcqRel) {
                                    listener.on_close();
                                }
                                break;
                            }
                            Err(error) => tracing::warn!(
                                skipped,
                                %error,
                                "failed to request watch snapshot after tmux event lag"
                            ),
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        if active_for_task.swap(false, Ordering::AcqRel) {
                            listener.on_close();
                        }
                        break;
                    }
                    Ok(_) => {}
                }
            }
        });
        Ok(Arc::new(TmuxWatchSubscription {
            active,
            task: Mutex::new(Some(task)),
        }))
    }

    fn request_snapshot(&self) -> Result<(), WatchRuntimeError> {
        self.ensure_active()?;
        self.runtime.request_snapshot().map_err(|error| {
            WatchRuntimeError::new(format!(
                "failed to request tmux snapshot for device {}: {error}",
                self.device_id
            ))
        })
    }

    fn custom_name(&self, kind: WatchTmuxEntityKind, native_id: &str) -> Option<String> {
        if self.release.started.load(Ordering::Acquire) {
            return None;
        }
        let entity_kind = match kind {
            WatchTmuxEntityKind::Window => SOURCE_ENTITY_WINDOW,
            WatchTmuxEntityKind::Pane => SOURCE_ENTITY_PANE,
        };
        self.canonical
            .get_metadata_snapshot()
            .records
            .into_iter()
            .find(|record| {
                record.key.entity_kind == entity_kind && record.key.native_id == native_id
            })
            .and_then(|record| {
                record
                    .fields
                    .into_iter()
                    .find(|field| field.field == SOURCE_FIELD_CUSTOM_NAME)
            })
            .and_then(|field| match field.value {
                SourceMetadataValue::String(value) if !value.is_empty() => Some(value),
                _ => None,
            })
    }
}

struct RegistryRelease {
    device_id: String,
    runtime: Arc<DeviceSessionRuntime>,
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    handle: Handle,
    started: AtomicBool,
    finished: AtomicBool,
    finished_notify: tokio::sync::Notify,
}

impl RegistryRelease {
    fn start(self: &Arc<Self>) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let release = self.clone();
        drop(self.handle.spawn(async move {
            release
                .registry
                .release(&release.device_id, Some(&release.runtime))
                .await;
            release.finished.store(true, Ordering::Release);
            release.finished_notify.notify_waiters();
        }));
    }

    async fn wait(self: &Arc<Self>) {
        self.start();
        loop {
            let notified = self.finished_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.finished.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

struct TmuxWatchSubscription {
    active: Arc<AtomicBool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl TmuxWatchSubscription {
    fn cancel(&self) {
        self.active.store(false, Ordering::Release);
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
    }
}

impl WatchSubscription for TmuxWatchSubscription {
    fn detach(&self) {
        self.cancel();
    }
}

impl Drop for TmuxWatchSubscription {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct TokioWatchSchedule {
    active: Arc<AtomicBool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl TokioWatchSchedule {
    fn start(handle: Handle, interval: Duration, callback: WatchIntervalCallback) -> Self {
        let active = Arc::new(AtomicBool::new(true));
        let active_for_task = active.clone();
        let child_handle = handle.clone();
        let task = handle.spawn(async move {
            let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                if !active_for_task.load(Ordering::Acquire) {
                    break;
                }
                let active_for_callback = active_for_task.clone();
                let callback = callback.clone();
                drop(child_handle.spawn(async move {
                    if active_for_callback.load(Ordering::Acquire) {
                        callback().await;
                    }
                }));
            }
        });
        Self {
            active,
            task: Mutex::new(Some(task)),
        }
    }

    fn cancel_inner(&self) {
        self.active.store(false, Ordering::Release);
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
    }
}

impl WatchSchedule for TokioWatchSchedule {
    fn cancel(&self) {
        self.cancel_inner();
    }
}

impl Drop for TokioWatchSchedule {
    fn drop(&mut self) {
        self.cancel_inner();
    }
}

fn watch_device_key(device: &Arc<dyn WatchDevice>) -> usize {
    Arc::as_ptr(device) as *const () as usize
}

fn watch_message_translation(message: &WatchMessage) -> WatchTranslation {
    match message {
        WatchMessage::MatchTriggered { name, text } => (
            "notification.watch.matchTriggered",
            vec![("name", name.clone()), ("text", text.clone())],
        ),
        WatchMessage::UnchangedTriggered {
            name,
            value,
            minutes,
        } => (
            "notification.watch.unchangedTriggered",
            vec![
                ("name", name.clone()),
                ("value", value.clone()),
                ("minutes", minutes.to_string()),
            ],
        ),
        WatchMessage::LlmTriggered { name, reason } => (
            "notification.watch.llmTriggered",
            vec![("name", name.clone()), ("reason", reason.clone())],
        ),
        WatchMessage::SummaryTriggered { name, summary } => (
            "notification.watch.summaryTriggered",
            vec![("name", name.clone()), ("summary", summary.clone())],
        ),
        WatchMessage::UnconfirmedSuffix => ("notification.watch.unconfirmedSuffix", Vec::new()),
        WatchMessage::ModelUnavailable { name, message } => (
            "notification.watch.modelUnavailable",
            vec![("name", name.clone()), ("message", message.clone())],
        ),
        WatchMessage::RuleError {
            name,
            count,
            message,
        } => (
            "notification.watch.ruleError",
            vec![
                ("name", name.clone()),
                ("count", count.to_string()),
                ("message", message.clone()),
            ],
        ),
        WatchMessage::PaneGone { name, pane_id } => (
            "notification.watch.paneGone",
            vec![("name", name.clone()), ("paneId", pane_id.clone())],
        ),
    }
}

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicUsize;

    use tmex_protocol::{StateSnapshot, WatchEvent};
    use tokio::sync::Semaphore;
    use tokio::time::timeout;

    use crate::tmux::{
        ControlClient, DeviceSessionConfig, LocalTmuxConfig, ProjectionEntityKind,
        RuntimeRegistryError, StandaloneSpawnPolicy, TmuxCommandResult, TmuxRuntimeFactory,
        TmuxTransport, TmuxTransportConfig, TmuxTransportError, TmuxTransportFactory,
        SESSION_SNAPSHOT_FORMAT, TMEX_SERVER_EPOCH_OPTION, WINDOW_SNAPSHOT_FORMAT,
    };
    use crate::ws::GatewayWsHubError;

    use super::*;

    type TestRuntimeParts = (
        Arc<GatewayWatchRuntime>,
        Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    );

    struct TestTransport {
        close_gate: Option<Arc<Semaphore>>,
        close_started: Arc<AtomicUsize>,
        close_finished: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl TmuxTransport for TestTransport {
        async fn run_tmux(
            &self,
            args: &[String],
            _deadline: Duration,
            _output_limit: usize,
        ) -> Result<TmuxCommandResult, TmuxTransportError> {
            let first = args.first().map(String::as_str);
            let last = args.last().map(String::as_str);
            let stdout = match (first, last) {
                (Some("tmux-unused"), _) => String::new(),
                (Some("-V"), _) => "tmux 3.4\n".to_owned(),
                (Some("show-options"), Some(TMEX_SERVER_EPOCH_OPTION)) => {
                    "00000000000000000000000000000000\n".to_owned()
                }
                (Some("display-message"), Some(SESSION_SNAPSHOT_FORMAT)) => {
                    "$1|watch-runtime-test\n".to_owned()
                }
                (Some("list-windows"), Some(WINDOW_SNAPSHOT_FORMAT)) => {
                    "@1|0|1|layout|native-window\n".to_owned()
                }
                (Some("list-panes"), _) => "%1|@1|0|1|80|24|0|0|1|native-pane|sh|/tmp\n".to_owned(),
                (Some("display-message"), Some("#{session_windows}")) => "1\n".to_owned(),
                _ => String::new(),
            };
            Ok(TmuxCommandResult {
                exit_code: 0,
                stdout,
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
            "tmux-unused"
        }

        async fn close(&self) -> Result<(), TmuxTransportError> {
            self.close_started.fetch_add(1, Ordering::AcqRel);
            if let Some(gate) = &self.close_gate {
                let permit = gate.acquire().await.expect("close gate");
                permit.forget();
            }
            self.close_finished.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    struct TestTransportFactory {
        transport: Arc<TestTransport>,
    }

    #[async_trait]
    impl TmuxTransportFactory for TestTransportFactory {
        async fn create(
            &self,
            _config: &DeviceSessionConfig,
        ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError> {
            Ok(self.transport.clone())
        }
    }

    fn runtime_config(device_id: String) -> DeviceSessionConfig {
        DeviceSessionConfig {
            device_id,
            device_name: Some("test device".to_owned()),
            session_name: "watch-runtime-test".to_owned(),
            default_working_dir: Some("/tmp".to_owned()),
            tmux_term_program: "off".to_owned(),
            tmux_window_style: String::new(),
            allow_passthrough: false,
            enable_control_mode: false,
            transport: TmuxTransportConfig::Local(LocalTmuxConfig {
                tmux_bin: "tmux-unused".to_owned(),
                socket_name: Some("watch-runtime-test".to_owned()),
                environment: BTreeMap::new(),
            }),
            spawn_policy: Arc::new(StandaloneSpawnPolicy),
        }
    }

    struct NoopNotificationSink;

    #[async_trait]
    impl WatchNotificationSink for NoopNotificationSink {
        async fn notify(
            &self,
            _event_type: EventType,
            _event: EventDraft,
        ) -> Result<(), WatchRuntimeError> {
            Ok(())
        }
    }

    struct NoopBroadcaster;

    impl WatchEventBroadcaster for NoopBroadcaster {
        fn broadcast_watch_event(&self, _event: WatchEvent) -> Result<(), GatewayWsHubError> {
            Ok(())
        }
    }

    struct FallbackFormatter;

    impl WatchMessageFormatter for FallbackFormatter {
        fn format_message(&self, message: &WatchMessage) -> String {
            message.fallback_english()
        }
    }

    struct NoopDeviceClose;

    #[async_trait]
    impl WatchDeviceCloseSink for NoopDeviceClose {
        async fn device_closed(&self, _device_id: &str) -> Result<(), WatchRuntimeError> {
            Ok(())
        }
    }

    fn test_runtime(close_gate: Option<Arc<Semaphore>>) -> TestRuntimeParts {
        let close_started = Arc::new(AtomicUsize::new(0));
        let close_finished = Arc::new(AtomicUsize::new(0));
        let transport_factory: Arc<dyn TmuxTransportFactory> = Arc::new(TestTransportFactory {
            transport: Arc::new(TestTransport {
                close_gate,
                close_started: close_started.clone(),
                close_finished: close_finished.clone(),
            }),
        });
        let runtime_factory: Arc<dyn TmuxRuntimeFactory<DeviceSessionRuntime>> =
            Arc::new(move |device_id: String| {
                let transport_factory = transport_factory.clone();
                async move {
                    DeviceSessionRuntime::start(
                        runtime_config(device_id.clone()),
                        transport_factory,
                    )
                    .await
                    .map(Arc::new)
                    .map_err(|error| {
                        RuntimeRegistryError::new(format!(
                            "failed to start test runtime {device_id}: {error}"
                        ))
                    })
                }
            });
        let registry = Arc::new(TmuxRuntimeRegistry::new(runtime_factory));
        let runtime = Arc::new(GatewayWatchRuntime::new(GatewayWatchRuntimeDependencies {
            runtimes: registry.clone(),
            notifications: Arc::new(NoopNotificationSink),
            watch_events: Arc::new(NoopBroadcaster),
            messages: Arc::new(FallbackFormatter),
            model_generator: None,
            device_close: Arc::new(NoopDeviceClose),
        }));
        (runtime, registry, close_started, close_finished)
    }

    struct CountingListener {
        snapshots: AtomicUsize,
        closes: AtomicUsize,
    }

    impl CountingListener {
        fn new() -> Self {
            Self {
                snapshots: AtomicUsize::new(0),
                closes: AtomicUsize::new(0),
            }
        }
    }

    impl WatchDeviceListener for CountingListener {
        fn on_snapshot(&self, _snapshot: StateSnapshot) {
            self.snapshots.fetch_add(1, Ordering::AcqRel);
        }

        fn on_close(&self) {
            self.closes.fetch_add(1, Ordering::AcqRel);
        }
    }

    async fn wait_until(predicate: impl Fn() -> bool) {
        timeout(Duration::from_secs(2), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition should become true");
    }

    #[tokio::test]
    async fn device_release_is_identity_bound_and_survives_caller_cancellation() {
        let gate = Arc::new(Semaphore::new(0));
        let (host, registry, close_started, close_finished) = test_runtime(Some(gate.clone()));
        let device = host.acquire_device("cancel-device").await.unwrap();
        assert!(host
            .release_device("other-device", device.clone())
            .await
            .is_err());
        let concrete = registry.peek("cancel-device").await.unwrap();

        let release = tokio::spawn({
            let host = host.clone();
            let device = device.clone();
            async move { host.release_device("cancel-device", device).await }
        });
        wait_until(|| close_started.load(Ordering::Acquire) == 1).await;
        release.abort();
        assert!(release.await.unwrap_err().is_cancelled());
        gate.add_permits(1);
        wait_until(|| concrete.is_terminated()).await;
        assert_eq!(close_finished.load(Ordering::Acquire), 1);
        drop(device);
        tokio::task::yield_now().await;
        assert_eq!(close_started.load(Ordering::Acquire), 1);

        let dropped = host.acquire_device("drop-device").await.unwrap();
        let dropped_runtime = registry.peek("drop-device").await.unwrap();
        drop(dropped);
        wait_until(|| close_started.load(Ordering::Acquire) == 2).await;
        gate.add_permits(1);
        wait_until(|| dropped_runtime.is_terminated()).await;
        assert_eq!(close_finished.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn subscription_rehydrates_snapshot_and_detach_suppresses_manual_close() {
        let (host, registry, _close_started, _close_finished) = test_runtime(None);
        let device = host.acquire_device("subscription-device").await.unwrap();
        let listener = Arc::new(CountingListener::new());
        let subscription = device.subscribe(listener.clone()).unwrap();
        let detached_listener = Arc::new(CountingListener::new());
        let detached = device.subscribe(detached_listener.clone()).unwrap();
        detached.detach();

        device.request_snapshot().unwrap();
        wait_until(|| listener.snapshots.load(Ordering::Acquire) > 0).await;
        let runtime = registry.peek("subscription-device").await.unwrap();
        runtime
            .set_custom_name(
                ProjectionEntityKind::Pane,
                "%1",
                Some("renamed pane".to_owned()),
            )
            .await
            .unwrap();
        wait_until(|| {
            device
                .custom_name(WatchTmuxEntityKind::Pane, "%1")
                .as_deref()
                == Some("renamed pane")
        })
        .await;

        registry.shutdown_all().await;
        tokio::task::yield_now().await;
        assert_eq!(listener.closes.load(Ordering::Acquire), 0);
        assert_eq!(detached_listener.closes.load(Ordering::Acquire), 0);
        assert_eq!(detached_listener.snapshots.load(Ordering::Acquire), 0);
        subscription.detach();
        host.release_device("subscription-device", device)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn interval_waits_for_first_period_and_cancel_stops_future_ticks() {
        let (host, _registry, _close_started, _close_finished) = test_runtime(None);
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticked = Arc::new(Semaphore::new(0));
        let callback: WatchIntervalCallback = Arc::new({
            let ticks = ticks.clone();
            let ticked = ticked.clone();
            move || {
                let ticks = ticks.clone();
                let ticked = ticked.clone();
                Box::pin(async move {
                    ticks.fetch_add(1, Ordering::AcqRel);
                    ticked.add_permits(1);
                })
            }
        });
        let schedule = host
            .schedule_interval(Duration::from_millis(50), callback)
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(ticks.load(Ordering::Acquire), 0);
        let permit = timeout(Duration::from_secs(1), ticked.acquire())
            .await
            .expect("first interval tick")
            .expect("tick semaphore");
        permit.forget();
        assert_eq!(ticks.load(Ordering::Acquire), 1);
        schedule.cancel();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(ticks.load(Ordering::Acquire), 1);
    }
}
