use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::future::join_all;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tmex_protocol::{PaneWire, StateSnapshot, SOURCE_ENTITY_PANE, SOURCE_ENTITY_WINDOW};
use tmex_terminal::{PaneStreamNotification, PaneStreamNotificationSource};

use crate::entity::devices;
use crate::events::{EventDevice, EventDraft, EventSite, EventTmux, EventType};
use crate::tmux::{LifecycleEventKind, TmuxRuntimeEvent};

use super::runtime::{PushTask, RuntimeConnection};
use super::{
    ConnectionAlertInput, ConnectionAlertNotifier, ConnectionAlertSource, PushDeviceCloseSink,
    PushError, PushEventSink, PushRuntimeHost, PushRuntimeLease, PushRuntimeListener,
    PushScheduledTask, PushScheduler, PushStore, PushTranslator,
};

const DEFAULT_FALLBACK_RECONNECT_DELAY: Duration = Duration::from_secs(60);
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

pub struct PushSupervisorDependencies {
    pub store: Arc<dyn PushStore>,
    pub runtimes: Arc<dyn PushRuntimeHost>,
    pub alerts: ConnectionAlertNotifier,
    pub events: Arc<dyn PushEventSink>,
    pub device_close: Option<Arc<dyn PushDeviceCloseSink>>,
    pub translator: Arc<dyn PushTranslator>,
    pub scheduler: Arc<dyn PushScheduler>,
    pub fallback_reconnect_delay: Duration,
}

impl PushSupervisorDependencies {
    pub fn with_default_reconnect_delay(
        store: Arc<dyn PushStore>,
        runtimes: Arc<dyn PushRuntimeHost>,
        alerts: ConnectionAlertNotifier,
        events: Arc<dyn PushEventSink>,
        device_close: Option<Arc<dyn PushDeviceCloseSink>>,
        translator: Arc<dyn PushTranslator>,
        scheduler: Arc<dyn PushScheduler>,
    ) -> Self {
        Self {
            store,
            runtimes,
            alerts,
            events,
            device_close,
            translator,
            scheduler,
            fallback_reconnect_delay: DEFAULT_FALLBACK_RECONNECT_DELAY,
        }
    }
}

#[derive(Clone)]
pub struct PushSupervisor {
    inner: Arc<PushSupervisorInner>,
}

struct PushSupervisorInner {
    dependencies: PushSupervisorDependencies,
    lifecycle: tokio::sync::Mutex<()>,
    state: Mutex<SupervisorState>,
}

#[derive(Default)]
struct SupervisorState {
    running: bool,
    entries: HashMap<String, Arc<PushEntry>>,
}

struct PushEntry {
    device_id: String,
    generation: AtomicU64,
    reconnect_attempts: AtomicU32,
    connection: Mutex<Option<RuntimeConnection>>,
    reconnect_task: Mutex<Option<Arc<dyn PushScheduledTask>>>,
    last_snapshot: Mutex<Option<StateSnapshot>>,
    connected_device: Mutex<Option<devices::Model>>,
    session_closed_emitted: AtomicBool,
    close_handled_generation: Mutex<Option<u64>>,
}

impl PushEntry {
    fn new(device_id: String) -> Self {
        Self {
            device_id,
            generation: AtomicU64::new(1),
            reconnect_attempts: AtomicU32::new(0),
            connection: Mutex::new(None),
            reconnect_task: Mutex::new(None),
            last_snapshot: Mutex::new(None),
            connected_device: Mutex::new(None),
            session_closed_emitted: AtomicBool::new(false),
            close_handled_generation: Mutex::new(None),
        }
    }
}

impl PushSupervisor {
    pub fn new(dependencies: PushSupervisorDependencies) -> Self {
        Self {
            inner: Arc::new(PushSupervisorInner {
                dependencies,
                lifecycle: tokio::sync::Mutex::new(()),
                state: Mutex::new(SupervisorState::default()),
            }),
        }
    }

    pub async fn start(&self) -> Result<(), PushError> {
        let lifecycle = self.inner.lifecycle.lock().await;
        {
            let mut state = lock(&self.inner.state);
            if state.running {
                return Ok(());
            }
            state.running = true;
        }
        let devices = self.inner.dependencies.store.list_devices().await?;
        let entries = {
            let mut state = lock(&self.inner.state);
            devices
                .into_iter()
                .filter_map(|device| {
                    if state.entries.contains_key(&device.id) {
                        return None;
                    }
                    let entry = Arc::new(PushEntry::new(device.id.clone()));
                    state.entries.insert(device.id, entry.clone());
                    Some(entry)
                })
                .collect::<Vec<_>>()
        };
        drop(lifecycle);
        join_all(
            entries
                .into_iter()
                .map(|entry| self.inner.clone().launch_connect(entry)),
        )
        .await;
        Ok(())
    }

    pub async fn stop(&self) {
        self.stop_all().await;
    }

    pub async fn stop_all(&self) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let entries = {
            let mut state = lock(&self.inner.state);
            state.running = false;
            state
                .entries
                .drain()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>()
        };
        join_all(
            entries
                .into_iter()
                .map(|entry| self.inner.clone().teardown_entry(entry)),
        )
        .await;
    }

    pub async fn upsert(&self, device_id: &str) {
        let lifecycle = self.inner.lifecycle.lock().await;
        let entry = {
            let mut state = lock(&self.inner.state);
            if !state.running || state.entries.contains_key(device_id) {
                return;
            }
            let entry = Arc::new(PushEntry::new(device_id.to_owned()));
            state.entries.insert(device_id.to_owned(), entry.clone());
            entry
        };
        drop(lifecycle);
        self.inner.clone().launch_connect(entry).await;
    }

    pub async fn reconnect(&self, device_id: &str) {
        let lifecycle = self.inner.lifecycle.lock().await;
        let old = lock(&self.inner.state).entries.remove(device_id);
        if let Some(old) = old {
            self.inner.clone().teardown_entry(old).await;
        }
        let entry = {
            let mut state = lock(&self.inner.state);
            if !state.running {
                return;
            }
            let entry = Arc::new(PushEntry::new(device_id.to_owned()));
            state.entries.insert(device_id.to_owned(), entry.clone());
            entry
        };
        drop(lifecycle);
        self.inner.clone().launch_connect(entry).await;
    }

    pub async fn remove(&self, device_id: &str) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let entry = lock(&self.inner.state).entries.remove(device_id);
        if let Some(entry) = entry {
            self.inner.clone().teardown_entry(entry).await;
        }
    }

    pub async fn update_default_working_dir(
        &self,
        device_id: &str,
        directory: Option<String>,
    ) -> Result<(), PushError> {
        let lease = self.inner.entry(device_id).and_then(|entry| {
            lock(&entry.connection)
                .as_ref()
                .map(|value| value.lease.clone())
        });
        match lease {
            Some(lease) => lease.update_default_working_dir(directory).await,
            None => Ok(()),
        }
    }

    pub fn get_last_snapshot(&self, device_id: &str) -> Option<StateSnapshot> {
        self.inner
            .entry(device_id)
            .and_then(|entry| lock(&entry.last_snapshot).clone())
    }
}

impl PushSupervisorInner {
    fn entry(&self, device_id: &str) -> Option<Arc<PushEntry>> {
        lock(&self.state).entries.get(device_id).cloned()
    }

    fn is_current(&self, entry: &Arc<PushEntry>, generation: u64) -> bool {
        let state = lock(&self.state);
        state.running
            && state
                .entries
                .get(&entry.device_id)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            && entry.generation.load(Ordering::Acquire) == generation
    }

    fn launch_connect(self: Arc<Self>, entry: Arc<PushEntry>) -> PushTask {
        Box::pin(async move {
            let (complete, receiver) = tokio::sync::oneshot::channel();
            let inner = self.clone();
            self.dependencies.scheduler.spawn(Box::pin(async move {
                inner.connect_entry(entry).await;
                let _ = complete.send(());
            }));
            let _ = receiver.await;
        })
    }

    async fn connect_entry(self: Arc<Self>, entry: Arc<PushEntry>) {
        let generation = entry.generation.load(Ordering::Acquire);
        if !self.is_current(&entry, generation) {
            return;
        }
        let device = match self.dependencies.store.get_device(&entry.device_id).await {
            Ok(Some(device)) => device,
            Ok(None) => {
                self.remove_if_current(&entry);
                return;
            }
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to load push device");
                self.clone().schedule_reconnect(entry).await;
                return;
            }
        };
        let lease = match self.dependencies.runtimes.acquire(&entry.device_id).await {
            Ok(lease) => lease,
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to acquire push runtime");
                self.dependencies
                    .alerts
                    .notify(ConnectionAlertInput::new(
                        device,
                        error.to_string(),
                        ConnectionAlertSource::Connect,
                    ))
                    .await;
                if self.is_current(&entry, generation) {
                    self.clone().schedule_reconnect(entry).await;
                }
                return;
            }
        };
        if !self.is_current(&entry, generation) {
            lease.release().await;
            return;
        }
        let listener: Arc<dyn PushRuntimeListener> = Arc::new(SupervisorRuntimeListener {
            supervisor: Arc::downgrade(&self),
            entry: Arc::downgrade(&entry),
            lease: Arc::downgrade(&lease),
            generation,
        });
        let subscription = match lease.subscribe(listener) {
            Ok(subscription) => subscription,
            Err(error) => {
                self.dependencies
                    .alerts
                    .notify(ConnectionAlertInput::new(
                        device,
                        error.to_string(),
                        ConnectionAlertSource::Connect,
                    ))
                    .await;
                lease.release().await;
                if self.is_current(&entry, generation) {
                    self.clone().schedule_reconnect(entry).await;
                }
                return;
            }
        };
        if !self.is_current(&entry, generation) {
            subscription.cancel();
            lease.release().await;
            return;
        }
        let displaced = lock(&entry.connection).replace(RuntimeConnection {
            lease: lease.clone(),
            subscription,
        });
        if let Some(displaced) = displaced {
            displaced.cancel_subscription();
            displaced.lease.release().await;
        }
        entry.reconnect_attempts.store(0, Ordering::Release);
        entry.session_closed_emitted.store(false, Ordering::Release);
        *lock(&entry.connected_device) = Some(device);
        *lock(&entry.last_snapshot) = None;
        match lease.current_snapshot().await {
            Ok(snapshot) if self.is_current(&entry, generation) => {
                *lock(&entry.last_snapshot) = snapshot;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to read initial push snapshot");
            }
        }
        if self.is_current(&entry, generation) {
            if let Err(error) = lease.request_snapshot() {
                tracing::error!(device_id = entry.device_id, %error, "failed to request push snapshot");
                self.handle_close(entry, lease, generation).await;
            }
        }
    }

    fn remove_if_current(&self, entry: &Arc<PushEntry>) {
        let mut state = lock(&self.state);
        if state
            .entries
            .get(&entry.device_id)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            state.entries.remove(&entry.device_id);
        }
    }

    async fn teardown_entry(self: Arc<Self>, entry: Arc<PushEntry>) {
        if let Some(task) = lock(&entry.reconnect_task).take() {
            task.cancel();
        }
        entry.generation.fetch_add(1, Ordering::AcqRel);
        let connection = lock(&entry.connection).take();
        if let Some(connection) = connection {
            connection.cancel_subscription();
            connection.lease.release().await;
        }
    }

    async fn schedule_reconnect(self: Arc<Self>, entry: Arc<PushEntry>) {
        let generation = entry.generation.load(Ordering::Acquire);
        if !self.is_current(&entry, generation) {
            return;
        }
        match self.dependencies.store.get_device(&entry.device_id).await {
            Ok(Some(_)) => {}
            Ok(None) => {
                self.remove_if_current(&entry);
                return;
            }
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to check push device before retry");
            }
        }
        let settings = self.dependencies.store.site_settings().await;
        let (max_retries, fast_delay) = match settings {
            Ok(settings) => (
                settings.ssh_reconnect_max_retries.max(0) as u32,
                Duration::from_secs(settings.ssh_reconnect_delay_seconds.max(1) as u64),
            ),
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to load push reconnect settings");
                (0, self.dependencies.fallback_reconnect_delay)
            }
        };
        let attempts = entry.reconnect_attempts.load(Ordering::Acquire);
        let fallback = attempts >= max_retries;
        let delay = if fallback {
            self.dependencies.fallback_reconnect_delay
        } else {
            entry.reconnect_attempts.fetch_add(1, Ordering::AcqRel);
            fast_delay
        };
        if let Some(task) = lock(&entry.reconnect_task).take() {
            task.cancel();
        }
        let next_generation = entry.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let inner = self.clone();
        let scheduled_entry = entry.clone();
        let task: PushTask = Box::pin(async move {
            if scheduled_entry.generation.load(Ordering::Acquire) != next_generation
                || !inner.is_current(&scheduled_entry, next_generation)
            {
                return;
            }
            lock(&scheduled_entry.reconnect_task).take();
            inner.launch_connect(scheduled_entry).await;
        });
        let scheduled = self.dependencies.scheduler.schedule(delay, task);
        *lock(&entry.reconnect_task) = Some(scheduled);
    }

    async fn handle_close(
        self: Arc<Self>,
        entry: Arc<PushEntry>,
        lease: Arc<dyn PushRuntimeLease>,
        generation: u64,
    ) {
        if !self.is_current(&entry, generation) {
            return;
        }
        {
            let mut handled = lock(&entry.close_handled_generation);
            if *handled == Some(generation) {
                return;
            }
            *handled = Some(generation);
        }
        if let Some(device_close) = &self.dependencies.device_close {
            if let Err(error) = device_close.device_closed(&entry.device_id).await {
                tracing::error!(device_id = entry.device_id, %error, "failed to notify agent sessions of device close");
            }
        }
        let connected_device = { lock(&entry.connected_device).clone() };
        if let Some(device) = connected_device {
            let mut alert = ConnectionAlertInput::new(
                device,
                "ssh_connection_closed",
                ConnectionAlertSource::Close,
            );
            alert.session_closed_emitted = entry.session_closed_emitted.load(Ordering::Acquire);
            self.dependencies.alerts.notify(alert).await;
        }
        if !self.is_current(&entry, generation) {
            return;
        }
        let connection = {
            let mut current = lock(&entry.connection);
            if current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.lease, &lease))
            {
                current.take()
            } else {
                None
            }
        };
        if let Some(connection) = connection {
            connection.cancel_subscription();
            connection.lease.release().await;
        }
        if self.is_current(&entry, generation) {
            self.schedule_reconnect(entry).await;
        }
    }

    async fn handle_runtime_error(
        self: Arc<Self>,
        entry: Arc<PushEntry>,
        generation: u64,
        message: String,
    ) {
        if !self.is_current(&entry, generation) {
            return;
        }
        let connected_device = { lock(&entry.connected_device).clone() };
        if let Some(device) = connected_device {
            self.dependencies
                .alerts
                .notify(ConnectionAlertInput::new(
                    device,
                    message,
                    ConnectionAlertSource::Runtime,
                ))
                .await;
        }
    }

    async fn handle_terminal_event(
        self: Arc<Self>,
        entry: Arc<PushEntry>,
        lease: Arc<dyn PushRuntimeLease>,
        generation: u64,
        pane_id: String,
        notification: Option<PaneStreamNotification>,
    ) {
        if !self.is_current(&entry, generation) {
            return;
        }
        let device = match self.dependencies.store.get_device(&entry.device_id).await {
            Ok(Some(device)) => device,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to load push event device");
                return;
            }
        };
        let settings = match self.dependencies.store.site_settings().await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(device_id = entry.device_id, %error, "failed to load push event settings");
                return;
            }
        };
        let snapshot = lock(&entry.last_snapshot).clone();
        let mut context =
            resolve_pane_context(&device.id, &settings.site_url, snapshot.as_ref(), &pane_id);
        let custom_name = if let Some(pane_id) = context.pane_id.as_deref() {
            lease
                .custom_name(SOURCE_ENTITY_PANE, pane_id)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let custom_name = if custom_name.is_some() {
            custom_name
        } else if let Some(window_id) = context.window_id.as_deref() {
            lease
                .custom_name(SOURCE_ENTITY_WINDOW, window_id)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        if custom_name.is_some() {
            context.pane_title = custom_name;
        }
        if !self.is_current(&entry, generation) {
            return;
        }
        let (event_type, payload) = match notification {
            None => (
                EventType::TerminalBell,
                JsonMap::from_iter([(
                    "message".to_owned(),
                    JsonValue::String(self.dependencies.translator.translate(
                        "notification.eventType.terminal_bell",
                        &[],
                        None,
                    )),
                )]),
            ),
            Some(notification) => {
                let title = notification.title.filter(|title| !title.is_empty());
                if title.is_none() && notification.body.is_empty() {
                    return;
                }
                let source = match notification.source {
                    PaneStreamNotificationSource::Osc777 => "osc777",
                    PaneStreamNotificationSource::Osc1337 => "osc1337",
                    PaneStreamNotificationSource::Osc9 | PaneStreamNotificationSource::Osc99 => {
                        "osc9"
                    }
                };
                let mut payload = JsonMap::from_iter([
                    ("source".to_owned(), JsonValue::String(source.to_owned())),
                    ("message".to_owned(), JsonValue::String(notification.body)),
                ]);
                if let Some(title) = title {
                    payload.insert("title".to_owned(), JsonValue::String(title));
                }
                (EventType::TerminalNotification, payload)
            }
        };
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
                session_name: device.session,
                window_id: context.window_id,
                window_index: context.window_index,
                pane_id: context.pane_id,
                pane_index: context.pane_index,
                pane_url: context.pane_url,
                pane_title: context.pane_title,
                pane_current_command: context.pane_current_command,
                pane_current_path: context.pane_current_path,
            }),
            payload: Some(payload),
        };
        if let Err(error) = self.dependencies.events.emit(event_type, draft).await {
            tracing::error!(device_id = entry.device_id, %error, "failed to emit terminal push event");
        }
    }
}

struct SupervisorRuntimeListener {
    supervisor: Weak<PushSupervisorInner>,
    entry: Weak<PushEntry>,
    lease: Weak<dyn PushRuntimeLease>,
    generation: u64,
}

impl PushRuntimeListener for SupervisorRuntimeListener {
    fn on_event(&self, event: TmuxRuntimeEvent) {
        let (Some(supervisor), Some(entry), Some(lease)) = (
            self.supervisor.upgrade(),
            self.entry.upgrade(),
            self.lease.upgrade(),
        ) else {
            return;
        };
        if !supervisor.is_current(&entry, self.generation) {
            return;
        }
        let generation = self.generation;
        match event {
            TmuxRuntimeEvent::Connected { .. } => {
                entry.session_closed_emitted.store(false, Ordering::Release);
            }
            TmuxRuntimeEvent::Snapshot(snapshot) => {
                *lock(&entry.last_snapshot) = Some(snapshot);
            }
            TmuxRuntimeEvent::Lifecycle(event) => {
                if event.kind == LifecycleEventKind::SessionClosed {
                    entry.session_closed_emitted.store(true, Ordering::Release);
                }
            }
            TmuxRuntimeEvent::Closed { .. } => {
                let scheduler = supervisor.dependencies.scheduler.clone();
                scheduler.spawn(Box::pin(async move {
                    supervisor.handle_close(entry, lease, generation).await;
                }));
            }
            TmuxRuntimeEvent::Error { message, .. } => {
                let scheduler = supervisor.dependencies.scheduler.clone();
                scheduler.spawn(Box::pin(async move {
                    supervisor
                        .handle_runtime_error(entry, generation, message)
                        .await;
                }));
            }
            TmuxRuntimeEvent::Bell { pane_id } => {
                let scheduler = supervisor.dependencies.scheduler.clone();
                scheduler.spawn(Box::pin(async move {
                    supervisor
                        .handle_terminal_event(entry, lease, generation, pane_id, None)
                        .await;
                }));
            }
            TmuxRuntimeEvent::Notification {
                pane_id,
                notification,
            } => {
                let scheduler = supervisor.dependencies.scheduler.clone();
                scheduler.spawn(Box::pin(async move {
                    supervisor
                        .handle_terminal_event(
                            entry,
                            lease,
                            generation,
                            pane_id,
                            Some(notification),
                        )
                        .await;
                }));
            }
            _ => {}
        }
    }
}

#[derive(Default)]
struct PaneContext {
    window_id: Option<String>,
    pane_id: Option<String>,
    window_index: Option<i64>,
    pane_index: Option<i64>,
    pane_url: Option<String>,
    pane_title: Option<String>,
    pane_current_command: Option<String>,
    pane_current_path: Option<String>,
}

fn resolve_pane_context(
    device_id: &str,
    site_url: &str,
    snapshot: Option<&StateSnapshot>,
    pane_id: &str,
) -> PaneContext {
    let Some(session) = snapshot.and_then(|snapshot| snapshot.session.as_ref()) else {
        return PaneContext {
            pane_id: (!pane_id.is_empty()).then(|| pane_id.to_owned()),
            ..PaneContext::default()
        };
    };
    let matched = session.windows.iter().find_map(|window| {
        window
            .panes
            .iter()
            .find(|pane| pane.id == pane_id)
            .map(|pane| (window, pane))
    });
    let window = matched
        .map(|(window, _)| window)
        .or_else(|| session.windows.iter().find(|window| window.active))
        .or_else(|| session.windows.first());
    let pane = matched
        .map(|(_, pane)| pane)
        .or_else(|| window.and_then(|window| select_pane(window.panes.as_slice(), pane_id)));
    let pane_url = window.zip(pane).map(|(window, pane)| {
        let base = site_url.strip_suffix('/').unwrap_or(site_url);
        format!(
            "{base}/devices/{}/windows/{}/panes/{}",
            encode_component(device_id),
            encode_component(&window.id),
            encode_component(&pane.id)
        )
    });
    PaneContext {
        window_id: window.map(|window| window.id.clone()),
        pane_id: pane
            .map(|pane| pane.id.clone())
            .or_else(|| (!pane_id.is_empty()).then(|| pane_id.to_owned())),
        window_index: window.map(|window| i64::from(window.index)),
        pane_index: pane.map(|pane| i64::from(pane.index)),
        pane_url,
        pane_title: pane.and_then(|pane| pane.custom_name.clone().or_else(|| pane.title.clone())),
        pane_current_command: pane.and_then(|pane| pane.current_command.clone()),
        pane_current_path: pane.and_then(|pane| pane.current_path.clone()),
    }
}

fn select_pane<'a>(panes: &'a [PaneWire], pane_id: &str) -> Option<&'a PaneWire> {
    (!pane_id.is_empty())
        .then(|| panes.iter().find(|pane| pane.id == pane_id))
        .flatten()
        .or_else(|| panes.iter().find(|pane| pane.active))
        .or_else(|| panes.first())
}

fn encode_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET).to_string()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tmex_protocol::StateSnapshot;

    use crate::entity::site_settings;
    use crate::events::{EventClock, EventDraft};
    use crate::tmux::{LifecycleEvent, LifecycleTmuxContext};

    use super::*;
    use crate::push::{
        ConnectionAlertNotifierDependencies, PushRuntimeSubscription, SystemPushScheduler,
    };

    struct TestStore {
        listed_devices: Vec<devices::Model>,
        device: devices::Model,
        persisted: AtomicUsize,
    }

    #[async_trait]
    impl PushStore for TestStore {
        async fn list_devices(&self) -> Result<Vec<devices::Model>, PushError> {
            Ok(self.listed_devices.clone())
        }

        async fn get_device(&self, device_id: &str) -> Result<Option<devices::Model>, PushError> {
            Ok((self.device.id == device_id).then(|| self.device.clone()))
        }

        async fn site_settings(&self) -> Result<site_settings::Model, PushError> {
            Ok(settings())
        }

        async fn persist_connection_alert(
            &self,
            _device_id: &str,
            _timestamp: String,
            _message: String,
            _error_type: String,
        ) -> Result<(), PushError> {
            self.persisted.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    struct TestTranslator;

    impl PushTranslator for TestTranslator {
        fn translate(
            &self,
            key: &str,
            _parameters: &[(&str, String)],
            default: Option<&str>,
        ) -> String {
            default.unwrap_or(key).to_owned()
        }
    }

    struct TestClock;

    impl EventClock for TestClock {
        fn now_millis(&self) -> u64 {
            1_000_000
        }

        fn now_iso(&self) -> String {
            "2026-08-12T00:00:00.000Z".to_owned()
        }
    }

    #[derive(Default)]
    struct RecordingEvents {
        events: Mutex<Vec<(EventType, EventDraft)>>,
    }

    #[async_trait]
    impl PushEventSink for RecordingEvents {
        async fn emit(&self, event_type: EventType, draft: EventDraft) -> Result<(), PushError> {
            lock(&self.events).push((event_type, draft));
            Ok(())
        }
    }

    #[derive(Default)]
    struct TestSubscription(AtomicBool);

    impl PushRuntimeSubscription for TestSubscription {
        fn cancel(&self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[derive(Default)]
    struct TestLease {
        listener: Mutex<Option<Arc<dyn PushRuntimeListener>>>,
        releases: AtomicUsize,
        snapshot_requests: AtomicUsize,
    }

    impl TestLease {
        fn emit(&self, event: TmuxRuntimeEvent) {
            if let Some(listener) = lock(&self.listener).clone() {
                listener.on_event(event);
            }
        }
    }

    #[async_trait]
    impl PushRuntimeLease for TestLease {
        fn subscribe(
            &self,
            listener: Arc<dyn PushRuntimeListener>,
        ) -> Result<Arc<dyn PushRuntimeSubscription>, PushError> {
            *lock(&self.listener) = Some(listener);
            Ok(Arc::new(TestSubscription::default()))
        }

        fn request_snapshot(&self) -> Result<(), PushError> {
            self.snapshot_requests.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        async fn current_snapshot(&self) -> Result<Option<StateSnapshot>, PushError> {
            Ok(None)
        }

        async fn custom_name(
            &self,
            _entity_kind: u8,
            _native_id: &str,
        ) -> Result<Option<String>, PushError> {
            Ok(None)
        }

        async fn update_default_working_dir(
            &self,
            _directory: Option<String>,
        ) -> Result<(), PushError> {
            Ok(())
        }

        async fn release(&self) {
            self.releases.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct TestRuntimeHost {
        lease: Arc<TestLease>,
        blocked: bool,
        acquired: AtomicBool,
        allowed: AtomicBool,
        changed: tokio::sync::Notify,
    }

    impl TestRuntimeHost {
        fn immediate(lease: Arc<TestLease>) -> Self {
            Self {
                lease,
                blocked: false,
                acquired: AtomicBool::new(false),
                allowed: AtomicBool::new(true),
                changed: tokio::sync::Notify::new(),
            }
        }

        fn blocked(lease: Arc<TestLease>) -> Self {
            Self {
                lease,
                blocked: true,
                acquired: AtomicBool::new(false),
                allowed: AtomicBool::new(false),
                changed: tokio::sync::Notify::new(),
            }
        }

        async fn wait_acquired(&self) {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.acquired.load(Ordering::Acquire) {
                    return;
                }
                changed.await;
            }
        }

        fn allow(&self) {
            self.allowed.store(true, Ordering::Release);
            self.changed.notify_waiters();
        }
    }

    #[async_trait]
    impl PushRuntimeHost for TestRuntimeHost {
        async fn acquire(&self, _device_id: &str) -> Result<Arc<dyn PushRuntimeLease>, PushError> {
            self.acquired.store(true, Ordering::Release);
            self.changed.notify_waiters();
            if self.blocked {
                loop {
                    let changed = self.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    if self.allowed.load(Ordering::Acquire) {
                        break;
                    }
                    changed.await;
                }
            }
            Ok(self.lease.clone())
        }
    }

    #[tokio::test]
    async fn session_close_suppresses_the_duplicate_disconnect_alert() {
        let device = device("lifecycle");
        let store = Arc::new(TestStore {
            listed_devices: vec![device.clone()],
            device,
            persisted: AtomicUsize::new(0),
        });
        let events = Arc::new(RecordingEvents::default());
        let lease = Arc::new(TestLease::default());
        let supervisor = supervisor(
            store.clone(),
            Arc::new(TestRuntimeHost::immediate(lease.clone())),
            events.clone(),
        );
        supervisor.start().await.expect("start push supervisor");

        lease.emit(TmuxRuntimeEvent::Lifecycle(LifecycleEvent {
            kind: LifecycleEventKind::SessionClosed,
            tmux: LifecycleTmuxContext {
                session_name: Some("tmex".to_owned()),
                ..LifecycleTmuxContext::default()
            },
            payload: BTreeMap::from([("message".to_owned(), "session gone".to_owned())]),
        }));
        lease.emit(TmuxRuntimeEvent::Closed {
            device_id: "lifecycle".to_owned(),
            manual: false,
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while lease.releases.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("closed runtime should be released");
        assert!(!lock(&events.events)
            .iter()
            .any(|(event_type, _)| *event_type == EventType::DeviceDisconnect));
        supervisor.stop().await;
    }

    #[tokio::test]
    async fn runtime_acquired_after_remove_is_released_as_stale() {
        let device = device("late");
        let store = Arc::new(TestStore {
            listed_devices: Vec::new(),
            device,
            persisted: AtomicUsize::new(0),
        });
        let lease = Arc::new(TestLease::default());
        let host = Arc::new(TestRuntimeHost::blocked(lease.clone()));
        let events = Arc::new(RecordingEvents::default());
        let supervisor = supervisor(store, host.clone(), events);
        supervisor.start().await.expect("start push supervisor");

        let upsert = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.upsert("late").await }
        });
        host.wait_acquired().await;
        supervisor.remove("late").await;
        host.allow();
        upsert.await.expect("upsert task");

        assert_eq!(lease.releases.load(Ordering::Acquire), 1);
        assert!(supervisor.get_last_snapshot("late").is_none());
        supervisor.stop().await;
    }

    fn supervisor(
        store: Arc<TestStore>,
        runtimes: Arc<dyn PushRuntimeHost>,
        events: Arc<RecordingEvents>,
    ) -> PushSupervisor {
        let translator: Arc<dyn PushTranslator> = Arc::new(TestTranslator);
        let alerts = ConnectionAlertNotifier::new(ConnectionAlertNotifierDependencies {
            store: store.clone(),
            translator: translator.clone(),
            broadcaster: None,
            event_sink: Some(events.clone()),
            telegram: None,
            clock: Arc::new(TestClock),
        });
        PushSupervisor::new(PushSupervisorDependencies {
            store,
            runtimes,
            alerts,
            events,
            device_close: None,
            translator,
            scheduler: Arc::new(SystemPushScheduler),
            fallback_reconnect_delay: Duration::from_secs(60),
        })
    }

    fn device(id: &str) -> devices::Model {
        devices::Model {
            id: id.to_owned(),
            name: id.to_owned(),
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
