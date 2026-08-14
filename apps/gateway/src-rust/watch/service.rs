use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tmex_protocol::{
    StateSnapshot, WatchEvent, WATCH_EVENT_MODEL_UNAVAILABLE, WATCH_EVENT_RULE_ERROR,
    WATCH_EVENT_TRIGGERED,
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::database::repository::{
    Repository, RepositoryError, RepositorySiteSettingsDefaults, WatchRuleStateUpdate,
    WatchRuleUpdate,
};
use crate::entity::{watch_rule_state, watch_rules};
use crate::events::{EventDevice, EventDraft, EventSite, EventTmux, EventType};
use crate::tmux::is_target_missing_message;

use super::runtime::{
    WatchDevice, WatchDeviceListener, WatchLlmOperation, WatchLlmRequest, WatchLlmResponse,
    WatchMessage, WatchRuntime, WatchRuntimeError, WatchSchedule, WatchSubscription,
    WatchTmuxEntityKind,
};
use super::{
    build_confirm_prompt, build_judge_prompt, build_summary_prompt, effective_interval_seconds,
    evaluate_watch_rule, WatchEvalOutput,
};

const SAMPLE_RING_LIMIT: usize = 120;
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchRuleSample {
    pub at: String,
    pub value: Option<String>,
    pub hit: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchServiceConfig {
    pub site_settings_defaults: RepositorySiteSettingsDefaults,
    pub error_threshold: i64,
    pub llm_max_retries: u32,
}

impl WatchServiceConfig {
    pub fn new(site_settings_defaults: RepositorySiteSettingsDefaults) -> Self {
        Self {
            site_settings_defaults,
            error_threshold: 10,
            llm_max_retries: 2,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WatchServiceError {
    #[error(transparent)]
    Repository(#[from] RepositoryError),
    #[error(transparent)]
    Runtime(#[from] WatchRuntimeError),
}

#[derive(Clone)]
pub struct WatchService {
    inner: Arc<WatchServiceInner>,
}

struct WatchServiceInner {
    repository: Repository,
    runtime: Arc<dyn WatchRuntime>,
    config: WatchServiceConfig,
    lifecycle: AsyncMutex<()>,
    state: Mutex<ServiceState>,
    next_generation: AtomicU64,
}

#[derive(Default)]
struct ServiceState {
    started: bool,
    rules: HashMap<String, Arc<RuleEntry>>,
    devices: HashMap<String, DeviceSlot>,
    samples: HashMap<String, Vec<WatchRuleSample>>,
}

struct RuleEntry {
    rule_id: String,
    device_id: String,
    generation: u64,
    schedule: Mutex<Option<Arc<dyn WatchSchedule>>>,
    in_flight: Mutex<Option<Arc<InFlight>>>,
}

struct InFlight {
    completed: AtomicBool,
    notify: Notify,
}

struct TickGuard {
    entry: Arc<RuleEntry>,
    in_flight: Arc<InFlight>,
}

struct DeviceSlot {
    entry: Arc<DeviceEntry>,
    rule_ids: HashSet<String>,
}

struct DeviceEntry {
    device_id: String,
    active: AtomicBool,
    closed: AtomicBool,
    connection_generation: AtomicU64,
    connection: AsyncMutex<DeviceConnection>,
    snapshot: Mutex<Option<StateSnapshot>>,
}

#[derive(Default)]
struct DeviceConnection {
    runtime: Option<Arc<dyn WatchDevice>>,
    subscription: Option<Arc<dyn WatchSubscription>>,
}

struct DeviceListener {
    service: Weak<WatchServiceInner>,
    host: Weak<dyn WatchRuntime>,
    device: Weak<DeviceEntry>,
    runtime: Weak<dyn WatchDevice>,
    generation: u64,
}

#[derive(Clone, Debug, Default)]
struct PaneContext {
    window_id: Option<String>,
    window_index: Option<i64>,
    pane_id: Option<String>,
    pane_index: Option<i64>,
    pane_url: Option<String>,
    pane_title: Option<String>,
    pane_current_command: Option<String>,
    pane_current_path: Option<String>,
}

impl WatchService {
    pub fn new(
        repository: Repository,
        runtime: Arc<dyn WatchRuntime>,
        config: WatchServiceConfig,
    ) -> Self {
        Self {
            inner: Arc::new(WatchServiceInner {
                repository,
                runtime,
                config,
                lifecycle: AsyncMutex::new(()),
                state: Mutex::new(ServiceState::default()),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub async fn start(&self) -> Result<(), WatchServiceError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if lock(&self.inner.state).started {
            return Ok(());
        }

        let rules = self.inner.repository.get_enabled_watch_rules().await?;
        lock(&self.inner.state).started = true;
        for rule in rules {
            if let Err(error) = self.add_rule(&rule).await {
                lock(&self.inner.state).started = false;
                let entries = self.take_all_rules();
                for entry in entries {
                    self.cancel_and_wait(entry).await;
                }
                return Err(error);
            }
        }
        Ok(())
    }

    pub async fn stop(&self) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        lock(&self.inner.state).started = false;
        let entries = self.take_all_rules();
        for entry in entries {
            self.cancel_and_wait(entry).await;
        }
        lock(&self.inner.state).samples.clear();
    }

    pub async fn refresh_rule(&self, rule_id: &str) -> Result<(), WatchServiceError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if let Some(entry) = self.take_rule(rule_id, None) {
            self.cancel_and_wait(entry).await;
        }
        if !lock(&self.inner.state).started {
            return Ok(());
        }
        if let Some(rule) = self.inner.repository.get_watch_rule_by_id(rule_id).await? {
            if rule.enabled != 0 {
                self.add_rule(&rule).await?;
            }
        }
        Ok(())
    }

    pub async fn remove_rule(&self, rule_id: &str) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        if let Some(entry) = self.take_rule(rule_id, None) {
            self.cancel_and_wait(entry).await;
        }
        lock(&self.inner.state).samples.remove(rule_id);
    }

    pub fn is_rule_scheduled(&self, rule_id: &str) -> bool {
        lock(&self.inner.state).rules.contains_key(rule_id)
    }

    pub fn get_samples(&self, rule_id: &str) -> Vec<WatchRuleSample> {
        lock(&self.inner.state)
            .samples
            .get(rule_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn tick_rule(&self, rule_id: &str) -> Result<(), WatchServiceError> {
        let Some(guard) = self.claim_tick(rule_id) else {
            return Ok(());
        };
        let generation = guard.entry.generation;
        let result = self.run_tick(rule_id, generation).await;
        drop(guard);
        result
    }

    async fn add_rule(&self, rule: &watch_rules::Model) -> Result<(), WatchServiceError> {
        if lock(&self.inner.state).rules.contains_key(&rule.id) {
            return Ok(());
        }

        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(RuleEntry {
            rule_id: rule.id.clone(),
            device_id: rule.device_id.clone(),
            generation,
            schedule: Mutex::new(None),
            in_flight: Mutex::new(None),
        });
        {
            let mut state = lock(&self.inner.state);
            if state.rules.contains_key(&rule.id) {
                return Ok(());
            }
            state.rules.insert(rule.id.clone(), entry.clone());
            let slot = state
                .devices
                .entry(rule.device_id.clone())
                .or_insert_with(|| DeviceSlot {
                    entry: Arc::new(DeviceEntry {
                        device_id: rule.device_id.clone(),
                        active: AtomicBool::new(true),
                        closed: AtomicBool::new(false),
                        connection_generation: AtomicU64::new(0),
                        connection: AsyncMutex::new(DeviceConnection::default()),
                        snapshot: Mutex::new(None),
                    }),
                    rule_ids: HashSet::new(),
                });
            slot.rule_ids.insert(rule.id.clone());
        }

        let weak = Arc::downgrade(&self.inner);
        let rule_id = rule.id.clone();
        let callback = Arc::new(move || {
            let weak = weak.clone();
            let rule_id = rule_id.clone();
            let future: super::runtime::WatchFuture = Box::pin(async move {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let service = WatchService { inner };
                if let Err(error) = service.tick_rule(&rule_id).await {
                    tracing::error!(rule_id, %error, "watch tick failed");
                }
            });
            future
        });
        let interval = Duration::from_secs(effective_interval_seconds(rule) as u64);
        let schedule = match self.inner.runtime.schedule_interval(interval, callback) {
            Ok(schedule) => schedule,
            Err(error) => {
                if let Some(entry) = self.take_rule(&rule.id, Some(generation)) {
                    self.remove_device_ref(&entry.device_id, &entry.rule_id)
                        .await;
                }
                return Err(error.into());
            }
        };

        let mut pending_schedule = Some(schedule);
        {
            let state = lock(&self.inner.state);
            let current = state
                .rules
                .get(&rule.id)
                .is_some_and(|current| Arc::ptr_eq(current, &entry));
            if current {
                *lock(&entry.schedule) = pending_schedule.take();
            }
        }
        if let Some(schedule) = pending_schedule {
            schedule.cancel();
        }
        Ok(())
    }

    fn claim_tick(&self, rule_id: &str) -> Option<TickGuard> {
        let state = lock(&self.inner.state);
        let entry = state.rules.get(rule_id)?.clone();
        let mut current = lock(&entry.in_flight);
        if current.is_some() {
            return None;
        }
        let in_flight = Arc::new(InFlight {
            completed: AtomicBool::new(false),
            notify: Notify::new(),
        });
        *current = Some(in_flight.clone());
        drop(current);
        Some(TickGuard { entry, in_flight })
    }

    fn take_rule(&self, rule_id: &str, generation: Option<u64>) -> Option<Arc<RuleEntry>> {
        let mut state = lock(&self.inner.state);
        let entry = state.rules.get(rule_id)?;
        if generation.is_some_and(|generation| entry.generation != generation) {
            return None;
        }
        let entry = state.rules.remove(rule_id)?;
        if let Some(schedule) = lock(&entry.schedule).take() {
            schedule.cancel();
        }
        Some(entry)
    }

    fn take_all_rules(&self) -> Vec<Arc<RuleEntry>> {
        let mut state = lock(&self.inner.state);
        let entries = state
            .rules
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        for entry in &entries {
            if let Some(schedule) = lock(&entry.schedule).take() {
                schedule.cancel();
            }
        }
        entries
    }

    async fn cancel_and_wait(&self, entry: Arc<RuleEntry>) {
        let in_flight = { lock(&entry.in_flight).clone() };
        if let Some(in_flight) = in_flight {
            in_flight.wait().await;
        }
        self.remove_device_ref(&entry.device_id, &entry.rule_id)
            .await;
    }

    async fn teardown_current(&self, rule_id: &str, generation: u64) {
        if let Some(entry) = self.take_rule(rule_id, Some(generation)) {
            self.remove_device_ref(&entry.device_id, &entry.rule_id)
                .await;
        }
    }

    async fn remove_device_ref(&self, device_id: &str, rule_id: &str) {
        let removed = {
            let mut state = lock(&self.inner.state);
            let Some(slot) = state.devices.get_mut(device_id) else {
                return;
            };
            slot.rule_ids.remove(rule_id);
            let should_remove = slot.rule_ids.is_empty();
            if !should_remove {
                None
            } else {
                state.devices.remove(device_id).map(|slot| {
                    slot.entry.active.store(false, Ordering::Release);
                    slot.entry
                })
            }
        };
        if let Some(device) = removed {
            self.release_device_entry(device).await;
        }
    }

    async fn release_device_entry(&self, device: Arc<DeviceEntry>) {
        device.connection_generation.fetch_add(1, Ordering::AcqRel);
        device.closed.store(false, Ordering::Release);
        *lock(&device.snapshot) = None;
        let mut connection = device.connection.lock().await;
        if let Some(subscription) = connection.subscription.take() {
            subscription.detach();
        }
        if let Some(runtime) = connection.runtime.take() {
            if let Err(error) = self
                .inner
                .runtime
                .release_device(&device.device_id, runtime)
                .await
            {
                tracing::error!(device_id = device.device_id, %error, "failed to release watch device");
            }
        }
    }

    async fn ensure_runtime(
        &self,
        device: &Arc<DeviceEntry>,
    ) -> Result<Arc<dyn WatchDevice>, WatchRuntimeError> {
        if !device.active.load(Ordering::Acquire) {
            return Err(WatchRuntimeError::new(format!(
                "watch rules for device {} were removed",
                device.device_id
            )));
        }
        let mut connection = device.connection.lock().await;
        if let Some(runtime) = connection.runtime.as_ref().cloned() {
            if !device.closed.load(Ordering::Acquire) {
                return Ok(runtime);
            }
            device.connection_generation.fetch_add(1, Ordering::AcqRel);
            if let Some(subscription) = connection.subscription.take() {
                subscription.detach();
            }
            connection.runtime = None;
            *lock(&device.snapshot) = None;
            if let Err(error) = self
                .inner
                .runtime
                .release_device(&device.device_id, runtime)
                .await
            {
                tracing::error!(device_id = device.device_id, %error, "failed to release closed watch device before reconnect");
            }
        }
        device.closed.store(false, Ordering::Release);

        let runtime = self.inner.runtime.acquire_device(&device.device_id).await?;
        if let Err(error) = runtime.connect().await {
            if let Err(release_error) = self
                .inner
                .runtime
                .release_device(&device.device_id, runtime)
                .await
            {
                tracing::error!(device_id = device.device_id, %release_error, "failed to release watch device after connect error");
            }
            return Err(error);
        }

        if !self.device_is_current(device) {
            if let Err(error) = self
                .inner
                .runtime
                .release_device(&device.device_id, runtime)
                .await
            {
                tracing::error!(device_id = device.device_id, %error, "failed to release removed watch device");
            }
            return Err(WatchRuntimeError::new(format!(
                "watch rules for device {} were removed",
                device.device_id
            )));
        }

        let generation = device
            .connection_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let listener = Arc::new(DeviceListener {
            service: Arc::downgrade(&self.inner),
            host: Arc::downgrade(&self.inner.runtime),
            device: Arc::downgrade(device),
            runtime: Arc::downgrade(&runtime),
            generation,
        });
        let subscription = match runtime.subscribe(listener) {
            Ok(subscription) => subscription,
            Err(error) => {
                if let Err(release_error) = self
                    .inner
                    .runtime
                    .release_device(&device.device_id, runtime)
                    .await
                {
                    tracing::error!(device_id = device.device_id, %release_error, "failed to release watch device after subscription error");
                }
                return Err(error);
            }
        };
        connection.runtime = Some(runtime.clone());
        connection.subscription = Some(subscription);
        if let Err(error) = runtime.request_snapshot() {
            if let Some(subscription) = connection.subscription.take() {
                subscription.detach();
            }
            connection.runtime = None;
            device.connection_generation.fetch_add(1, Ordering::AcqRel);
            if let Err(release_error) = self
                .inner
                .runtime
                .release_device(&device.device_id, runtime)
                .await
            {
                tracing::error!(device_id = device.device_id, %release_error, "failed to release watch device after snapshot error");
            }
            return Err(error);
        }
        Ok(runtime)
    }

    fn device_is_current(&self, device: &Arc<DeviceEntry>) -> bool {
        if !device.active.load(Ordering::Acquire) {
            return false;
        }
        lock(&self.inner.state)
            .devices
            .get(&device.device_id)
            .is_some_and(|slot| Arc::ptr_eq(&slot.entry, device))
    }

    async fn handle_device_close(
        &self,
        device: Arc<DeviceEntry>,
        runtime: Arc<dyn WatchDevice>,
        generation: u64,
    ) {
        if !device.active.load(Ordering::Acquire)
            || device.connection_generation.load(Ordering::Acquire) != generation
        {
            return;
        }
        let mut connection = device.connection.lock().await;
        if !device.active.load(Ordering::Acquire) {
            return;
        }
        let is_current = connection
            .runtime
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &runtime));
        if !is_current || device.connection_generation.load(Ordering::Acquire) != generation {
            return;
        }
        device.connection_generation.fetch_add(1, Ordering::AcqRel);
        device.closed.store(false, Ordering::Release);
        if let Some(subscription) = connection.subscription.take() {
            subscription.detach();
        }
        connection.runtime = None;
        *lock(&device.snapshot) = None;
        if let Err(error) = self
            .inner
            .runtime
            .release_device(&device.device_id, runtime)
            .await
        {
            tracing::error!(device_id = device.device_id, %error, "failed to release closed watch device");
        }
    }

    async fn run_tick(&self, rule_id: &str, generation: u64) -> Result<(), WatchServiceError> {
        let rule = self.inner.repository.get_watch_rule_by_id(rule_id).await?;
        let Some(rule) = rule.filter(|rule| rule.enabled != 0) else {
            self.teardown_current(rule_id, generation).await;
            return Ok(());
        };
        if !self.is_current(rule_id, generation) {
            return Ok(());
        }
        let Some(device) = self.device_entry(&rule.device_id) else {
            return Ok(());
        };
        let now = self.inner.runtime.now();
        let screen = match self.ensure_runtime(&device).await {
            Ok(runtime) => match runtime.capture_pane_text(&rule.pane_id).await {
                Ok(screen) => screen,
                Err(error) => {
                    if !self.is_current(rule_id, generation) {
                        return Ok(());
                    }
                    if is_target_missing_message(error.message()) {
                        self.handle_pane_gone(&rule, generation).await?;
                    } else {
                        self.record_rule_error(&rule, generation, error.message(), now)
                            .await?;
                    }
                    return Ok(());
                }
            },
            Err(error) => {
                if !self.is_current(rule_id, generation) {
                    return Ok(());
                }
                if is_target_missing_message(error.message()) {
                    self.handle_pane_gone(&rule, generation).await?;
                } else {
                    self.record_rule_error(&rule, generation, error.message(), now)
                        .await?;
                }
                return Ok(());
            }
        };
        if !self.is_current(rule_id, generation) {
            return Ok(());
        }
        let state = self.inner.repository.get_watch_rule_state(rule_id).await?;
        if !self.is_current(rule_id, generation) {
            return Ok(());
        }
        if rule.trigger_type == "llm" {
            self.process_llm_rule(&rule, generation, state.as_ref(), &screen, now)
                .await
        } else {
            self.process_regex_rule(&rule, generation, state.as_ref(), &screen, now)
                .await
        }
    }

    async fn process_regex_rule(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
        state: Option<&watch_rule_state::Model>,
        screen: &str,
        now: DateTime<Utc>,
    ) -> Result<(), WatchServiceError> {
        let output = evaluate_watch_rule(screen, rule, state, now);
        if let Some(error) = output.error.as_deref() {
            return self.record_rule_error(rule, generation, error, now).await;
        }

        let mut updates = WatchRuleStateUpdate {
            last_sampled_at: Some(Some(to_iso(now))),
            last_value: output.state_updates.last_value.clone(),
            last_value_changed_at: output.state_updates.last_value_changed_at.clone(),
            triggered_since_change: output.state_updates.triggered_since_change,
            consecutive_errors: Some(0),
            last_error: Some(None),
            ..WatchRuleStateUpdate::default()
        };

        let fired = if output.hit {
            self.fire_regex_trigger(rule, generation, state, &output, screen, now, &mut updates)
                .await?
        } else {
            false
        };
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.inner
            .repository
            .upsert_watch_rule_state(&rule.id, updates)
            .await?;
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.push_sample(
            &rule.id,
            now,
            output.value.clone().or(output.matched_text.clone()),
            fired,
        );

        if fired && rule.fire_mode == "once" && rule.trigger_type == "match" {
            self.inner
                .repository
                .update_watch_rule(
                    &rule.id,
                    WatchRuleUpdate {
                        enabled: Some(false),
                        ..WatchRuleUpdate::default()
                    },
                )
                .await?;
            self.teardown_current(&rule.id, generation).await;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn fire_regex_trigger(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
        state: Option<&watch_rule_state::Model>,
        output: &WatchEvalOutput,
        screen: &str,
        now: DateTime<Utc>,
        updates: &mut WatchRuleStateUpdate,
    ) -> Result<bool, WatchServiceError> {
        let mut notified = state.is_some_and(|state| state.model_unavailable_notified != 0);
        let mut unconfirmed = false;

        if rule.confirm_with_llm != 0 {
            match self.call_confirm(rule, output, screen).await {
                Ok(confirmed) => {
                    notified = false;
                    updates.model_unavailable_notified = Some(false);
                    if !confirmed {
                        return Ok(false);
                    }
                }
                Err(error) => {
                    if !self.is_current(&rule.id, generation) {
                        return Ok(false);
                    }
                    unconfirmed = true;
                    notified = self
                        .raise_model_unavailable(rule, notified, error.message())
                        .await;
                    updates.model_unavailable_notified = Some(notified);
                }
            }
        }

        let mut summary = None;
        if rule.summarize_with_llm != 0 {
            match self.call_summary(rule, output, screen).await {
                Ok(value) => {
                    summary = Some(value);
                    updates.model_unavailable_notified = Some(false);
                }
                Err(error) => {
                    if !self.is_current(&rule.id, generation) {
                        return Ok(false);
                    }
                    notified = self
                        .raise_model_unavailable(rule, notified, error.message())
                        .await;
                    updates.model_unavailable_notified = Some(notified);
                }
            }
        }

        if !self.is_current(&rule.id, generation) {
            return Ok(false);
        }
        self.emit_trigger(rule, output, summary.as_deref(), unconfirmed, None)
            .await;
        updates.last_triggered_at = Some(Some(to_iso(now)));
        if rule.trigger_type == "unchanged" {
            updates.triggered_since_change = Some(true);
        }
        Ok(true)
    }

    async fn process_llm_rule(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
        state: Option<&watch_rule_state::Model>,
        screen: &str,
        now: DateTime<Utc>,
    ) -> Result<(), WatchServiceError> {
        let mut updates = WatchRuleStateUpdate {
            last_sampled_at: Some(Some(to_iso(now))),
            ..WatchRuleStateUpdate::default()
        };
        let notified = state.is_some_and(|state| state.model_unavailable_notified != 0);
        let (matched, reason) = match self.call_judge(rule, screen).await {
            Ok(result) => {
                if !self.is_current(&rule.id, generation) {
                    return Ok(());
                }
                updates.model_unavailable_notified = Some(false);
                updates.consecutive_errors = Some(0);
                updates.last_error = Some(None);
                result
            }
            Err(error) => {
                if !self.is_current(&rule.id, generation) {
                    return Ok(());
                }
                let next_notified = self
                    .raise_model_unavailable(rule, notified, error.message())
                    .await;
                updates.model_unavailable_notified = Some(next_notified);
                let errors = state.map_or(1, |state| state.consecutive_errors + 1);
                updates.consecutive_errors = Some(errors);
                updates.last_error = Some(Some(error.to_string()));
                if !self.is_current(&rule.id, generation) {
                    return Ok(());
                }
                self.inner
                    .repository
                    .upsert_watch_rule_state(&rule.id, updates)
                    .await?;
                self.push_sample(&rule.id, now, None, false);
                if errors >= self.inner.config.error_threshold {
                    self.disable_rule_for_errors(rule, generation, errors, error.message())
                        .await?;
                }
                return Ok(());
            }
        };

        let mut fired = false;
        if matched && passes_cooldown_gate(rule, state, now) {
            self.emit_trigger(
                rule,
                &WatchEvalOutput {
                    hit: true,
                    ..WatchEvalOutput::default()
                },
                None,
                false,
                Some(&reason),
            )
            .await;
            updates.last_triggered_at = Some(Some(to_iso(now)));
            fired = true;
        }
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.inner
            .repository
            .upsert_watch_rule_state(&rule.id, updates)
            .await?;
        self.push_sample(
            &rule.id,
            now,
            matched.then(|| {
                if reason.is_empty() {
                    "matched".to_owned()
                } else {
                    reason.clone()
                }
            }),
            fired,
        );
        if fired && rule.fire_mode == "once" {
            self.inner
                .repository
                .update_watch_rule(
                    &rule.id,
                    WatchRuleUpdate {
                        enabled: Some(false),
                        ..WatchRuleUpdate::default()
                    },
                )
                .await?;
            self.teardown_current(&rule.id, generation).await;
        }
        Ok(())
    }

    async fn record_rule_error(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
        message: &str,
        now: DateTime<Utc>,
    ) -> Result<(), WatchServiceError> {
        let state = self.inner.repository.get_watch_rule_state(&rule.id).await?;
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        let errors = state.map_or(1, |state| state.consecutive_errors + 1);
        self.inner
            .repository
            .upsert_watch_rule_state(
                &rule.id,
                WatchRuleStateUpdate {
                    last_sampled_at: Some(Some(to_iso(now))),
                    consecutive_errors: Some(errors),
                    last_error: Some(Some(message.to_owned())),
                    ..WatchRuleStateUpdate::default()
                },
            )
            .await?;
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.push_sample(&rule.id, now, None, false);
        if errors >= self.inner.config.error_threshold {
            self.disable_rule_for_errors(rule, generation, errors, message)
                .await?;
        }
        Ok(())
    }

    async fn handle_pane_gone(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
    ) -> Result<(), WatchServiceError> {
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.inner.repository.delete_watch_rule(&rule.id).await?;
        self.teardown_current(&rule.id, generation).await;
        lock(&self.inner.state).samples.remove(&rule.id);
        let message = self.inner.runtime.format_message(&WatchMessage::PaneGone {
            name: rule.name.clone(),
            pane_id: rule.pane_id.clone(),
        });
        let mut payload = JsonMap::new();
        payload.insert("message".to_owned(), json!(message));
        payload.insert("ruleId".to_owned(), json!(rule.id));
        payload.insert("ruleName".to_owned(), json!(rule.name));
        payload.insert("paneGone".to_owned(), json!(true));
        self.safe_notify(
            EventType::WatchRuleError,
            rule,
            payload,
            Some(PaneContext {
                pane_id: Some(rule.pane_id.clone()),
                ..PaneContext::default()
            }),
        )
        .await;
        self.broadcast_safe(rule, WATCH_EVENT_RULE_ERROR, json!({ "message": message }));
        Ok(())
    }

    async fn disable_rule_for_errors(
        &self,
        rule: &watch_rules::Model,
        generation: u64,
        error_count: i64,
        detail: &str,
    ) -> Result<(), WatchServiceError> {
        if !self.is_current(&rule.id, generation) {
            return Ok(());
        }
        self.inner
            .repository
            .update_watch_rule(
                &rule.id,
                WatchRuleUpdate {
                    enabled: Some(false),
                    ..WatchRuleUpdate::default()
                },
            )
            .await?;
        self.teardown_current(&rule.id, generation).await;
        let message = self.inner.runtime.format_message(&WatchMessage::RuleError {
            name: rule.name.clone(),
            count: error_count,
            message: detail.to_owned(),
        });
        let mut payload = JsonMap::new();
        payload.insert("message".to_owned(), json!(message));
        payload.insert("ruleId".to_owned(), json!(rule.id));
        payload.insert("ruleName".to_owned(), json!(rule.name));
        payload.insert("consecutiveErrors".to_owned(), json!(error_count));
        self.safe_notify(EventType::WatchRuleError, rule, payload, None)
            .await;
        self.broadcast_safe(rule, WATCH_EVENT_RULE_ERROR, json!({ "message": message }));
        Ok(())
    }

    async fn raise_model_unavailable(
        &self,
        rule: &watch_rules::Model,
        already_notified: bool,
        detail: &str,
    ) -> bool {
        if already_notified {
            return true;
        }
        let message = self
            .inner
            .runtime
            .format_message(&WatchMessage::ModelUnavailable {
                name: rule.name.clone(),
                message: detail.to_owned(),
            });
        let mut payload = JsonMap::new();
        payload.insert("message".to_owned(), json!(message));
        payload.insert("ruleId".to_owned(), json!(rule.id));
        payload.insert("ruleName".to_owned(), json!(rule.name));
        self.safe_notify(EventType::WatchModelUnavailable, rule, payload, None)
            .await;
        self.broadcast_safe(
            rule,
            WATCH_EVENT_MODEL_UNAVAILABLE,
            json!({ "message": message }),
        );
        true
    }

    async fn emit_trigger(
        &self,
        rule: &watch_rules::Model,
        output: &WatchEvalOutput,
        summary: Option<&str>,
        unconfirmed: bool,
        llm_reason: Option<&str>,
    ) {
        let message = self.build_trigger_message(rule, output, summary, unconfirmed, llm_reason);
        let mut payload = JsonMap::new();
        payload.insert("message".to_owned(), json!(message));
        payload.insert("ruleId".to_owned(), json!(rule.id));
        payload.insert("ruleName".to_owned(), json!(rule.name));
        payload.insert("triggerType".to_owned(), json!(rule.trigger_type));
        if let Some(value) = output.value.as_ref() {
            payload.insert("value".to_owned(), json!(value));
        }
        if let Some(value) = output.matched_text.as_ref() {
            payload.insert("matchedText".to_owned(), json!(value));
        }
        if let Some(value) = output.stuck_minutes {
            payload.insert("stuckMinutes".to_owned(), json!(value));
        }
        if let Some(value) = summary {
            payload.insert("summary".to_owned(), json!(value));
        }
        if let Some(value) = llm_reason {
            payload.insert("reason".to_owned(), json!(value));
        }
        if unconfirmed {
            payload.insert("unconfirmed".to_owned(), json!(true));
        }
        let pane_context = self
            .safe_notify(EventType::WatchTriggered, rule, payload, None)
            .await;
        let mut broadcast = JsonMap::new();
        broadcast.insert("summary".to_owned(), json!(message));
        if let Some(value) = output.matched_text.as_ref() {
            broadcast.insert("matchedText".to_owned(), json!(value));
        }
        if let Some(window_id) = pane_context.and_then(|context| context.window_id) {
            broadcast.insert("windowId".to_owned(), json!(window_id));
        }
        self.broadcast_safe(rule, WATCH_EVENT_TRIGGERED, JsonValue::Object(broadcast));
    }

    fn build_trigger_message(
        &self,
        rule: &watch_rules::Model,
        output: &WatchEvalOutput,
        summary: Option<&str>,
        unconfirmed: bool,
        llm_reason: Option<&str>,
    ) -> String {
        let message = if let Some(summary) = summary {
            WatchMessage::SummaryTriggered {
                name: rule.name.clone(),
                summary: summary.to_owned(),
            }
        } else if rule.trigger_type == "unchanged" {
            WatchMessage::UnchangedTriggered {
                name: rule.name.clone(),
                value: output.value.clone().unwrap_or_default(),
                minutes: output.stuck_minutes.unwrap_or_default(),
            }
        } else if rule.trigger_type == "llm" {
            WatchMessage::LlmTriggered {
                name: rule.name.clone(),
                reason: llm_reason.unwrap_or_default().to_owned(),
            }
        } else {
            WatchMessage::MatchTriggered {
                name: rule.name.clone(),
                text: output.matched_text.clone().unwrap_or_default(),
            }
        };
        let mut formatted = self.inner.runtime.format_message(&message);
        if unconfirmed {
            formatted.push_str(
                &self
                    .inner
                    .runtime
                    .format_message(&WatchMessage::UnconfirmedSuffix),
            );
        }
        formatted
    }

    async fn safe_notify(
        &self,
        event_type: EventType,
        rule: &watch_rules::Model,
        payload: JsonMap<String, JsonValue>,
        pane_context: Option<PaneContext>,
    ) -> Option<PaneContext> {
        let settings = match self
            .inner
            .repository
            .get_site_settings(&self.inner.config.site_settings_defaults)
            .await
        {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(rule_id = rule.id, %error, "failed to load settings for watch notification");
                return None;
            }
        };
        let device = match self
            .inner
            .repository
            .get_device_by_id(&rule.device_id)
            .await
        {
            Ok(device) => device,
            Err(error) => {
                tracing::error!(rule_id = rule.id, %error, "failed to load device for watch notification");
                return None;
            }
        };
        let context = match pane_context {
            Some(context) => context,
            None => self.build_pane_context(rule, &settings.site_url).await,
        };
        let event = EventDraft {
            site: EventSite {
                name: settings.site_name,
                url: settings.site_url,
            },
            device: EventDevice {
                id: device
                    .as_ref()
                    .map_or_else(|| rule.device_id.clone(), |device| device.id.clone()),
                name: device
                    .as_ref()
                    .map_or_else(|| "unknown".to_owned(), |device| device.name.clone()),
                device_type: device
                    .as_ref()
                    .map_or_else(|| "local".to_owned(), |device| device.r#type.clone()),
                host: device.as_ref().and_then(|device| device.host.clone()),
            },
            tmux: Some(EventTmux {
                session_name: device.and_then(|device| device.session),
                window_id: context.window_id.clone(),
                window_index: context.window_index,
                pane_id: context
                    .pane_id
                    .clone()
                    .or_else(|| Some(rule.pane_id.clone())),
                pane_index: context.pane_index,
                pane_url: context.pane_url.clone(),
                pane_title: context.pane_title.clone(),
                pane_current_command: context.pane_current_command.clone(),
                pane_current_path: context.pane_current_path.clone(),
            }),
            payload: Some(payload),
        };
        if let Err(error) = self.inner.runtime.notify(event_type, event).await {
            tracing::error!(rule_id = rule.id, %error, "watch notification failed");
        }
        Some(context)
    }

    async fn build_pane_context(&self, rule: &watch_rules::Model, site_url: &str) -> PaneContext {
        let Some(device) = self.device_entry(&rule.device_id) else {
            return PaneContext {
                pane_id: Some(rule.pane_id.clone()),
                ..PaneContext::default()
            };
        };
        let snapshot = lock(&device.snapshot).clone();
        let Some(session) = snapshot.and_then(|snapshot| snapshot.session) else {
            return PaneContext {
                pane_id: Some(rule.pane_id.clone()),
                ..PaneContext::default()
            };
        };

        let matched = session.windows.iter().find_map(|window| {
            window
                .panes
                .iter()
                .find(|pane| pane.id == rule.pane_id)
                .map(|pane| (window, pane))
        });
        let window = matched
            .map(|(window, _)| window)
            .or_else(|| session.windows.iter().find(|window| window.active))
            .or_else(|| session.windows.first());
        let pane = matched.map(|(_, pane)| pane).or_else(|| {
            window.and_then(|window| {
                window
                    .panes
                    .iter()
                    .find(|pane| pane.id == rule.pane_id)
                    .or_else(|| window.panes.iter().find(|pane| pane.active))
                    .or_else(|| window.panes.first())
            })
        });
        let runtime = device.connection.lock().await.runtime.clone();
        let custom_name = pane
            .and_then(|pane| {
                runtime
                    .as_ref()
                    .and_then(|runtime| runtime.custom_name(WatchTmuxEntityKind::Pane, &pane.id))
            })
            .or_else(|| {
                window.and_then(|window| {
                    runtime.as_ref().and_then(|runtime| {
                        runtime.custom_name(WatchTmuxEntityKind::Window, &window.id)
                    })
                })
            });
        let pane_url = window.zip(pane).map(|(window, pane)| {
            format!(
                "{}/devices/{}/windows/{}/panes/{}",
                site_url.trim_end_matches('/'),
                encode_uri_component(&rule.device_id),
                encode_uri_component(&window.id),
                encode_uri_component(&pane.id)
            )
        });
        PaneContext {
            window_id: window.map(|window| window.id.clone()),
            window_index: window.map(|window| i64::from(window.index)),
            pane_id: pane
                .map(|pane| pane.id.clone())
                .or_else(|| Some(rule.pane_id.clone())),
            pane_index: pane.map(|pane| i64::from(pane.index)),
            pane_url,
            pane_title: custom_name.or_else(|| {
                pane.and_then(|pane| pane.custom_name.clone().or_else(|| pane.title.clone()))
            }),
            pane_current_command: pane.and_then(|pane| pane.current_command.clone()),
            pane_current_path: pane.and_then(|pane| pane.current_path.clone()),
        }
    }

    fn broadcast_safe(&self, rule: &watch_rules::Model, event_type: u8, payload: JsonValue) {
        let payload = match serde_json::to_vec(&payload) {
            Ok(payload) => payload,
            Err(error) => {
                tracing::error!(rule_id = rule.id, %error, "failed to encode watch broadcast");
                return;
            }
        };
        if let Err(error) = self.inner.runtime.broadcast(WatchEvent {
            rule_id: rule.id.clone(),
            device_id: rule.device_id.clone(),
            pane_id: rule.pane_id.clone(),
            event_type,
            payload,
        }) {
            tracing::error!(rule_id = rule.id, %error, "watch broadcast failed");
        }
    }

    async fn call_confirm(
        &self,
        rule: &watch_rules::Model,
        output: &WatchEvalOutput,
        screen: &str,
    ) -> Result<bool, WatchRuntimeError> {
        match self
            .inner
            .runtime
            .generate(self.llm_request(
                rule,
                WatchLlmOperation::Confirm,
                build_confirm_prompt(rule, output, screen),
            ))
            .await?
        {
            WatchLlmResponse::Confirm { confirmed, .. } => Ok(confirmed),
            other => Err(unexpected_llm_response("confirm", &other)),
        }
    }

    async fn call_summary(
        &self,
        rule: &watch_rules::Model,
        output: &WatchEvalOutput,
        screen: &str,
    ) -> Result<String, WatchRuntimeError> {
        match self
            .inner
            .runtime
            .generate(self.llm_request(
                rule,
                WatchLlmOperation::Summary,
                build_summary_prompt(rule, output, screen),
            ))
            .await?
        {
            WatchLlmResponse::Summary { summary } => Ok(summary),
            other => Err(unexpected_llm_response("summary", &other)),
        }
    }

    async fn call_judge(
        &self,
        rule: &watch_rules::Model,
        screen: &str,
    ) -> Result<(bool, String), WatchRuntimeError> {
        match self
            .inner
            .runtime
            .generate(self.llm_request(
                rule,
                WatchLlmOperation::Judge,
                build_judge_prompt(rule, screen),
            ))
            .await?
        {
            WatchLlmResponse::Judge { matched, reason } => Ok((matched, reason)),
            other => Err(unexpected_llm_response("judge", &other)),
        }
    }

    fn llm_request(
        &self,
        rule: &watch_rules::Model,
        operation: WatchLlmOperation,
        prompt: String,
    ) -> WatchLlmRequest {
        WatchLlmRequest {
            operation,
            provider_id: rule.provider_id.clone(),
            model_id: rule.model_id.clone(),
            prompt,
            max_retries: self.inner.config.llm_max_retries,
        }
    }

    fn is_current(&self, rule_id: &str, generation: u64) -> bool {
        lock(&self.inner.state)
            .rules
            .get(rule_id)
            .is_some_and(|entry| entry.generation == generation)
    }

    fn device_entry(&self, device_id: &str) -> Option<Arc<DeviceEntry>> {
        lock(&self.inner.state)
            .devices
            .get(device_id)
            .map(|slot| slot.entry.clone())
    }

    fn push_sample(&self, rule_id: &str, at: DateTime<Utc>, value: Option<String>, hit: bool) {
        let mut state = lock(&self.inner.state);
        let ring = state.samples.entry(rule_id.to_owned()).or_default();
        ring.push(WatchRuleSample {
            at: to_iso(at),
            value,
            hit,
        });
        if ring.len() > SAMPLE_RING_LIMIT {
            ring.drain(..ring.len() - SAMPLE_RING_LIMIT);
        }
    }
}

impl InFlight {
    async fn wait(&self) {
        while !self.completed.load(Ordering::Acquire) {
            let notified = self.notify.notified();
            if self.completed.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }
}

impl Drop for TickGuard {
    fn drop(&mut self) {
        {
            let mut current = lock(&self.entry.in_flight);
            if current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &self.in_flight))
            {
                *current = None;
            }
        }
        self.in_flight.completed.store(true, Ordering::Release);
        self.in_flight.notify.notify_waiters();
    }
}

impl WatchDeviceListener for DeviceListener {
    fn on_snapshot(&self, snapshot: StateSnapshot) {
        let Some(device) = self.device.upgrade() else {
            return;
        };
        if device.active.load(Ordering::Acquire)
            && device.connection_generation.load(Ordering::Acquire) == self.generation
            && !device.closed.load(Ordering::Acquire)
        {
            *lock(&device.snapshot) = Some(snapshot);
        }
    }

    fn on_close(&self) {
        let Some(inner) = self.service.upgrade() else {
            return;
        };
        let Some(device) = self.device.upgrade() else {
            return;
        };
        if !device.active.load(Ordering::Acquire)
            || device.connection_generation.load(Ordering::Acquire) != self.generation
        {
            return;
        }
        if device
            .closed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let Some(host) = self.host.upgrade() else {
            return;
        };
        if let Err(error) = host.device_closed(&device.device_id) {
            tracing::error!(device_id = device.device_id, %error, "failed to publish watch device close");
        }
        let generation = self.generation;
        host.spawn(Box::pin(async move {
            WatchService { inner }
                .handle_device_close(device, runtime, generation)
                .await;
        }));
    }
}

fn passes_cooldown_gate(
    rule: &watch_rules::Model,
    state: Option<&watch_rule_state::Model>,
    now: DateTime<Utc>,
) -> bool {
    if rule.fire_mode == "once" {
        return true;
    }
    let Some(last_triggered_at) = state
        .and_then(|state| state.last_triggered_at.as_deref())
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return true;
    };
    let elapsed = now.timestamp_millis() - last_triggered_at.timestamp_millis();
    elapsed >= rule.cooldown_seconds.max(0).saturating_mul(1_000)
}

fn unexpected_llm_response(operation: &str, response: &WatchLlmResponse) -> WatchRuntimeError {
    WatchRuntimeError::new(format!(
        "LLM runtime returned {response:?} for {operation} operation"
    ))
}

fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET).to_string()
}

fn to_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tmex_db::DbConfig;
    use tokio::sync::Semaphore;

    use crate::database::repository::CreateWatchRuleInput;
    use crate::database::DatabaseBootstrap;
    use crate::entity::devices;

    use super::*;
    use crate::watch::{WatchFuture, WatchIntervalCallback};

    struct TestSchedule {
        canceled: AtomicBool,
    }

    impl WatchSchedule for TestSchedule {
        fn cancel(&self) {
            self.canceled.store(true, Ordering::Release);
        }
    }

    struct TestSubscription;

    impl WatchSubscription for TestSubscription {
        fn detach(&self) {}
    }

    #[derive(Clone)]
    enum CaptureBehavior {
        Immediate(Result<String, WatchRuntimeError>),
        Blocked {
            started: Arc<Semaphore>,
            release: Arc<Semaphore>,
            result: Result<String, WatchRuntimeError>,
        },
    }

    struct TestDevice {
        behavior: CaptureBehavior,
        capture_calls: AtomicUsize,
        listener: Mutex<Option<Arc<dyn WatchDeviceListener>>>,
    }

    #[async_trait]
    impl WatchDevice for TestDevice {
        async fn connect(&self) -> Result<(), WatchRuntimeError> {
            Ok(())
        }

        async fn capture_pane_text(&self, _pane_id: &str) -> Result<String, WatchRuntimeError> {
            self.capture_calls.fetch_add(1, Ordering::AcqRel);
            match &self.behavior {
                CaptureBehavior::Immediate(result) => result.clone(),
                CaptureBehavior::Blocked {
                    started,
                    release,
                    result,
                } => {
                    started.add_permits(1);
                    let permit = release
                        .acquire()
                        .await
                        .map_err(|_| WatchRuntimeError::new("capture release closed"))?;
                    permit.forget();
                    result.clone()
                }
            }
        }

        fn subscribe(
            &self,
            listener: Arc<dyn WatchDeviceListener>,
        ) -> Result<Arc<dyn WatchSubscription>, WatchRuntimeError> {
            *lock(&self.listener) = Some(listener);
            Ok(Arc::new(TestSubscription))
        }

        fn request_snapshot(&self) -> Result<(), WatchRuntimeError> {
            Ok(())
        }
    }

    struct TestRuntime {
        now: DateTime<Utc>,
        device: Arc<TestDevice>,
        llm: Mutex<VecDeque<Result<WatchLlmResponse, WatchRuntimeError>>>,
        notifications: Mutex<Vec<(EventType, EventDraft)>>,
        broadcasts: Mutex<Vec<WatchEvent>>,
        acquire_count: AtomicUsize,
        release_count: AtomicUsize,
    }

    impl TestRuntime {
        fn new(device: Arc<TestDevice>) -> Self {
            Self {
                now: DateTime::parse_from_rfc3339("2026-08-12T12:00:00.000Z")
                    .expect("test timestamp")
                    .with_timezone(&Utc),
                device,
                llm: Mutex::new(VecDeque::new()),
                notifications: Mutex::new(Vec::new()),
                broadcasts: Mutex::new(Vec::new()),
                acquire_count: AtomicUsize::new(0),
                release_count: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl WatchRuntime for TestRuntime {
        fn now(&self) -> DateTime<Utc> {
            self.now
        }

        fn schedule_interval(
            &self,
            _interval: Duration,
            _callback: WatchIntervalCallback,
        ) -> Result<Arc<dyn WatchSchedule>, WatchRuntimeError> {
            Ok(Arc::new(TestSchedule {
                canceled: AtomicBool::new(false),
            }))
        }

        fn spawn(&self, future: WatchFuture) {
            tokio::spawn(future);
        }

        async fn acquire_device(
            &self,
            _device_id: &str,
        ) -> Result<Arc<dyn WatchDevice>, WatchRuntimeError> {
            self.acquire_count.fetch_add(1, Ordering::AcqRel);
            Ok(self.device.clone())
        }

        async fn release_device(
            &self,
            _device_id: &str,
            _device: Arc<dyn WatchDevice>,
        ) -> Result<(), WatchRuntimeError> {
            self.release_count.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        async fn generate(
            &self,
            _request: WatchLlmRequest,
        ) -> Result<WatchLlmResponse, WatchRuntimeError> {
            lock(&self.llm)
                .pop_front()
                .unwrap_or_else(|| Err(WatchRuntimeError::new("missing test LLM response")))
        }

        async fn notify(
            &self,
            event_type: EventType,
            event: EventDraft,
        ) -> Result<(), WatchRuntimeError> {
            lock(&self.notifications).push((event_type, event));
            Ok(())
        }

        fn broadcast(&self, event: WatchEvent) -> Result<(), WatchRuntimeError> {
            lock(&self.broadcasts).push(event);
            Ok(())
        }
    }

    async fn test_repository() -> Repository {
        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .expect("bootstrap watch test database");
        let repository = Repository::new(database);
        repository
            .create_device(devices::Model {
                id: "device-1".to_owned(),
                name: "local".to_owned(),
                r#type: "local".to_owned(),
                host: None,
                port: Some(22),
                username: None,
                ssh_config_ref: None,
                session: Some("tmex".to_owned()),
                auth_mode: "auto".to_owned(),
                password_enc: None,
                private_key_enc: None,
                private_key_passphrase_enc: None,
                default_working_dir: None,
                sort_order: 0,
                created_at: "2026-08-12T12:00:00.000Z".to_owned(),
                updated_at: "2026-08-12T12:00:00.000Z".to_owned(),
            })
            .await
            .expect("create watch test device");
        repository
    }

    fn test_config() -> WatchServiceConfig {
        WatchServiceConfig::new(RepositorySiteSettingsDefaults {
            site_name: "tmex".to_owned(),
            site_url: "http://localhost:9883".to_owned(),
            bell_throttle_seconds: 5,
            notification_throttle_seconds: 5,
            ssh_reconnect_max_retries: 3,
            ssh_reconnect_delay_seconds: 2,
            language: "en_US".to_owned(),
        })
    }

    async fn create_rule(repository: &Repository, confirm_with_llm: bool) -> watch_rules::Model {
        repository
            .create_watch_rule(CreateWatchRuleInput {
                name: "watch test".to_owned(),
                device_id: "device-1".to_owned(),
                pane_id: "%1".to_owned(),
                enabled: Some(true),
                trigger_type: "match".to_owned(),
                pattern: Some("STUCK".to_owned()),
                pattern_flags: Some(String::new()),
                extract_group: Some(0),
                condition_prompt: None,
                provider_id: None,
                model_id: None,
                confirm_with_llm: Some(confirm_with_llm),
                summarize_with_llm: Some(false),
                interval_seconds: Some(1),
                unchanged_minutes: None,
                no_match_behavior: Some("reset".to_owned()),
                fire_mode: Some("repeat".to_owned()),
                cooldown_seconds: Some(0),
            })
            .await
            .expect("create watch test rule")
    }

    #[tokio::test]
    async fn overlapping_tick_is_skipped_and_removal_discards_the_late_capture() {
        let repository = test_repository().await;
        let rule = create_rule(&repository, false).await;
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let device = Arc::new(TestDevice {
            behavior: CaptureBehavior::Blocked {
                started: started.clone(),
                release: release.clone(),
                result: Ok("STUCK".to_owned()),
            },
            capture_calls: AtomicUsize::new(0),
            listener: Mutex::new(None),
        });
        let runtime = Arc::new(TestRuntime::new(device.clone()));
        let service = WatchService::new(repository.clone(), runtime.clone(), test_config());
        service.start().await.expect("start watch service");

        let first_service = service.clone();
        let rule_id = rule.id.clone();
        let first = tokio::spawn(async move { first_service.tick_rule(&rule_id).await });
        started.acquire().await.expect("capture started").forget();

        service
            .tick_rule(&rule.id)
            .await
            .expect("overlapping tick is a no-op");
        assert_eq!(device.capture_calls.load(Ordering::Acquire), 1);

        let remove_service = service.clone();
        let remove_rule_id = rule.id.clone();
        let remove = tokio::spawn(async move {
            remove_service.remove_rule(&remove_rule_id).await;
        });
        tokio::task::yield_now().await;
        assert!(!remove.is_finished());

        release.add_permits(1);
        first
            .await
            .expect("join first tick")
            .expect("finish first tick");
        remove.await.expect("finish removal");

        assert!(service.get_samples(&rule.id).is_empty());
        assert!(repository
            .get_watch_rule_state(&rule.id)
            .await
            .expect("read watch state")
            .is_none());
        assert!(lock(&runtime.notifications).is_empty());
        assert_eq!(runtime.acquire_count.load(Ordering::Acquire), 1);
        assert_eq!(runtime.release_count.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn confirm_failure_fails_open_without_repeating_alert_until_recovery() {
        let repository = test_repository().await;
        let rule = create_rule(&repository, true).await;
        let device = Arc::new(TestDevice {
            behavior: CaptureBehavior::Immediate(Ok("upload STUCK".to_owned())),
            capture_calls: AtomicUsize::new(0),
            listener: Mutex::new(None),
        });
        let runtime = Arc::new(TestRuntime::new(device));
        lock(&runtime.llm).extend([
            Err(WatchRuntimeError::new("model down")),
            Err(WatchRuntimeError::new("model still down")),
            Ok(WatchLlmResponse::Confirm {
                confirmed: true,
                reason: "recovered".to_owned(),
            }),
            Err(WatchRuntimeError::new("model down again")),
        ]);
        let service = WatchService::new(repository.clone(), runtime.clone(), test_config());
        service.start().await.expect("start watch service");

        for _ in 0..4 {
            service
                .tick_rule(&rule.id)
                .await
                .expect("run confirm watch tick");
        }

        {
            let notifications = lock(&runtime.notifications);
            assert_eq!(
                notifications
                    .iter()
                    .filter(|(kind, _)| *kind == EventType::WatchModelUnavailable)
                    .count(),
                2
            );
            let triggered = notifications
                .iter()
                .filter(|(kind, _)| *kind == EventType::WatchTriggered)
                .collect::<Vec<_>>();
            assert_eq!(triggered.len(), 4);
            assert_eq!(
                triggered[0]
                    .1
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("unconfirmed")),
                Some(&json!(true))
            );
            assert!(triggered[2]
                .1
                .payload
                .as_ref()
                .is_some_and(|payload| !payload.contains_key("unconfirmed")));
        }

        let state = repository
            .get_watch_rule_state(&rule.id)
            .await
            .expect("read watch state")
            .expect("watch state exists");
        assert_eq!(state.model_unavailable_notified, 1);
        service.stop().await;
    }

    #[tokio::test]
    async fn missing_pane_deletes_the_rule_on_the_first_tick() {
        let repository = test_repository().await;
        let rule = create_rule(&repository, false).await;
        let device = Arc::new(TestDevice {
            behavior: CaptureBehavior::Immediate(Err(WatchRuntimeError::new(
                "can't find pane: %1",
            ))),
            capture_calls: AtomicUsize::new(0),
            listener: Mutex::new(None),
        });
        let runtime = Arc::new(TestRuntime::new(device));
        let service = WatchService::new(repository.clone(), runtime.clone(), test_config());
        service.start().await.expect("start watch service");

        service
            .tick_rule(&rule.id)
            .await
            .expect("run missing pane tick");

        assert!(repository
            .get_watch_rule_by_id(&rule.id)
            .await
            .expect("read deleted rule")
            .is_none());
        assert!(!service.is_rule_scheduled(&rule.id));
        let notifications = lock(&runtime.notifications);
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].0, EventType::WatchRuleError);
        assert_eq!(
            notifications[0]
                .1
                .payload
                .as_ref()
                .and_then(|payload| payload.get("paneGone")),
            Some(&json!(true))
        );
        drop(notifications);
        assert_eq!(
            lock(&runtime.broadcasts)[0].event_type,
            WATCH_EVENT_RULE_ERROR
        );
        assert_eq!(runtime.release_count.load(Ordering::Acquire), 1);
    }
}
