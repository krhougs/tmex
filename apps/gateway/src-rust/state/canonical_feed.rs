use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::Arc;

use futures_util::FutureExt;
use tmex_protocol::{
    encode_canonical_event, CanonicalCommand, CanonicalContentChunk, CanonicalError,
    CanonicalEvent, CanonicalFeedReady, CanonicalGapScope, CanonicalHistoryBegin,
    CanonicalHistoryCommit, CanonicalPaneData, CanonicalPaneGap, CanonicalPaneSubscription,
    CanonicalPaneTarget, CanonicalRequestHistory, CanonicalRequestScreen, CanonicalResizePane,
    CanonicalScreenBegin, CanonicalScreenCommit, CanonicalSourceGap, CanonicalSubscriptionApplied,
    CanonicalSubscriptionRejection, CanonicalTerminalInput, CanonicalTerminalKeyInput,
    ProtocolErrorCode, SetPaneSubscriptions, SourceMetadataPatch, SourceMetadataRecord,
    SourceMetadataSnapshot, TerminalKey, TerminalKeyAction, WireToken,
    CANONICAL_STATE_MAX_FRAME_BYTES, SOURCE_GAP_REASON_CACHE_EVICTED,
    SOURCE_GAP_REASON_EPOCH_CHANGED, SOURCE_GAP_REASON_PANE_GAP,
    SOURCE_GAP_REASON_RESOURCE_EXHAUSTED, SUBSCRIPTION_REJECTED_EPOCH_CHANGED,
    SUBSCRIPTION_REJECTED_NOT_FOUND, SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED,
    WS_ENVELOPE_WIRE_OVERHEAD_BYTES,
};

use super::runtime::{
    CanonicalDetachHandle, CanonicalFeedRuntime, CanonicalFeedRuntimeListener,
    CanonicalRuntimeError, CanonicalTask, MetadataProjectionSnapshot, PaneDataSegment,
    PaneHistoryCursorError, PaneHistoryPage, PaneIdentity, PaneReplayGap, PaneReplayGapReason,
    PaneRetentionConsumerCallbacks, PaneRetentionLease, PaneScreenCheckpoint,
    PaneSubscriptionRejectionReason, PaneSubscriptionRequest, RuntimeFuture,
};

pub const CANONICAL_MAX_SCREEN_BYTES: u32 = 512 * 1024;
pub const CANONICAL_MAX_HISTORY_PAGE_BYTES: u32 = 256 * 1024;
pub const CANONICAL_MAX_PENDING_PANE_GAPS: usize = 256;
pub const CANONICAL_MAX_INPUT_DEDUP_IDS: usize = 1_024;
pub const CANONICAL_MAX_SCREEN_WAITERS_PER_PANE: usize = 2;
pub const CANONICAL_MAX_HISTORY_JOBS: usize = 64;
pub const CANONICAL_MAX_SCREEN_FANOUT_BYTES: usize = 960 * 1024;
pub const CANONICAL_PENDING_SWEEP_MS: u64 = 250;
pub const CANONICAL_RUNTIME_REQUEST_DEADLINE_MS: u64 = 35_000;
pub const CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY: usize = 1_024;
pub const GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS: u64 = 16;
pub const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;

const MIN_CANONICAL_FRAME_BYTES: usize = WS_ENVELOPE_WIRE_OVERHEAD_BYTES + 64;
const DEFAULT_MAX_ACTIVE_PANES: u16 = 32;
const DEFAULT_MAX_HOT_PANES: u16 = 8;

pub type RuntimeResolver = Arc<
    dyn Fn(
            String,
        ) -> RuntimeFuture<
            'static,
            Result<Option<Arc<dyn CanonicalFeedRuntime>>, CanonicalRuntimeError>,
        > + Send
        + Sync,
>;
pub type CanonicalEventSender = Arc<dyn Fn(CanonicalEvent) -> bool + Send + Sync>;
pub type CanonicalTaskSpawner = Arc<dyn Fn(CanonicalTask) + Send + Sync>;
pub type CanonicalClock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type EpochFactory = Arc<dyn Fn() -> WireToken + Send + Sync>;
pub type CanonicalPollRequester = Arc<dyn Fn() + Send + Sync>;
pub type DeviceRuntimeCallback = Arc<dyn Fn(&str, Arc<dyn CanonicalFeedRuntime>) + Send + Sync>;

pub struct CanonicalFeedSessionOptions {
    pub max_frame_bytes: usize,
    pub gateway_epoch: WireToken,
    pub send_event: CanonicalEventSender,
    pub resolve_runtime: RuntimeResolver,
    pub spawn_task: CanonicalTaskSpawner,
    pub request_poll: CanonicalPollRequester,
    pub now_ms: CanonicalClock,
    pub create_snapshot_id: EpochFactory,
    pub initial_device_ids: Option<Arc<dyn Fn() -> Vec<String> + Send + Sync>>,
    pub on_device_attached: Option<DeviceRuntimeCallback>,
    pub on_device_detached: Option<DeviceRuntimeCallback>,
    pub max_pending_pane_gaps: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalFeedSessionConfigError {
    message: String,
}

impl fmt::Display for CanonicalFeedSessionConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CanonicalFeedSessionConfigError {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PaneGapReasonStats {
    pub pane_gap: u64,
    pub epoch_changed: u64,
    pub cache_evicted: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalFeedSessionStats {
    pub attached_runtimes: usize,
    pub screen_jobs: usize,
    pub gated_panes: usize,
    pub pending_pane_gaps: usize,
    pub pending_pane_gap_limit: usize,
    pub stream_gap_pending: bool,
    pub input_dedup_ids: usize,
    pub input_dedup_limit: usize,
    pub pane_data_deliveries: u64,
    pub pane_data_bytes: u64,
    pub pane_data_drops: u64,
    pub pane_data_drop_bytes: u64,
    pub pending_pane_gap_overflows: u64,
    pub pane_gaps_sent: u64,
    pub pane_gaps_by_reason: PaneGapReasonStats,
    pub stream_gaps_sent: u64,
    pub screen_transactions_started: u64,
    pub screen_transactions_completed: u64,
    pub screen_transactions_failed: u64,
    pub screen_transactions_cancelled: u64,
    pub runtime_event_overflows: u64,
}

type PaneKey = (String, String);

struct AttachedDevice {
    runtime: Arc<dyn CanonicalFeedRuntime>,
    lease: PaneRetentionLease,
    detach_listener: CanonicalDetachHandle,
    metadata_needs_rebase: bool,
}

#[derive(Clone)]
struct ScreenJob {
    id: u64,
    request_ids: Vec<WireToken>,
    pane_epoch: WireToken,
    byte_limit: u32,
    cancelled: bool,
}

struct ResolvedTarget {
    device_id: String,
    runtime: Arc<dyn CanonicalFeedRuntime>,
    pane: PaneIdentity,
    target: CanonicalPaneTarget,
}

struct PendingPaneDataBatch {
    device_id: String,
    pane_id: String,
    pane_epoch: WireToken,
    seq_start: u64,
    seq_end: u64,
    chunks: Vec<Vec<u8>>,
    length: usize,
    due_at_ms: u64,
}

enum RuntimeEvent {
    PaneData {
        device_id: String,
        received_at_ms: u64,
        segment: PaneDataSegment,
    },
    PaneGap {
        device_id: String,
        gap: PaneReplayGap,
    },
    MetadataPatch {
        device_id: String,
        patch: SourceMetadataPatch,
    },
    MetadataRebaseRequired {
        device_id: String,
    },
    RuntimeClosed {
        device_id: String,
    },
    ScreenFinished {
        job_id: u64,
        key: PaneKey,
        device_id: String,
        result: Result<Option<PaneScreenCheckpoint>, CanonicalRuntimeError>,
    },
    HistoryFinished {
        device_id: String,
        target: CanonicalPaneTarget,
        request_id: WireToken,
        result:
            Result<Result<Option<PaneHistoryPage>, PaneHistoryCursorError>, CanonicalRuntimeError>,
    },
}

#[derive(Default)]
struct RuntimeEventOverflow {
    pending: AtomicBool,
    count: AtomicU64,
}

impl RuntimeEventOverflow {
    fn record(&self) {
        self.pending.store(true, Ordering::Release);
        let _ = self
            .count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                Some(count.saturating_add(1))
            });
    }

    fn take_pending(&self) -> bool {
        self.pending.swap(false, Ordering::AcqRel)
    }

    fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }
}

pub struct CanonicalFeedSession {
    options: CanonicalFeedSessionOptions,
    devices: HashMap<String, AttachedDevice>,
    screen_jobs: HashMap<PaneKey, ScreenJob>,
    history_jobs: HashMap<WireToken, String>,
    pane_send_gaps: HashMap<PaneKey, PaneReplayGap>,
    pane_data_batches: HashMap<PaneKey, PendingPaneDataBatch>,
    input_ids: HashSet<WireToken>,
    input_id_order: VecDeque<WireToken>,
    runtime_events_tx: SyncSender<RuntimeEvent>,
    runtime_events_rx: Receiver<RuntimeEvent>,
    runtime_event_overflow: Arc<RuntimeEventOverflow>,
    max_frame_bytes: usize,
    max_pending_pane_gaps: usize,
    ready_sent: bool,
    bootstrapped: bool,
    closed: bool,
    stream_gap_pending_reason: Option<u8>,
    pending_sweep_due_at_ms: Option<u64>,
    next_screen_job_id: u64,
    pane_data_deliveries: u64,
    pane_data_bytes: u64,
    pane_data_drops: u64,
    pane_data_drop_bytes: u64,
    pending_pane_gap_overflows: u64,
    pane_gaps_sent: u64,
    pane_gaps_by_reason: PaneGapReasonStats,
    stream_gaps_sent: u64,
    screen_transactions_started: u64,
    screen_transactions_completed: u64,
    screen_transactions_failed: u64,
    screen_transactions_cancelled: u64,
}

impl CanonicalFeedSession {
    pub fn new(
        options: CanonicalFeedSessionOptions,
    ) -> Result<Self, CanonicalFeedSessionConfigError> {
        let max_pending_pane_gaps = options
            .max_pending_pane_gaps
            .unwrap_or(CANONICAL_MAX_PENDING_PANE_GAPS);
        if max_pending_pane_gaps == 0 {
            return Err(CanonicalFeedSessionConfigError {
                message: "pending pane gap limit must be positive".to_owned(),
            });
        }
        let (runtime_events_tx, runtime_events_rx) =
            mpsc::sync_channel(CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY);
        let runtime_event_overflow = Arc::new(RuntimeEventOverflow::default());
        Ok(Self {
            max_frame_bytes: options
                .max_frame_bytes
                .clamp(MIN_CANONICAL_FRAME_BYTES, CANONICAL_STATE_MAX_FRAME_BYTES),
            max_pending_pane_gaps,
            options,
            devices: HashMap::new(),
            screen_jobs: HashMap::new(),
            history_jobs: HashMap::new(),
            pane_send_gaps: HashMap::new(),
            pane_data_batches: HashMap::new(),
            input_ids: HashSet::new(),
            input_id_order: VecDeque::new(),
            runtime_events_tx,
            runtime_events_rx,
            runtime_event_overflow,
            ready_sent: false,
            bootstrapped: false,
            closed: false,
            stream_gap_pending_reason: None,
            pending_sweep_due_at_ms: None,
            next_screen_job_id: 0,
            pane_data_deliveries: 0,
            pane_data_bytes: 0,
            pane_data_drops: 0,
            pane_data_drop_bytes: 0,
            pending_pane_gap_overflows: 0,
            pane_gaps_sent: 0,
            pane_gaps_by_reason: PaneGapReasonStats::default(),
            stream_gaps_sent: 0,
            screen_transactions_started: 0,
            screen_transactions_completed: 0,
            screen_transactions_failed: 0,
            screen_transactions_cancelled: 0,
        })
    }

    pub fn snapshot_stats(&self) -> CanonicalFeedSessionStats {
        CanonicalFeedSessionStats {
            attached_runtimes: self.devices.len(),
            screen_jobs: self.screen_jobs.len(),
            gated_panes: 0,
            pending_pane_gaps: self.pane_send_gaps.len(),
            pending_pane_gap_limit: self.max_pending_pane_gaps,
            stream_gap_pending: self.stream_gap_pending_reason.is_some(),
            input_dedup_ids: self.input_ids.len(),
            input_dedup_limit: CANONICAL_MAX_INPUT_DEDUP_IDS,
            pane_data_deliveries: self.pane_data_deliveries,
            pane_data_bytes: self.pane_data_bytes,
            pane_data_drops: self.pane_data_drops,
            pane_data_drop_bytes: self.pane_data_drop_bytes,
            pending_pane_gap_overflows: self.pending_pane_gap_overflows,
            pane_gaps_sent: self.pane_gaps_sent,
            pane_gaps_by_reason: self.pane_gaps_by_reason,
            stream_gaps_sent: self.stream_gaps_sent,
            screen_transactions_started: self.screen_transactions_started,
            screen_transactions_completed: self.screen_transactions_completed,
            screen_transactions_failed: self.screen_transactions_failed,
            screen_transactions_cancelled: self.screen_transactions_cancelled,
            runtime_event_overflows: self.runtime_event_overflow.count(),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.pane_data_batches
            .values()
            .map(|batch| batch.due_at_ms)
            .chain(self.pending_sweep_due_at_ms)
            .min()
    }

    pub async fn handle_command(
        &mut self,
        command: CanonicalCommand,
    ) -> Result<(), CanonicalRuntimeError> {
        if self.closed {
            return Ok(());
        }
        let request_id = canonical_command_request_id(&command);
        self.drain_runtime_events();
        self.ensure_ready();
        if let Err(error) = self.bootstrap_initial_devices().await {
            self.send_error(
                request_id,
                ProtocolErrorCode::Internal as u16,
                &error.message,
                true,
            );
            return Ok(());
        }
        let result = match command {
            CanonicalCommand::SetPaneSubscriptions(command) => {
                self.handle_set_pane_subscriptions(command).await
            }
            CanonicalCommand::TerminalInput(command) => self.handle_terminal_input(command).await,
            CanonicalCommand::ResizePane(command) => self.handle_resize_pane(command).await,
            CanonicalCommand::RequestScreen(command) => self.handle_request_screen(command).await,
            CanonicalCommand::RequestHistory(command) => self.handle_request_history(command).await,
            CanonicalCommand::TerminalKeyInput(command) => {
                self.handle_terminal_key_input(command).await
            }
        };
        if let Err(error) = result {
            self.send_error(
                request_id,
                ProtocolErrorCode::Internal as u16,
                &error.message,
                true,
            );
        }
        self.drain_runtime_events();
        Ok(())
    }

    pub async fn attach_device(
        &mut self,
        device_id: impl Into<String>,
        runtime: Option<Arc<dyn CanonicalFeedRuntime>>,
    ) -> Result<bool, CanonicalRuntimeError> {
        if self.closed {
            return Ok(false);
        }
        self.ensure_ready();
        let device_id = device_id.into();
        if let Some(existing) = self.devices.get(&device_id) {
            if runtime
                .as_ref()
                .is_none_or(|runtime| Arc::ptr_eq(&existing.runtime, runtime))
            {
                return Ok(true);
            }
        }
        if self.devices.contains_key(&device_id) {
            self.detach_device(&device_id);
        }
        let runtime = match runtime {
            Some(runtime) => runtime,
            None => match (self.options.resolve_runtime)(device_id.clone()).await? {
                Some(runtime) => runtime,
                None => return Ok(false),
            },
        };

        let pane_sender = self.runtime_events_tx.clone();
        let pane_clock = Arc::clone(&self.options.now_ms);
        let pane_request_poll = Arc::clone(&self.options.request_poll);
        let pane_overflow = Arc::clone(&self.runtime_event_overflow);
        let pane_device_id = device_id.clone();
        let gap_sender = self.runtime_events_tx.clone();
        let gap_request_poll = Arc::clone(&self.options.request_poll);
        let gap_overflow = Arc::clone(&self.runtime_event_overflow);
        let gap_device_id = device_id.clone();
        let lease = runtime.attach_pane_consumer(PaneRetentionConsumerCallbacks {
            on_data: Arc::new(move |segment| {
                enqueue_runtime_event(
                    &pane_sender,
                    &pane_overflow,
                    &pane_request_poll,
                    RuntimeEvent::PaneData {
                        device_id: pane_device_id.clone(),
                        received_at_ms: pane_clock(),
                        segment,
                    },
                );
            }),
            on_gap: Arc::new(move |gap| {
                enqueue_runtime_event(
                    &gap_sender,
                    &gap_overflow,
                    &gap_request_poll,
                    RuntimeEvent::PaneGap {
                        device_id: gap_device_id.clone(),
                        gap,
                    },
                );
            }),
        })?;

        let patch_sender = self.runtime_events_tx.clone();
        let patch_request_poll = Arc::clone(&self.options.request_poll);
        let patch_overflow = Arc::clone(&self.runtime_event_overflow);
        let patch_device_id = device_id.clone();
        let rebase_sender = self.runtime_events_tx.clone();
        let rebase_request_poll = Arc::clone(&self.options.request_poll);
        let rebase_overflow = Arc::clone(&self.runtime_event_overflow);
        let rebase_device_id = device_id.clone();
        let close_sender = self.runtime_events_tx.clone();
        let close_request_poll = Arc::clone(&self.options.request_poll);
        let close_overflow = Arc::clone(&self.runtime_event_overflow);
        let close_device_id = device_id.clone();
        let detach_listener = runtime.subscribe(CanonicalFeedRuntimeListener {
            on_metadata_patch: Arc::new(move |patch| {
                enqueue_runtime_event(
                    &patch_sender,
                    &patch_overflow,
                    &patch_request_poll,
                    RuntimeEvent::MetadataPatch {
                        device_id: patch_device_id.clone(),
                        patch,
                    },
                );
            }),
            on_metadata_rebase_required: Arc::new(move |_| {
                enqueue_runtime_event(
                    &rebase_sender,
                    &rebase_overflow,
                    &rebase_request_poll,
                    RuntimeEvent::MetadataRebaseRequired {
                        device_id: rebase_device_id.clone(),
                    },
                );
            }),
            on_close: Arc::new(move || {
                enqueue_runtime_event(
                    &close_sender,
                    &close_overflow,
                    &close_request_poll,
                    RuntimeEvent::RuntimeClosed {
                        device_id: close_device_id.clone(),
                    },
                );
            }),
        })?;

        self.drain_runtime_events();
        self.devices.insert(
            device_id.clone(),
            AttachedDevice {
                runtime: Arc::clone(&runtime),
                lease,
                detach_listener,
                metadata_needs_rebase: true,
            },
        );
        if let Some(on_attached) = &self.options.on_device_attached {
            on_attached(&device_id, Arc::clone(&runtime));
        }
        self.send_metadata_snapshot(&device_id);
        Ok(true)
    }

    pub fn detach_device(&mut self, device_id: &str) {
        if !self.devices.contains_key(device_id) {
            return;
        }
        self.flush_pane_data_batches_for_device(device_id);
        let Some(mut attached) = self.devices.remove(device_id) else {
            return;
        };
        let keys = self
            .screen_jobs
            .keys()
            .filter(|(job_device_id, _)| job_device_id == device_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.cancel_screen_job_with_error(&key, "screen runtime was detached");
        }
        self.cancel_history_jobs_for_device(device_id, "history runtime was detached");
        attached.lease.close();
        attached.detach_listener.close();
        if let Some(on_detached) = &self.options.on_device_detached {
            on_detached(device_id, attached.runtime);
        }
    }

    pub fn on_drain(&mut self) {
        let now_ms = (self.options.now_ms)();
        self.drain_runtime_events();
        self.on_drain_at(now_ms);
    }

    pub fn advance(&mut self, now_ms: u64) {
        if self.closed {
            return;
        }
        self.drain_runtime_events();
        let mut due_batches = self
            .pane_data_batches
            .iter()
            .filter(|(_, batch)| batch.due_at_ms <= now_ms)
            .map(|(key, batch)| (batch.due_at_ms, key.clone()))
            .collect::<Vec<_>>();
        due_batches.sort_unstable();
        for (_, key) in due_batches {
            self.flush_pane_data_batch(&key);
        }
        if self
            .pending_sweep_due_at_ms
            .is_some_and(|due_at_ms| due_at_ms <= now_ms)
        {
            self.pending_sweep_due_at_ms = None;
            self.on_drain_at(now_ms);
        }
        self.drain_runtime_events();
    }

    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.pane_data_batches.clear();
        for job in self.screen_jobs.values_mut() {
            Self::cancel_screen_job(job, &mut self.screen_transactions_cancelled);
        }
        self.screen_jobs.clear();
        self.history_jobs.clear();
        self.pane_send_gaps.clear();
        self.stream_gap_pending_reason = None;
        self.pending_sweep_due_at_ms = None;
        let device_ids = self.devices.keys().cloned().collect::<Vec<_>>();
        for device_id in device_ids {
            self.detach_device(&device_id);
        }
        while self.runtime_events_rx.try_recv().is_ok() {}
    }

    fn ensure_ready(&mut self) {
        if self.ready_sent {
            return;
        }
        self.ready_sent = true;
        self.send(CanonicalEvent::FeedReady(CanonicalFeedReady {
            gateway_epoch: self.options.gateway_epoch,
            max_frame_bytes: self.max_frame_bytes as u32,
            max_active_panes: DEFAULT_MAX_ACTIVE_PANES,
            max_hot_panes: DEFAULT_MAX_HOT_PANES,
            max_screen_bytes: CANONICAL_MAX_SCREEN_BYTES,
            max_history_page_bytes: CANONICAL_MAX_HISTORY_PAGE_BYTES,
        }));
    }

    async fn bootstrap_initial_devices(&mut self) -> Result<(), CanonicalRuntimeError> {
        if self.bootstrapped {
            return Ok(());
        }
        self.bootstrapped = true;
        let device_ids = self
            .options
            .initial_device_ids
            .as_ref()
            .map_or_else(Vec::new, |initial| initial());
        for device_id in device_ids {
            self.attach_device(device_id, None).await?;
        }
        Ok(())
    }

    async fn ensure_device(
        &mut self,
        device_id: &str,
    ) -> Result<Option<Arc<dyn CanonicalFeedRuntime>>, CanonicalRuntimeError> {
        if let Some(device) = self.devices.get(device_id) {
            return Ok(Some(Arc::clone(&device.runtime)));
        }
        if !self.attach_device(device_id, None).await? {
            return Ok(None);
        }
        Ok(self
            .devices
            .get(device_id)
            .map(|device| Arc::clone(&device.runtime)))
    }

    async fn handle_set_pane_subscriptions(
        &mut self,
        command: SetPaneSubscriptions,
    ) -> Result<(), CanonicalRuntimeError> {
        let requested_device_ids = command
            .active_panes
            .iter()
            .chain(&command.hot_panes)
            .map(|subscription| subscription.pane.device_id.clone())
            .collect::<HashSet<_>>();
        for device_id in requested_device_ids {
            self.ensure_device(&device_id).await?;
        }

        let mut active_by_device: HashMap<String, Vec<PaneSubscriptionRequest>> = HashMap::new();
        let mut hot_by_device: HashMap<String, Vec<PaneSubscriptionRequest>> = HashMap::new();
        let mut rejected = Vec::new();
        self.collect_subscriptions(&command.active_panes, &mut active_by_device, &mut rejected);
        self.collect_subscriptions(&command.hot_panes, &mut hot_by_device, &mut rejected);

        let device_ids = self.devices.keys().cloned().collect::<Vec<_>>();
        let mut apply_results = Vec::with_capacity(device_ids.len());
        for device_id in device_ids {
            let active = active_by_device.remove(&device_id).unwrap_or_default();
            let hot = hot_by_device.remove(&device_id).unwrap_or_default();
            let device = self.devices.get_mut(&device_id).ok_or_else(|| {
                CanonicalRuntimeError::new(format!(
                    "canonical device disappeared while applying subscriptions: {device_id}"
                ))
            })?;
            let result = device
                .lease
                .apply_subscriptions(command.generation, &active, &hot)?;
            self.drain_runtime_events();
            if let Some(server_epoch) = self
                .devices
                .get(&device_id)
                .and_then(|device| device.runtime.get_server_epoch())
            {
                for item in &result.rejected {
                    rejected.push(CanonicalSubscriptionRejection {
                        pane: CanonicalPaneTarget {
                            device_id: device_id.clone(),
                            server_epoch,
                            pane_id: item.pane_id.clone(),
                        },
                        reason: rejection_reason(item.reason),
                    });
                }
            }
            apply_results.push((device_id, result));
        }

        let applied_generation = apply_results
            .iter()
            .fold(command.generation, |latest, (_, result)| {
                latest.max(result.generation)
            });
        let mut active_panes = Vec::new();
        let mut hot_panes = Vec::new();
        let mut retained_keys = HashSet::new();
        for (device_id, result) in &apply_results {
            for pane in &result.active_panes {
                retained_keys.insert(pane_key(device_id, &pane.pane_id));
            }
            for pane in &result.hot_panes {
                retained_keys.insert(pane_key(device_id, &pane.pane_id));
            }
            let Some(server_epoch) = self
                .devices
                .get(device_id)
                .and_then(|device| device.runtime.get_server_epoch())
            else {
                continue;
            };
            active_panes.extend(result.active_panes.iter().map(|pane| CanonicalPaneTarget {
                device_id: device_id.clone(),
                server_epoch,
                pane_id: pane.pane_id.clone(),
            }));
            hot_panes.extend(result.hot_panes.iter().map(|pane| CanonicalPaneTarget {
                device_id: device_id.clone(),
                server_epoch,
                pane_id: pane.pane_id.clone(),
            }));
        }

        let cancelled_keys = self
            .screen_jobs
            .keys()
            .filter(|key| !retained_keys.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        for key in cancelled_keys {
            self.cancel_screen_job_with_error(&key, "screen request subscription was removed");
        }
        self.send(CanonicalEvent::SubscriptionApplied(
            CanonicalSubscriptionApplied {
                generation: applied_generation,
                active_panes,
                hot_panes,
                rejected,
            },
        ));
        Ok(())
    }

    fn collect_subscriptions(
        &self,
        subscriptions: &[CanonicalPaneSubscription],
        destination: &mut HashMap<String, Vec<PaneSubscriptionRequest>>,
        rejected: &mut Vec<CanonicalSubscriptionRejection>,
    ) {
        for subscription in subscriptions {
            let target = &subscription.pane;
            let device = self.devices.get(&target.device_id);
            let server_epoch = device.and_then(|device| device.runtime.get_server_epoch());
            let pane = device.and_then(|device| device.runtime.get_pane_identity(&target.pane_id));
            let (Some(server_epoch), Some(pane)) = (server_epoch, pane) else {
                rejected.push(CanonicalSubscriptionRejection {
                    pane: target.clone(),
                    reason: SUBSCRIPTION_REJECTED_NOT_FOUND,
                });
                continue;
            };
            if server_epoch != target.server_epoch
                || subscription
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.pane_epoch != pane.pane_epoch)
            {
                rejected.push(CanonicalSubscriptionRejection {
                    pane: target.clone(),
                    reason: SUBSCRIPTION_REJECTED_EPOCH_CHANGED,
                });
                continue;
            }
            destination
                .entry(target.device_id.clone())
                .or_default()
                .push(PaneSubscriptionRequest {
                    pane_id: target.pane_id.clone(),
                    pane_epoch: pane.pane_epoch,
                    cursor: subscription.cursor.clone(),
                });
        }
    }

    async fn handle_terminal_input(
        &mut self,
        command: CanonicalTerminalInput,
    ) -> Result<(), CanonicalRuntimeError> {
        let Some(target) = self
            .resolve_target(&command.pane, Some(command.request_id))
            .await?
        else {
            return Ok(());
        };
        if command.pane_epoch != target.pane.pane_epoch {
            self.send_target_gap(
                &command.pane,
                command.pane_epoch,
                0,
                target.pane.pane_epoch,
                0,
            );
            return Ok(());
        }
        if self.input_ids.contains(&command.input_id) {
            return Ok(());
        }
        if let Err(error) = target
            .runtime
            .send_input_bytes(&target.pane.pane_id, &command.data)
            .await
        {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                &error.message,
                true,
            );
            return Ok(());
        }
        self.input_ids.insert(command.input_id);
        self.input_id_order.push_back(command.input_id);
        while self.input_id_order.len() > CANONICAL_MAX_INPUT_DEDUP_IDS {
            if let Some(removed) = self.input_id_order.pop_front() {
                self.input_ids.remove(&removed);
            }
        }
        Ok(())
    }

    async fn handle_terminal_key_input(
        &mut self,
        command: CanonicalTerminalKeyInput,
    ) -> Result<(), CanonicalRuntimeError> {
        let Some(target) = self
            .resolve_target(&command.pane, Some(command.request_id))
            .await?
        else {
            return Ok(());
        };
        if command.pane_epoch != target.pane.pane_epoch {
            self.send_target_gap(
                &command.pane,
                command.pane_epoch,
                0,
                target.pane.pane_epoch,
                0,
            );
            return Ok(());
        }
        if self.input_ids.contains(&command.input_id) {
            return Ok(());
        }
        if let Err(error) = target
            .runtime
            .send_key_input(
                &target.pane.pane_id,
                command.key,
                command.modifiers,
                command.action,
            )
            .await
        {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                &error.message,
                true,
            );
            return Ok(());
        }
        self.input_ids.insert(command.input_id);
        self.input_id_order.push_back(command.input_id);
        while self.input_id_order.len() > CANONICAL_MAX_INPUT_DEDUP_IDS {
            if let Some(removed) = self.input_id_order.pop_front() {
                self.input_ids.remove(&removed);
            }
        }
        Ok(())
    }

    async fn handle_resize_pane(
        &mut self,
        command: CanonicalResizePane,
    ) -> Result<(), CanonicalRuntimeError> {
        let Some(target) = self
            .resolve_target(&command.pane, Some(command.request_id))
            .await?
        else {
            return Ok(());
        };
        if command.rows < 2 || command.cols < 2 {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::InvalidFrame as u16,
                "invalid pane size",
                false,
            );
            return Ok(());
        }
        if let Err(error) = target
            .runtime
            .resize_pane(&target.pane.pane_id, command.cols, command.rows)
            .await
        {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                &error.message,
                true,
            );
        }
        Ok(())
    }

    async fn handle_request_screen(
        &mut self,
        command: CanonicalRequestScreen,
    ) -> Result<(), CanonicalRuntimeError> {
        let Some(target) = self
            .resolve_target(&command.pane, Some(command.request_id))
            .await?
        else {
            return Ok(());
        };
        if command.byte_limit < 64 {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::InvalidFrame as u16,
                "screen byte limit too small",
                false,
            );
            return Ok(());
        }
        self.start_screen_job(
            target,
            command.request_id,
            command.byte_limit.min(CANONICAL_MAX_SCREEN_BYTES),
        );
        Ok(())
    }

    async fn handle_request_history(
        &mut self,
        command: CanonicalRequestHistory,
    ) -> Result<(), CanonicalRuntimeError> {
        let Some(target) = self
            .resolve_target(&command.pane, Some(command.request_id))
            .await?
        else {
            return Ok(());
        };
        let byte_limit = command.byte_limit.min(CANONICAL_MAX_HISTORY_PAGE_BYTES);
        if byte_limit == 0 {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::InvalidFrame as u16,
                "history byte limit is zero",
                false,
            );
            return Ok(());
        }
        if self.history_jobs.contains_key(&command.request_id) {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::InvalidFrame as u16,
                "duplicate history request id",
                false,
            );
            return Ok(());
        }
        if self.history_jobs.len() >= CANONICAL_MAX_HISTORY_JOBS {
            self.send_error(
                Some(command.request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                "too many pending history requests",
                true,
            );
            return Ok(());
        }

        self.history_jobs
            .insert(command.request_id, target.device_id.clone());
        let sender = self.runtime_events_tx.clone();
        let request_poll = Arc::clone(&self.options.request_poll);
        let overflow = Arc::clone(&self.runtime_event_overflow);
        let runtime = target.runtime;
        let pane_id = target.pane.pane_id;
        let device_id = target.device_id;
        let target = target.target;
        let request_id = command.request_id;
        let before_cursor = command.before_cursor;
        (self.options.spawn_task)(Box::pin(async move {
            let result = match tokio::time::timeout(
                std::time::Duration::from_millis(CANONICAL_RUNTIME_REQUEST_DEADLINE_MS),
                AssertUnwindSafe(runtime.read_pane_history(&pane_id, before_cursor, byte_limit))
                    .catch_unwind(),
            )
            .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(CanonicalRuntimeError::new("history read task panicked")),
                Err(_) => Err(CanonicalRuntimeError::new("history read timed out")),
            };
            enqueue_runtime_event(
                &sender,
                &overflow,
                &request_poll,
                RuntimeEvent::HistoryFinished {
                    device_id,
                    target,
                    request_id,
                    result,
                },
            );
        }));
        Ok(())
    }

    fn finish_history_job(
        &mut self,
        device_id: String,
        target: CanonicalPaneTarget,
        request_id: WireToken,
        result: Result<
            Result<Option<PaneHistoryPage>, PaneHistoryCursorError>,
            CanonicalRuntimeError,
        >,
    ) {
        if self.history_jobs.get(&request_id) != Some(&device_id) {
            return;
        }
        self.history_jobs.remove(&request_id);
        if self.closed {
            return;
        }
        match result {
            Ok(Ok(Some(page))) => {
                self.send_history_transaction(&target, request_id, &page);
            }
            Ok(Ok(None)) => self.send_error(
                Some(request_id),
                ProtocolErrorCode::TmuxTargetNotFound as u16,
                "pane not found",
                false,
            ),
            Ok(Err(error)) => self.send_error(
                Some(request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                &error.message,
                true,
            ),
            Err(error) => self.send_error(
                Some(request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                &error.message,
                true,
            ),
        }
    }

    fn cancel_history_jobs_for_device(&mut self, device_id: &str, message: &str) {
        let request_ids = self
            .history_jobs
            .iter()
            .filter_map(|(request_id, pending_device_id)| {
                (pending_device_id == device_id).then_some(*request_id)
            })
            .collect::<Vec<_>>();
        for request_id in request_ids {
            self.history_jobs.remove(&request_id);
            self.send_error(
                Some(request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                message,
                true,
            );
        }
    }

    async fn resolve_target(
        &mut self,
        target: &CanonicalPaneTarget,
        request_id: Option<WireToken>,
    ) -> Result<Option<ResolvedTarget>, CanonicalRuntimeError> {
        let runtime = self.ensure_device(&target.device_id).await?;
        let server_epoch = runtime
            .as_ref()
            .and_then(|runtime| runtime.get_server_epoch());
        let pane = runtime
            .as_ref()
            .and_then(|runtime| runtime.get_pane_identity(&target.pane_id));
        let (Some(runtime), Some(server_epoch), Some(pane)) = (runtime, server_epoch, pane) else {
            self.send_error(
                request_id,
                ProtocolErrorCode::TmuxTargetNotFound as u16,
                "pane not found",
                false,
            );
            return Ok(None);
        };
        if target.server_epoch != server_epoch {
            self.send_or_queue_stream_gap(SOURCE_GAP_REASON_EPOCH_CHANGED);
            return Ok(None);
        }
        Ok(Some(ResolvedTarget {
            device_id: target.device_id.clone(),
            runtime,
            pane,
            target: CanonicalPaneTarget {
                device_id: target.device_id.clone(),
                server_epoch,
                pane_id: target.pane_id.clone(),
            },
        }))
    }

    fn start_screen_job(&mut self, target: ResolvedTarget, request_id: WireToken, byte_limit: u32) {
        let key = pane_key(&target.device_id, &target.pane.pane_id);
        if let Some(existing) = self.screen_jobs.get_mut(&key) {
            if existing.cancelled {
                self.send_error(
                    Some(request_id),
                    ProtocolErrorCode::TmuxNotReady as u16,
                    "screen capture is being cancelled",
                    true,
                );
                return;
            } else if existing.pane_epoch != target.pane.pane_epoch
                || existing.byte_limit != byte_limit
            {
                self.screen_transactions_started =
                    self.screen_transactions_started.saturating_add(1);
                self.screen_transactions_failed = self.screen_transactions_failed.saturating_add(1);
                self.send_error(
                    Some(request_id),
                    ProtocolErrorCode::TmuxNotReady as u16,
                    "incompatible screen capture is already in progress",
                    true,
                );
                return;
            } else if existing.request_ids.contains(&request_id) {
                return;
            } else if existing.request_ids.len() >= CANONICAL_MAX_SCREEN_WAITERS_PER_PANE {
                self.screen_transactions_started =
                    self.screen_transactions_started.saturating_add(1);
                self.screen_transactions_failed = self.screen_transactions_failed.saturating_add(1);
                self.send_error(
                    Some(request_id),
                    ProtocolErrorCode::TmuxNotReady as u16,
                    "too many pending screen requests",
                    true,
                );
                return;
            } else {
                existing.request_ids.push(request_id);
                self.screen_transactions_started =
                    self.screen_transactions_started.saturating_add(1);
                return;
            }
        }
        let job_id = self.next_screen_job_id;
        self.next_screen_job_id = self.next_screen_job_id.wrapping_add(1);
        self.screen_jobs.insert(
            key.clone(),
            ScreenJob {
                id: job_id,
                request_ids: vec![request_id],
                pane_epoch: target.pane.pane_epoch,
                byte_limit,
                cancelled: false,
            },
        );
        self.screen_transactions_started = self.screen_transactions_started.saturating_add(1);

        let sender = self.runtime_events_tx.clone();
        let request_poll = Arc::clone(&self.options.request_poll);
        let overflow = Arc::clone(&self.runtime_event_overflow);
        let runtime = target.runtime;
        let pane_id = target.pane.pane_id;
        let device_id = target.device_id;
        (self.options.spawn_task)(Box::pin(async move {
            let result = match tokio::time::timeout(
                std::time::Duration::from_millis(CANONICAL_RUNTIME_REQUEST_DEADLINE_MS),
                AssertUnwindSafe(runtime.capture_canonical_screen(&pane_id, byte_limit))
                    .catch_unwind(),
            )
            .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(CanonicalRuntimeError::new("screen capture task panicked")),
                Err(_) => Err(CanonicalRuntimeError::new("screen capture timed out")),
            };
            enqueue_runtime_event(
                &sender,
                &overflow,
                &request_poll,
                RuntimeEvent::ScreenFinished {
                    job_id,
                    key,
                    device_id,
                    result,
                },
            );
        }));
    }

    fn finish_screen_job(
        &mut self,
        job_id: u64,
        key: PaneKey,
        device_id: String,
        result: Result<Option<PaneScreenCheckpoint>, CanonicalRuntimeError>,
    ) {
        let Some(job) = self.screen_jobs.get(&key).cloned() else {
            return;
        };
        if job.id != job_id {
            return;
        }
        self.screen_jobs.remove(&key);
        if self.closed || job.cancelled {
            return;
        }
        let completed = match result {
            Ok(Some(checkpoint)) => {
                self.send_screen_transactions(&device_id, &job.request_ids, &checkpoint)
            }
            Ok(None) => {
                for request_id in &job.request_ids {
                    self.send_error(
                        Some(*request_id),
                        ProtocolErrorCode::TmuxNotReady as u16,
                        "screen unavailable",
                        true,
                    );
                }
                0
            }
            Err(error) => {
                for request_id in &job.request_ids {
                    self.send_error(
                        Some(*request_id),
                        ProtocolErrorCode::Internal as u16,
                        &error.message,
                        true,
                    );
                }
                0
            }
        };
        let completed = u64::try_from(completed).unwrap_or(u64::MAX);
        let requested = u64::try_from(job.request_ids.len()).unwrap_or(u64::MAX);
        self.screen_transactions_completed =
            self.screen_transactions_completed.saturating_add(completed);
        self.screen_transactions_failed = self
            .screen_transactions_failed
            .saturating_add(requested.saturating_sub(completed));
    }

    fn cancel_screen_job(job: &mut ScreenJob, cancellation_count: &mut u64) {
        if job.cancelled {
            return;
        }
        job.cancelled = true;
        *cancellation_count = cancellation_count
            .saturating_add(u64::try_from(job.request_ids.len()).unwrap_or(u64::MAX));
    }

    fn cancel_screen_job_with_error(&mut self, key: &PaneKey, message: &str) {
        let Some(mut job) = self.screen_jobs.remove(key) else {
            return;
        };
        Self::cancel_screen_job(&mut job, &mut self.screen_transactions_cancelled);
        for request_id in job.request_ids {
            self.send_error(
                Some(request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                message,
                true,
            );
        }
    }

    fn handle_pane_data(
        &mut self,
        device_id: String,
        received_at_ms: u64,
        segment: PaneDataSegment,
    ) {
        let key = pane_key(&device_id, &segment.pane_id);
        if let Some(pending) = self.pane_data_batches.get_mut(&key) {
            if pending.pane_epoch == segment.pane_epoch && pending.seq_end == segment.seq_start {
                let segment_length = segment.data.len();
                pending.chunks.push(segment.data);
                pending.length += segment_length;
                pending.seq_end = segment.seq_end;
                let should_flush = pending.length >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES;
                if should_flush {
                    self.flush_pane_data_batch(&key);
                }
                return;
            }
        }
        if self.pane_data_batches.contains_key(&key) {
            self.flush_pane_data_batch(&key);
        }
        if segment.data.len() >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES {
            self.send_pane_data(&device_id, &segment);
            return;
        }
        let length = segment.data.len();
        self.pane_data_batches.insert(
            key,
            PendingPaneDataBatch {
                device_id,
                pane_id: segment.pane_id,
                pane_epoch: segment.pane_epoch,
                seq_start: segment.seq_start,
                seq_end: segment.seq_end,
                chunks: vec![segment.data],
                length,
                due_at_ms: received_at_ms.saturating_add(GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS),
            },
        );
    }

    fn flush_pane_data_batch(&mut self, key: &PaneKey) {
        let Some(pending) = self.pane_data_batches.remove(key) else {
            return;
        };
        let data = concatenate_chunks(pending.chunks, pending.length);
        self.send_pane_data(
            &pending.device_id,
            &PaneDataSegment {
                pane_id: pending.pane_id,
                pane_epoch: pending.pane_epoch,
                seq_start: pending.seq_start,
                seq_end: pending.seq_end,
                data,
            },
        );
    }

    fn flush_pane_data_batches_for_device(&mut self, device_id: &str) {
        let keys = self
            .pane_data_batches
            .keys()
            .filter(|(batch_device_id, _)| batch_device_id == device_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.flush_pane_data_batch(&key);
        }
    }

    fn handle_pane_gap(&mut self, device_id: &str, gap: &PaneReplayGap) {
        self.flush_pane_data_batch(&pane_key(device_id, &gap.pane_id));
        self.send_pane_gap(device_id, gap);
    }

    fn send_pane_data(&mut self, device_id: &str, segment: &PaneDataSegment) -> bool {
        let Some(server_epoch) = self
            .devices
            .get(device_id)
            .and_then(|device| device.runtime.get_server_epoch())
        else {
            self.record_pane_data_drop(segment.data.len());
            return false;
        };
        let key = pane_key(device_id, &segment.pane_id);
        let target = CanonicalPaneTarget {
            device_id: device_id.to_owned(),
            server_epoch,
            pane_id: segment.pane_id.clone(),
        };
        let max_data_bytes = self.max_pane_data_bytes(&target, segment.pane_epoch);
        if max_data_bytes == 0 {
            self.record_pane_data_drop(segment.data.len());
            return false;
        }
        let mut offset = 0;
        while offset < segment.data.len() {
            let end = (offset + max_data_bytes).min(segment.data.len());
            let data = segment.data[offset..end].to_vec();
            let Some(seq_start) = segment.seq_start.checked_add(offset as u64) else {
                self.record_pane_data_drop(segment.data.len() - offset);
                return false;
            };
            let Some(seq_end) = seq_start.checked_add(data.len() as u64) else {
                self.record_pane_data_drop(segment.data.len() - offset);
                return false;
            };
            let event = CanonicalEvent::PaneData(CanonicalPaneData {
                pane: target.clone(),
                pane_epoch: segment.pane_epoch,
                seq_start,
                seq_end,
                data,
            });
            if !self.send(event) {
                self.record_pane_data_drop(segment.data.len() - offset);
                self.queue_pane_gap(
                    key.clone(),
                    PaneReplayGap {
                        pane_id: segment.pane_id.clone(),
                        pane_epoch: segment.pane_epoch,
                        reason: PaneReplayGapReason::PaneGap,
                        expected_pane_epoch: segment.pane_epoch,
                        expected_seq: seq_start,
                        available_seq: segment.seq_end,
                    },
                );
                return false;
            }
            self.pane_data_deliveries += 1;
            self.pane_data_bytes += (end - offset) as u64;
            offset = end;
        }
        true
    }

    fn send_pane_gap(&mut self, device_id: &str, gap: &PaneReplayGap) -> bool {
        let Some(server_epoch) = self
            .devices
            .get(device_id)
            .and_then(|device| device.runtime.get_server_epoch())
        else {
            return false;
        };
        let sent = self.send(CanonicalEvent::SourceGap(CanonicalSourceGap {
            reason: source_gap_reason(gap.reason),
            scope: CanonicalGapScope::Pane(CanonicalPaneGap {
                pane: CanonicalPaneTarget {
                    device_id: device_id.to_owned(),
                    server_epoch,
                    pane_id: gap.pane_id.clone(),
                },
                expected_pane_epoch: gap.expected_pane_epoch,
                available_pane_epoch: gap.pane_epoch,
                expected_seq: gap.expected_seq,
                available_seq: gap.available_seq,
            }),
        }));
        if sent {
            self.pane_gaps_sent += 1;
            self.increment_pane_gap_reason(gap.reason);
        }
        sent
    }

    fn send_target_gap(
        &mut self,
        target: &CanonicalPaneTarget,
        expected_pane_epoch: WireToken,
        expected_seq: u64,
        available_pane_epoch: WireToken,
        available_seq: u64,
    ) {
        self.flush_pane_data_batch(&pane_key(&target.device_id, &target.pane_id));
        let sent = self.send(CanonicalEvent::SourceGap(CanonicalSourceGap {
            reason: SOURCE_GAP_REASON_EPOCH_CHANGED,
            scope: CanonicalGapScope::Pane(CanonicalPaneGap {
                pane: target.clone(),
                expected_pane_epoch,
                available_pane_epoch,
                expected_seq,
                available_seq,
            }),
        }));
        if sent {
            self.pane_gaps_sent += 1;
            self.pane_gaps_by_reason.epoch_changed += 1;
        }
    }

    fn send_stream_gap(&mut self, reason: u8) -> bool {
        let sent = self.send(CanonicalEvent::SourceGap(CanonicalSourceGap {
            reason,
            scope: CanonicalGapScope::Stream,
        }));
        if sent {
            self.stream_gaps_sent += 1;
        }
        sent
    }

    fn send_or_queue_stream_gap(&mut self, reason: u8) {
        if !self.send_stream_gap(reason) {
            self.stream_gap_pending_reason = Some(reason);
        }
    }

    fn queue_pane_gap(&mut self, key: PaneKey, gap: PaneReplayGap) {
        if self.stream_gap_pending_reason.is_some() || self.pane_send_gaps.contains_key(&key) {
            if self.stream_gap_pending_reason.is_none() {
                self.pane_send_gaps.insert(key, gap);
            }
            return;
        }
        if self.pane_send_gaps.len() < self.max_pending_pane_gaps {
            self.pane_send_gaps.insert(key, gap);
            return;
        }
        self.pending_pane_gap_overflows += 1;
        self.pane_send_gaps.clear();
        self.stream_gap_pending_reason = Some(SOURCE_GAP_REASON_PANE_GAP);
    }

    fn record_pane_data_drop(&mut self, bytes: usize) {
        self.pane_data_drops += 1;
        self.pane_data_drop_bytes = self.pane_data_drop_bytes.saturating_add(bytes as u64);
    }

    fn increment_pane_gap_reason(&mut self, reason: PaneReplayGapReason) {
        match reason {
            PaneReplayGapReason::PaneGap => self.pane_gaps_by_reason.pane_gap += 1,
            PaneReplayGapReason::EpochChanged => self.pane_gaps_by_reason.epoch_changed += 1,
            PaneReplayGapReason::CacheEvicted => self.pane_gaps_by_reason.cache_evicted += 1,
        }
    }

    fn split_pane_data_batch_at_base(
        &mut self,
        key: &PaneKey,
        pane_epoch: WireToken,
        base_seq: u64,
    ) -> Option<PaneDataSegment> {
        let pending = self.pane_data_batches.remove(key)?;
        if pending.pane_epoch != pane_epoch {
            self.send_pane_data(
                &pending.device_id,
                &PaneDataSegment {
                    pane_id: pending.pane_id,
                    pane_epoch: pending.pane_epoch,
                    seq_start: pending.seq_start,
                    seq_end: pending.seq_end,
                    data: concatenate_chunks(pending.chunks, pending.length),
                },
            );
            return None;
        }
        if pending.seq_end <= base_seq {
            return None;
        }
        let mut data = concatenate_chunks(pending.chunks, pending.length);
        let mut seq_start = pending.seq_start;
        if seq_start < base_seq {
            let offset = (base_seq - seq_start) as usize;
            data = data.get(offset..).unwrap_or_default().to_vec();
            seq_start = base_seq;
        }
        if data.is_empty() {
            return None;
        }
        Some(PaneDataSegment {
            pane_id: pending.pane_id,
            pane_epoch: pending.pane_epoch,
            seq_start,
            seq_end: pending.seq_end,
            data,
        })
    }

    fn send_screen_transactions(
        &mut self,
        device_id: &str,
        request_ids: &[WireToken],
        checkpoint: &PaneScreenCheckpoint,
    ) -> usize {
        let Some(server_epoch) = self
            .devices
            .get(device_id)
            .and_then(|device| device.runtime.get_server_epoch())
        else {
            return 0;
        };
        let estimated_transaction_bytes = checkpoint.data.len().saturating_add(8 * 1024);
        let admitted = if estimated_transaction_bytes == 0 {
            request_ids.len()
        } else {
            (CANONICAL_MAX_SCREEN_FANOUT_BYTES / estimated_transaction_bytes)
                .max(1)
                .min(request_ids.len())
        };
        for request_id in &request_ids[admitted..] {
            self.send_error(
                Some(*request_id),
                ProtocolErrorCode::TmuxNotReady as u16,
                "screen fanout exceeds the outbound byte budget",
                true,
            );
        }
        let request_ids = &request_ids[..admitted];
        let held_live = self.split_pane_data_batch_at_base(
            &pane_key(device_id, &checkpoint.pane_id),
            checkpoint.pane_epoch,
            checkpoint.base_seq,
        );
        let mut completed = 0usize;
        for request_id in request_ids {
            if !self.send(CanonicalEvent::ScreenBegin(CanonicalScreenBegin {
                request_id: *request_id,
                pane: CanonicalPaneTarget {
                    device_id: device_id.to_owned(),
                    server_epoch,
                    pane_id: checkpoint.pane_id.clone(),
                },
                pane_epoch: checkpoint.pane_epoch,
                base_seq: checkpoint.base_seq,
                rows: checkpoint.rows,
                cols: checkpoint.cols,
                modes: checkpoint.modes,
                total_bytes: checkpoint.data.len() as u32,
            })) || !self.send_content_chunks(ContentKind::Screen, *request_id, &checkpoint.data)
                || !self.send(CanonicalEvent::ScreenCommit(CanonicalScreenCommit {
                    request_id: *request_id,
                    total_bytes: checkpoint.data.len() as u32,
                    history_cursor: checkpoint.history_cursor.clone(),
                }))
            {
                break;
            }
            completed += 1;
        }
        if completed == request_ids.len() {
            if let Some(held_live) = held_live {
                self.send_pane_data(device_id, &held_live);
            }
        } else if let Some(held_live) = held_live {
            self.queue_pane_gap(
                pane_key(device_id, &checkpoint.pane_id),
                PaneReplayGap {
                    pane_id: checkpoint.pane_id.clone(),
                    pane_epoch: checkpoint.pane_epoch,
                    reason: PaneReplayGapReason::PaneGap,
                    expected_pane_epoch: checkpoint.pane_epoch,
                    expected_seq: checkpoint.base_seq,
                    available_seq: held_live.seq_end,
                },
            );
        }
        completed
    }

    fn send_history_transaction(
        &mut self,
        target: &CanonicalPaneTarget,
        request_id: WireToken,
        page: &PaneHistoryPage,
    ) -> bool {
        self.flush_pane_data_batch(&pane_key(&target.device_id, &target.pane_id));
        if !self.send(CanonicalEvent::HistoryBegin(CanonicalHistoryBegin {
            request_id,
            pane: target.clone(),
            pane_epoch: page.pane_epoch,
            history_epoch: page.history_epoch,
            line_start: page.line_start,
            line_end: page.line_end,
            truncated: page.truncated,
            total_bytes: page.data.len() as u32,
        })) {
            return false;
        }
        if !self.send_content_chunks(ContentKind::History, request_id, &page.data) {
            return false;
        }
        self.send(CanonicalEvent::HistoryCommit(CanonicalHistoryCommit {
            request_id,
            total_bytes: page.data.len() as u32,
            next_cursor: page.next_cursor.clone(),
        }))
    }

    fn send_content_chunks(
        &mut self,
        kind: ContentKind,
        request_id: WireToken,
        data: &[u8],
    ) -> bool {
        let max_data_bytes = self.max_content_chunk_bytes(kind, request_id);
        if max_data_bytes == 0 {
            return false;
        }
        for offset in (0..data.len()).step_by(max_data_bytes) {
            let chunk = CanonicalContentChunk {
                request_id,
                offset: offset as u32,
                data: data[offset..(offset + max_data_bytes).min(data.len())].to_vec(),
            };
            let event = match kind {
                ContentKind::Screen => CanonicalEvent::ScreenChunk(chunk),
                ContentKind::History => CanonicalEvent::HistoryChunk(chunk),
            };
            if !self.send(event) {
                return false;
            }
        }
        true
    }

    fn send_metadata_snapshot(&mut self, device_id: &str) -> bool {
        let Some(runtime) = self
            .devices
            .get(device_id)
            .map(|device| Arc::clone(&device.runtime))
        else {
            return false;
        };
        let snapshot = runtime.get_metadata_snapshot();
        let snapshot_id = (self.options.create_snapshot_id)();
        let Some(chunks) = self.partition_metadata_records(&snapshot, snapshot_id) else {
            return false;
        };
        let Ok(total_chunks) = u16::try_from(chunks.len()) else {
            self.send_error(
                None,
                ProtocolErrorCode::FrameTooLarge as u16,
                "metadata snapshot has too many chunks",
                false,
            );
            return false;
        };
        let mut sent = true;
        for (index, records) in chunks.into_iter().enumerate() {
            sent = self.send(CanonicalEvent::SourceMetadataSnapshot(
                SourceMetadataSnapshot {
                    metadata_epoch: snapshot.metadata_epoch,
                    revision: snapshot.revision,
                    snapshot_id,
                    chunk_index: index as u16,
                    total_chunks,
                    records,
                },
            )) && sent;
            if !sent {
                break;
            }
        }
        if let Some(device) = self.devices.get_mut(device_id) {
            device.metadata_needs_rebase = !sent;
        }
        sent
    }

    fn partition_metadata_records(
        &mut self,
        snapshot: &MetadataProjectionSnapshot,
        snapshot_id: WireToken,
    ) -> Option<Vec<Vec<SourceMetadataRecord>>> {
        if snapshot.records.is_empty() {
            return Some(vec![Vec::new()]);
        }
        let mut chunks = Vec::new();
        let mut current = Vec::new();
        for record in &snapshot.records {
            let mut candidate = current.clone();
            candidate.push(record.clone());
            if self.event_fits(&CanonicalEvent::SourceMetadataSnapshot(
                SourceMetadataSnapshot {
                    metadata_epoch: snapshot.metadata_epoch,
                    revision: snapshot.revision,
                    snapshot_id,
                    chunk_index: u16::MAX,
                    total_chunks: u16::MAX,
                    records: candidate.clone(),
                },
            )) {
                current = candidate;
                continue;
            }
            if current.is_empty() {
                self.send_error(
                    None,
                    ProtocolErrorCode::FrameTooLarge as u16,
                    "metadata record exceeds frame limit",
                    false,
                );
                return None;
            }
            chunks.push(current);
            current = vec![record.clone()];
            if !self.event_fits(&CanonicalEvent::SourceMetadataSnapshot(
                SourceMetadataSnapshot {
                    metadata_epoch: snapshot.metadata_epoch,
                    revision: snapshot.revision,
                    snapshot_id,
                    chunk_index: u16::MAX,
                    total_chunks: u16::MAX,
                    records: current.clone(),
                },
            )) {
                self.send_error(
                    None,
                    ProtocolErrorCode::FrameTooLarge as u16,
                    "metadata record exceeds frame limit",
                    false,
                );
                return None;
            }
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        Some(chunks)
    }

    fn max_pane_data_bytes(&self, target: &CanonicalPaneTarget, pane_epoch: WireToken) -> usize {
        self.max_variable_data_bytes(|data| {
            CanonicalEvent::PaneData(CanonicalPaneData {
                pane: target.clone(),
                pane_epoch,
                seq_start: 0,
                seq_end: data.len() as u64,
                data,
            })
        })
    }

    fn max_content_chunk_bytes(&self, kind: ContentKind, request_id: WireToken) -> usize {
        self.max_variable_data_bytes(|data| {
            let chunk = CanonicalContentChunk {
                request_id,
                offset: 0,
                data,
            };
            match kind {
                ContentKind::Screen => CanonicalEvent::ScreenChunk(chunk),
                ContentKind::History => CanonicalEvent::HistoryChunk(chunk),
            }
        })
    }

    fn max_variable_data_bytes(&self, build: impl Fn(Vec<u8>) -> CanonicalEvent) -> usize {
        let mut low = 0;
        let mut high = self.max_frame_bytes;
        while low < high {
            let middle = (low + high).div_ceil(2);
            if self.event_fits(&build(vec![0; middle])) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        low
    }

    fn event_fits(&self, event: &CanonicalEvent) -> bool {
        encode_canonical_event(event.clone()).is_ok_and(|payload| {
            payload.len() + WS_ENVELOPE_WIRE_OVERHEAD_BYTES <= self.max_frame_bytes
        })
    }

    fn send(&self, event: CanonicalEvent) -> bool {
        if self.closed || !self.event_fits(&event) {
            return false;
        }
        (self.options.send_event)(event)
    }

    fn send_error(&self, request_id: Option<WireToken>, code: u16, message: &str, retryable: bool) {
        self.send(CanonicalEvent::Error(CanonicalError {
            request_id,
            code,
            message: message.chars().take(512).collect(),
            retryable,
        }));
    }

    fn drain_runtime_events(&mut self) {
        let overflowed_before_poll = self.runtime_event_overflow.take_pending();
        let mut processed = 0;
        for _ in 0..CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY {
            match self.runtime_events_rx.try_recv() {
                Ok(event) if !self.closed && !overflowed_before_poll => {
                    processed += 1;
                    self.handle_runtime_event(event);
                }
                Ok(_) => processed += 1,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        if processed == CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY {
            (self.options.request_poll)();
        }
        let overflowed_during_poll = self.runtime_event_overflow.take_pending();
        if !self.closed && (overflowed_before_poll || overflowed_during_poll) {
            self.handle_runtime_event_overflow();
        }
    }

    fn handle_runtime_event_overflow(&mut self) {
        self.pane_data_batches.clear();
        self.pane_send_gaps.clear();
        let screen_keys = self.screen_jobs.keys().cloned().collect::<Vec<_>>();
        for key in screen_keys {
            self.cancel_screen_job_with_error(&key, "screen runtime event queue overflowed");
        }
        let history_device_ids = self.history_jobs.values().cloned().collect::<HashSet<_>>();
        for device_id in history_device_ids {
            self.cancel_history_jobs_for_device(
                &device_id,
                "history runtime event queue overflowed",
            );
        }

        let device_ids = self.devices.keys().cloned().collect::<Vec<_>>();
        for device in self.devices.values_mut() {
            device.metadata_needs_rebase = true;
        }
        if !self.send_stream_gap(SOURCE_GAP_REASON_RESOURCE_EXHAUSTED) {
            self.stream_gap_pending_reason = Some(SOURCE_GAP_REASON_RESOURCE_EXHAUSTED);
            self.schedule_pending_sweep((self.options.now_ms)());
            return;
        }
        self.stream_gap_pending_reason = None;
        for device_id in device_ids {
            self.send_metadata_snapshot(&device_id);
        }
        self.schedule_pending_sweep((self.options.now_ms)());
    }

    fn handle_runtime_event(&mut self, event: RuntimeEvent) {
        match event {
            RuntimeEvent::PaneData {
                device_id,
                received_at_ms,
                segment,
            } => self.handle_pane_data(device_id, received_at_ms, segment),
            RuntimeEvent::PaneGap { device_id, gap } => self.handle_pane_gap(&device_id, &gap),
            RuntimeEvent::MetadataPatch { device_id, patch } => {
                if !self.devices.contains_key(&device_id) {
                    return;
                }
                if !self.event_fits(&CanonicalEvent::SourceMetadataPatch(patch.clone())) {
                    if let Some(device) = self.devices.get_mut(&device_id) {
                        device.metadata_needs_rebase = true;
                    }
                    self.send_metadata_snapshot(&device_id);
                    return;
                }
                if !self.send(CanonicalEvent::SourceMetadataPatch(patch)) {
                    if let Some(device) = self.devices.get_mut(&device_id) {
                        device.metadata_needs_rebase = true;
                    }
                }
            }
            RuntimeEvent::MetadataRebaseRequired { device_id } => {
                if let Some(device) = self.devices.get_mut(&device_id) {
                    device.metadata_needs_rebase = true;
                    self.send_metadata_snapshot(&device_id);
                }
            }
            RuntimeEvent::RuntimeClosed { device_id } => {
                if let Some(device) = self.devices.get_mut(&device_id) {
                    device.metadata_needs_rebase = true;
                    self.send_or_queue_stream_gap(SOURCE_GAP_REASON_EPOCH_CHANGED);
                }
                let screen_keys = self
                    .screen_jobs
                    .keys()
                    .filter(|(pending_device_id, _)| pending_device_id == &device_id)
                    .cloned()
                    .collect::<Vec<_>>();
                for key in screen_keys {
                    self.cancel_screen_job_with_error(&key, "screen runtime was closed");
                }
                self.cancel_history_jobs_for_device(&device_id, "history runtime was closed");
            }
            RuntimeEvent::ScreenFinished {
                job_id,
                key,
                device_id,
                result,
            } => self.finish_screen_job(job_id, key, device_id, result),
            RuntimeEvent::HistoryFinished {
                device_id,
                target,
                request_id,
                result,
            } => self.finish_history_job(device_id, target, request_id, result),
        }
    }

    fn on_drain_at(&mut self, now_ms: u64) {
        if self.closed {
            return;
        }
        if let Some(reason) = self.stream_gap_pending_reason {
            if !self.send_stream_gap(reason) {
                return;
            }
            self.stream_gap_pending_reason = None;
            self.pane_send_gaps.clear();
        }
        let metadata_device_ids = self
            .devices
            .iter()
            .filter(|(_, device)| device.metadata_needs_rebase)
            .map(|(device_id, _)| device_id.clone())
            .collect::<Vec<_>>();
        for device_id in metadata_device_ids {
            self.send_metadata_snapshot(&device_id);
        }
        let pane_gaps = self
            .pane_send_gaps
            .iter()
            .map(|(key, gap)| (key.clone(), gap.clone()))
            .collect::<Vec<_>>();
        for (key, gap) in pane_gaps {
            if self.send_pane_gap(&key.0, &gap) {
                self.pane_send_gaps.remove(&key);
            }
        }
        self.schedule_pending_sweep(now_ms);
    }

    fn schedule_pending_sweep(&mut self, now_ms: u64) {
        if self.closed || self.pending_sweep_due_at_ms.is_some() {
            return;
        }
        let metadata_pending = self
            .devices
            .values()
            .any(|device| device.metadata_needs_rebase);
        if self.stream_gap_pending_reason.is_none()
            && self.pane_send_gaps.is_empty()
            && !metadata_pending
        {
            return;
        }
        self.pending_sweep_due_at_ms = Some(now_ms.saturating_add(CANONICAL_PENDING_SWEEP_MS));
    }
}

#[derive(Clone, Copy)]
enum ContentKind {
    Screen,
    History,
}

fn pane_key(device_id: &str, pane_id: &str) -> PaneKey {
    (device_id.to_owned(), pane_id.to_owned())
}

fn canonical_command_request_id(command: &CanonicalCommand) -> Option<WireToken> {
    match command {
        CanonicalCommand::SetPaneSubscriptions(_) => None,
        CanonicalCommand::TerminalInput(command) => Some(command.request_id),
        CanonicalCommand::ResizePane(command) => Some(command.request_id),
        CanonicalCommand::RequestScreen(command) => Some(command.request_id),
        CanonicalCommand::RequestHistory(command) => Some(command.request_id),
        CanonicalCommand::TerminalKeyInput(command) => Some(command.request_id),
    }
}

fn enqueue_runtime_event(
    sender: &SyncSender<RuntimeEvent>,
    overflow: &RuntimeEventOverflow,
    request_poll: &CanonicalPollRequester,
    event: RuntimeEvent,
) {
    match sender.try_send(event) {
        Ok(()) => request_poll(),
        Err(TrySendError::Full(_)) => {
            overflow.record();
            request_poll();
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn source_gap_reason(reason: PaneReplayGapReason) -> u8 {
    match reason {
        PaneReplayGapReason::PaneGap => SOURCE_GAP_REASON_PANE_GAP,
        PaneReplayGapReason::EpochChanged => SOURCE_GAP_REASON_EPOCH_CHANGED,
        PaneReplayGapReason::CacheEvicted => SOURCE_GAP_REASON_CACHE_EVICTED,
    }
}

fn rejection_reason(reason: PaneSubscriptionRejectionReason) -> u8 {
    match reason {
        PaneSubscriptionRejectionReason::NotFound => SUBSCRIPTION_REJECTED_NOT_FOUND,
        PaneSubscriptionRejectionReason::ResourceExhausted => {
            SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED
        }
        PaneSubscriptionRejectionReason::EpochChanged => SUBSCRIPTION_REJECTED_EPOCH_CHANGED,
    }
}

fn concatenate_chunks(chunks: Vec<Vec<u8>>, length: usize) -> Vec<u8> {
    if chunks.len() == 1 {
        return chunks.into_iter().next().unwrap_or_default();
    }
    let mut data = Vec::with_capacity(length);
    for chunk in chunks {
        data.extend(chunk);
    }
    data
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};

    use tmex_protocol::{
        encode_canonical_event, CanonicalCommand, CanonicalHistoryCursor,
        CanonicalPaneSubscription, CanonicalPaneTarget, CanonicalRequestHistory,
        CanonicalRequestScreen, CanonicalTerminalInput, SetPaneSubscriptions, SourceEntityKey,
        SourceMetadataField, SourceMetadataRecord, SourceMetadataValue, SOURCE_ENTITY_PANE,
        SOURCE_FIELD_PANE_EPOCH, SOURCE_FIELD_TITLE,
    };
    use tokio::sync::Semaphore;

    use super::super::runtime::{
        PaneHistoryCursorError, PaneRetentionConsumer, PaneSubscriptionApplyResult,
    };
    use super::*;

    const SERVER_EPOCH: WireToken = [0x11; 16];
    const PANE_EPOCH: WireToken = [0x22; 16];
    const REQUEST_ID: WireToken = [0x33; 16];

    #[derive(Default)]
    struct FakeState {
        callbacks: Option<PaneRetentionConsumerCallbacks>,
        listener: Option<CanonicalFeedRuntimeListener>,
        input: Vec<(String, Vec<u8>)>,
        key_input: Vec<(String, TerminalKey, u16, TerminalKeyAction)>,
        input_failures_remaining: usize,
        resizes: Vec<(String, u16, u16)>,
        screen_data: Vec<u8>,
        screen_capture_gate: Option<Arc<Semaphore>>,
        screen_capture_count: usize,
        base_seq_override: Option<u64>,
        latest_seq: u64,
        generation: Option<u64>,
        active: Vec<PaneIdentity>,
        hot: Vec<PaneIdentity>,
        history_page: Option<PaneHistoryPage>,
        history_gate: Option<Arc<Semaphore>>,
        history_error: Option<String>,
        metadata_records: Option<Vec<SourceMetadataRecord>>,
        lease_closes: u64,
        listener_detaches: u64,
    }

    struct FakeRuntime {
        device_id: String,
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeRuntime {
        fn new(device_id: &str) -> Self {
            Self {
                device_id: device_id.to_owned(),
                state: Arc::new(Mutex::new(FakeState {
                    screen_data: b"screen".to_vec(),
                    ..FakeState::default()
                })),
            }
        }

        fn state(&self) -> MutexGuard<'_, FakeState> {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        }

        fn output(&self, data: &[u8]) {
            let (callbacks, segment) = {
                let mut state = self.state();
                let seq_start = state.latest_seq;
                state.latest_seq += data.len() as u64;
                let subscribed = state
                    .active
                    .iter()
                    .chain(&state.hot)
                    .any(|pane| pane.pane_id == "%1");
                (
                    subscribed.then(|| state.callbacks.clone()).flatten(),
                    PaneDataSegment {
                        pane_id: "%1".to_owned(),
                        pane_epoch: PANE_EPOCH,
                        seq_start,
                        seq_end: state.latest_seq,
                        data: data.to_vec(),
                    },
                )
            };
            if let Some(callbacks) = callbacks {
                (callbacks.on_data)(segment);
            }
        }

        fn metadata_records(&self) -> Vec<SourceMetadataRecord> {
            self.state()
                .metadata_records
                .clone()
                .unwrap_or_else(|| vec![metadata_record(&self.device_id, "%1", "shell")])
        }

        fn close(&self) {
            let listener = self.state().listener.clone();
            if let Some(listener) = listener {
                (listener.on_close)();
            }
        }
    }

    struct FakeLease {
        state: Arc<Mutex<FakeState>>,
    }

    impl PaneRetentionConsumer for FakeLease {
        fn apply_subscriptions(
            &mut self,
            generation: u64,
            active_panes: &[PaneSubscriptionRequest],
            hot_panes: &[PaneSubscriptionRequest],
        ) -> Result<PaneSubscriptionApplyResult, CanonicalRuntimeError> {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state
                .generation
                .is_some_and(|current_generation| generation < current_generation)
            {
                return Ok(PaneSubscriptionApplyResult {
                    generation: state.generation.expect("generation exists"),
                    active_panes: state.active.clone(),
                    hot_panes: state.hot.clone(),
                    rejected: Vec::new(),
                    replay: Vec::new(),
                });
            }
            state.generation = Some(generation);
            state.active = active_panes.iter().map(request_identity).collect();
            state.hot = hot_panes.iter().map(request_identity).collect();
            Ok(PaneSubscriptionApplyResult {
                generation,
                active_panes: state.active.clone(),
                hot_panes: state.hot.clone(),
                rejected: Vec::new(),
                replay: Vec::new(),
            })
        }

        fn close(&mut self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.callbacks = None;
            state.lease_closes += 1;
        }
    }

    impl CanonicalFeedRuntime for FakeRuntime {
        fn get_server_epoch(&self) -> Option<WireToken> {
            Some(SERVER_EPOCH)
        }

        fn get_metadata_snapshot(&self) -> MetadataProjectionSnapshot {
            MetadataProjectionSnapshot {
                metadata_epoch: [0x44; 16],
                revision: 1,
                records: self.metadata_records(),
            }
        }

        fn get_pane_identity(&self, pane_id: &str) -> Option<PaneIdentity> {
            (pane_id == "%1").then(|| PaneIdentity {
                pane_id: pane_id.to_owned(),
                pane_epoch: PANE_EPOCH,
            })
        }

        fn attach_pane_consumer(
            &self,
            callbacks: PaneRetentionConsumerCallbacks,
        ) -> Result<PaneRetentionLease, CanonicalRuntimeError> {
            self.state().callbacks = Some(callbacks);
            Ok(PaneRetentionLease::new(FakeLease {
                state: Arc::clone(&self.state),
            }))
        }

        fn subscribe(
            &self,
            listener: CanonicalFeedRuntimeListener,
        ) -> Result<CanonicalDetachHandle, CanonicalRuntimeError> {
            self.state().listener = Some(listener);
            let state = Arc::clone(&self.state);
            Ok(CanonicalDetachHandle::new(move || {
                let mut state = state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.listener = None;
                state.listener_detaches += 1;
            }))
        }

        fn read_pane_history<'a>(
            &'a self,
            _pane_id: &'a str,
            _before_cursor: Option<CanonicalHistoryCursor>,
            _byte_limit: u32,
        ) -> RuntimeFuture<
            'a,
            Result<Result<Option<PaneHistoryPage>, PaneHistoryCursorError>, CanonicalRuntimeError>,
        > {
            let state = self.state();
            let page = state.history_page.clone();
            let gate = state.history_gate.clone();
            let error = state.history_error.clone();
            drop(state);
            Box::pin(async move {
                if let Some(gate) = gate {
                    let permit = gate
                        .acquire()
                        .await
                        .map_err(|_| CanonicalRuntimeError::new("history read cancelled"))?;
                    permit.forget();
                }
                if let Some(error) = error {
                    return Err(CanonicalRuntimeError::new(error));
                }
                Ok(Ok(page))
            })
        }

        fn capture_canonical_screen<'a>(
            &'a self,
            pane_id: &'a str,
            byte_limit: u32,
        ) -> RuntimeFuture<'a, Result<Option<PaneScreenCheckpoint>, CanonicalRuntimeError>>
        {
            let mut state = self.state();
            state.screen_capture_count += 1;
            let gate = state.screen_capture_gate.clone();
            let checkpoint = (pane_id == "%1").then(|| PaneScreenCheckpoint {
                pane_id: pane_id.to_owned(),
                pane_epoch: PANE_EPOCH,
                base_seq: state.base_seq_override.unwrap_or(state.latest_seq),
                rows: 24,
                cols: 80,
                modes: 0,
                data: state.screen_data[..state.screen_data.len().min(byte_limit as usize)]
                    .to_vec(),
                history_cursor: None,
                captured_at_ms: 0,
            });
            drop(state);
            Box::pin(async move {
                if let Some(gate) = gate {
                    let permit = gate
                        .acquire()
                        .await
                        .map_err(|_| CanonicalRuntimeError::new("screen capture cancelled"))?;
                    permit.forget();
                }
                Ok(checkpoint)
            })
        }

        fn send_input_bytes<'a>(
            &'a self,
            pane_id: &'a str,
            data: &'a [u8],
        ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
            let state = Arc::clone(&self.state);
            let pane_id = pane_id.to_owned();
            let data = data.to_vec();
            Box::pin(async move {
                let mut state = state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.input_failures_remaining > 0 {
                    state.input_failures_remaining -= 1;
                    return Err(CanonicalRuntimeError::new("input queue unavailable"));
                }
                state.input.push((pane_id, data));
                Ok(())
            })
        }

        fn send_key_input<'a>(
            &'a self,
            pane_id: &'a str,
            key: TerminalKey,
            modifiers: u16,
            action: TerminalKeyAction,
        ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
            let state = Arc::clone(&self.state);
            let pane_id = pane_id.to_owned();
            Box::pin(async move {
                let mut state = state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.input_failures_remaining > 0 {
                    state.input_failures_remaining -= 1;
                    return Err(CanonicalRuntimeError::new("input queue unavailable"));
                }
                state.key_input.push((pane_id, key, modifiers, action));
                Ok(())
            })
        }

        fn resize_pane<'a>(
            &'a self,
            pane_id: &'a str,
            cols: u16,
            rows: u16,
        ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
            let state = Arc::clone(&self.state);
            let pane_id = pane_id.to_owned();
            Box::pin(async move {
                state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .resizes
                    .push((pane_id, cols, rows));
                Ok(())
            })
        }
    }

    struct Harness {
        session: CanonicalFeedSession,
        events: Arc<Mutex<Vec<CanonicalEvent>>>,
        now_ms: Arc<AtomicU64>,
        poll_requests: Arc<AtomicU64>,
    }

    impl Harness {
        fn new(
            runtimes: HashMap<String, Arc<FakeRuntime>>,
            max_frame_bytes: usize,
            max_pending_pane_gaps: Option<usize>,
            initial_device_ids: Vec<String>,
            reject_pane_data: bool,
        ) -> Self {
            let runtimes = Arc::new(runtimes);
            let resolver_runtimes = Arc::clone(&runtimes);
            let events = Arc::new(Mutex::new(Vec::new()));
            let sent_events = Arc::clone(&events);
            let now_ms = Arc::new(AtomicU64::new(0));
            let clock = Arc::clone(&now_ms);
            let poll_requests = Arc::new(AtomicU64::new(0));
            let requested_polls = Arc::clone(&poll_requests);
            let session = CanonicalFeedSession::new(CanonicalFeedSessionOptions {
                max_frame_bytes,
                gateway_epoch: [0x77; 16],
                send_event: Arc::new(move |event| {
                    if reject_pane_data && matches!(event, CanonicalEvent::PaneData(_)) {
                        return false;
                    }
                    sent_events
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(event);
                    true
                }),
                resolve_runtime: Arc::new(move |device_id| {
                    let runtime = resolver_runtimes.get(&device_id).cloned();
                    Box::pin(async move {
                        Ok(runtime.map(|runtime| runtime as Arc<dyn CanonicalFeedRuntime>))
                    })
                }),
                spawn_task: Arc::new(|task| {
                    tokio::spawn(task);
                }),
                request_poll: Arc::new(move || {
                    requested_polls.fetch_add(1, Ordering::SeqCst);
                }),
                now_ms: Arc::new(move || clock.load(Ordering::SeqCst)),
                create_snapshot_id: Arc::new(|| [0x55; 16]),
                initial_device_ids: Some(Arc::new(move || initial_device_ids.clone())),
                on_device_attached: None,
                on_device_detached: None,
                max_pending_pane_gaps,
            })
            .expect("valid options");
            Self {
                session,
                events,
                now_ms,
                poll_requests,
            }
        }

        fn events(&self) -> Vec<CanonicalEvent> {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        async fn poll_tasks(&mut self) {
            for _ in 0..3 {
                tokio::task::yield_now().await;
                self.session.advance(self.now_ms.load(Ordering::SeqCst));
            }
        }
    }

    fn request_identity(request: &PaneSubscriptionRequest) -> PaneIdentity {
        PaneIdentity {
            pane_id: request.pane_id.clone(),
            pane_epoch: request.pane_epoch,
        }
    }

    fn target(device_id: &str) -> CanonicalPaneTarget {
        CanonicalPaneTarget {
            device_id: device_id.to_owned(),
            server_epoch: SERVER_EPOCH,
            pane_id: "%1".to_owned(),
        }
    }

    fn subscribe_command(device_ids: &[&str], generation: u64) -> CanonicalCommand {
        CanonicalCommand::SetPaneSubscriptions(SetPaneSubscriptions {
            generation,
            active_panes: device_ids
                .iter()
                .map(|device_id| CanonicalPaneSubscription {
                    pane: target(device_id),
                    cursor: None,
                })
                .collect(),
            hot_panes: Vec::new(),
        })
    }

    fn metadata_record(device_id: &str, pane_id: &str, title: &str) -> SourceMetadataRecord {
        SourceMetadataRecord {
            key: SourceEntityKey {
                device_id: device_id.to_owned(),
                server_epoch: SERVER_EPOCH,
                entity_kind: SOURCE_ENTITY_PANE,
                native_id: pane_id.to_owned(),
            },
            parent: None,
            fields: vec![
                SourceMetadataField {
                    field: SOURCE_FIELD_TITLE,
                    value: SourceMetadataValue::String(title.to_owned()),
                },
                SourceMetadataField {
                    field: SOURCE_FIELD_PANE_EPOCH,
                    value: SourceMetadataValue::Bytes16(PANE_EPOCH),
                },
            ],
        }
    }

    fn event_kind(event: &CanonicalEvent) -> &'static str {
        match event {
            CanonicalEvent::FeedReady(_) => "FeedReady",
            CanonicalEvent::SourceMetadataSnapshot(_) => "SourceMetadataSnapshot",
            CanonicalEvent::SourceMetadataPatch(_) => "SourceMetadataPatch",
            CanonicalEvent::PaneData(_) => "PaneData",
            CanonicalEvent::SubscriptionApplied(_) => "SubscriptionApplied",
            CanonicalEvent::ScreenBegin(_) => "ScreenBegin",
            CanonicalEvent::ScreenChunk(_) => "ScreenChunk",
            CanonicalEvent::ScreenCommit(_) => "ScreenCommit",
            CanonicalEvent::HistoryBegin(_) => "HistoryBegin",
            CanonicalEvent::HistoryChunk(_) => "HistoryChunk",
            CanonicalEvent::HistoryCommit(_) => "HistoryCommit",
            CanonicalEvent::SourceGap(_) => "SourceGap",
            CanonicalEvent::Error(_) => "Error",
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscription_only_acks_and_first_screen_is_client_driven() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            vec!["device-a".to_owned()],
            false,
        );

        harness
            .session
            .handle_command(subscribe_command(&["device-a"], 1))
            .await
            .expect("command handled");
        runtime.output(b"live");
        harness.now_ms.store(16, Ordering::SeqCst);
        harness.session.advance(16);
        let events = harness.events();
        assert_eq!(
            events.iter().map(event_kind).collect::<Vec<_>>(),
            vec![
                "FeedReady",
                "SourceMetadataSnapshot",
                "SubscriptionApplied",
                "PaneData"
            ]
        );
        let CanonicalEvent::PaneData(data) = &events[3] else {
            panic!("expected pane data");
        };
        assert_eq!((data.seq_start, data.seq_end), (0, 4));
        assert_eq!(
            harness.session.snapshot_stats(),
            CanonicalFeedSessionStats {
                attached_runtimes: 1,
                screen_jobs: 0,
                gated_panes: 0,
                pending_pane_gaps: 0,
                pending_pane_gap_limit: CANONICAL_MAX_PENDING_PANE_GAPS,
                stream_gap_pending: false,
                input_dedup_ids: 0,
                input_dedup_limit: CANONICAL_MAX_INPUT_DEDUP_IDS,
                pane_data_deliveries: 1,
                pane_data_bytes: 4,
                pane_data_drops: 0,
                pane_data_drop_bytes: 0,
                pending_pane_gap_overflows: 0,
                pane_gaps_sent: 0,
                pane_gaps_by_reason: PaneGapReasonStats::default(),
                stream_gaps_sent: 0,
                screen_transactions_started: 0,
                screen_transactions_completed: 0,
                screen_transactions_failed: 0,
                screen_transactions_cancelled: 0,
                runtime_event_overflows: 0,
            }
        );

        harness
            .session
            .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: REQUEST_ID,
                pane: target("device-a"),
                byte_limit: CANONICAL_MAX_SCREEN_BYTES,
            }))
            .await
            .expect("command handled");
        harness.poll_tasks().await;
        assert_eq!(
            harness.events()[4..]
                .iter()
                .map(event_kind)
                .collect::<Vec<_>>(),
            vec!["ScreenBegin", "ScreenChunk", "ScreenCommit"]
        );
        let stats = harness.session.snapshot_stats();
        assert_eq!(stats.screen_transactions_started, 1);
        assert_eq!(stats.screen_transactions_completed, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_screen_and_history_chunks_fit_the_negotiated_frame() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        {
            let mut state = runtime.state();
            state.screen_data = vec![b'a'; 4_096];
            state.history_page = Some(PaneHistoryPage {
                pane_id: "%1".to_owned(),
                pane_epoch: PANE_EPOCH,
                history_epoch: [0x66; 16],
                line_start: 10,
                line_end: 20,
                truncated: false,
                data: vec![b'h'; 4_096],
                next_cursor: None,
            });
        }
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), runtime)]),
            512,
            None,
            Vec::new(),
            false,
        );
        harness
            .session
            .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: REQUEST_ID,
                pane: target("device-a"),
                byte_limit: CANONICAL_MAX_SCREEN_BYTES,
            }))
            .await
            .expect("command handled");
        harness.poll_tasks().await;
        harness
            .session
            .handle_command(CanonicalCommand::RequestHistory(CanonicalRequestHistory {
                request_id: [0x34; 16],
                pane: target("device-a"),
                before_cursor: None,
                byte_limit: CANONICAL_MAX_HISTORY_PAGE_BYTES,
            }))
            .await
            .expect("command handled");
        harness.poll_tasks().await;

        let events = harness.events();
        assert!(
            events
                .iter()
                .filter(|event| matches!(event, CanonicalEvent::ScreenChunk(_)))
                .count()
                > 1
        );
        assert!(
            events
                .iter()
                .filter(|event| matches!(event, CanonicalEvent::HistoryChunk(_)))
                .count()
                > 1
        );
        for event in events {
            let payload = encode_canonical_event(event).expect("event encodes");
            assert!(payload.len() + WS_ENVELOPE_WIRE_OVERHEAD_BYTES <= 512);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn history_reads_do_not_block_commands_and_runtime_errors_stay_correlated() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let gate = Arc::new(Semaphore::new(0));
        {
            let mut state = runtime.state();
            state.history_gate = Some(gate.clone());
            state.history_error = Some("history runtime closed".to_owned());
        }
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), runtime)]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            harness
                .session
                .handle_command(CanonicalCommand::RequestHistory(CanonicalRequestHistory {
                    request_id: REQUEST_ID,
                    pane: target("device-a"),
                    before_cursor: None,
                    byte_limit: 1024,
                })),
        )
        .await
        .expect("history admission does not await the runtime")
        .expect("command admitted");
        assert!(harness
            .events()
            .iter()
            .all(|event| !matches!(event, CanonicalEvent::Error(_))));

        gate.add_permits(1);
        harness.poll_tasks().await;
        let error = harness
            .events()
            .into_iter()
            .find_map(|event| match event {
                CanonicalEvent::Error(error) => Some(error),
                _ => None,
            })
            .expect("correlated history error");
        assert_eq!(error.request_id, Some(REQUEST_ID));
        assert!(error.retryable);
        assert!(error.message.contains("history runtime closed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_close_completes_pending_screen_and_history_requests() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let screen_gate = Arc::new(Semaphore::new(0));
        let history_gate = Arc::new(Semaphore::new(0));
        {
            let mut state = runtime.state();
            state.screen_capture_gate = Some(screen_gate.clone());
            state.history_gate = Some(history_gate.clone());
        }
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        let history_request_id = [0x34; 16];
        harness
            .session
            .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: REQUEST_ID,
                pane: target("device-a"),
                byte_limit: 1024,
            }))
            .await
            .expect("screen request admitted");
        harness
            .session
            .handle_command(CanonicalCommand::RequestHistory(CanonicalRequestHistory {
                request_id: history_request_id,
                pane: target("device-a"),
                before_cursor: None,
                byte_limit: 1024,
            }))
            .await
            .expect("history request admitted");

        runtime.close();
        harness.poll_tasks().await;

        let errors = harness
            .events()
            .into_iter()
            .filter_map(|event| match event {
                CanonicalEvent::Error(error) => Some(error),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(errors
            .iter()
            .any(|error| error.request_id == Some(REQUEST_ID) && error.retryable));
        assert!(errors
            .iter()
            .any(|error| error.request_id == Some(history_request_id) && error.retryable));
        assert_eq!(harness.session.snapshot_stats().screen_jobs, 0);

        screen_gate.add_permits(1);
        history_gate.add_permits(1);
        harness.poll_tasks().await;
        assert_eq!(
            harness
                .events()
                .iter()
                .filter(|event| matches!(event, CanonicalEvent::Error(_)))
                .count(),
            errors.len()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn input_ids_are_deduplicated_and_subscription_generation_is_monotonic() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        let input = CanonicalTerminalInput {
            request_id: REQUEST_ID,
            pane: target("device-a"),
            pane_epoch: PANE_EPOCH,
            input_id: [0x55; 16],
            data: b"x".to_vec(),
        };
        harness
            .session
            .handle_command(CanonicalCommand::TerminalInput(input.clone()))
            .await
            .expect("command handled");
        harness
            .session
            .handle_command(CanonicalCommand::TerminalInput(input))
            .await
            .expect("command handled");
        assert_eq!(
            runtime.state().input,
            vec![("%1".to_owned(), b"x".to_vec())]
        );

        let key_input = CanonicalTerminalKeyInput {
            request_id: REQUEST_ID,
            pane: target("device-a"),
            pane_epoch: PANE_EPOCH,
            input_id: [0x56; 16],
            key: TerminalKey::Enter,
            modifiers: tmex_protocol::TERMINAL_KEY_MOD_CTRL | tmex_protocol::TERMINAL_KEY_MOD_SHIFT,
            action: TerminalKeyAction::Press,
        };
        harness
            .session
            .handle_command(CanonicalCommand::TerminalKeyInput(key_input.clone()))
            .await
            .expect("semantic key handled");
        harness
            .session
            .handle_command(CanonicalCommand::TerminalKeyInput(key_input))
            .await
            .expect("duplicate semantic key handled");
        assert_eq!(
            runtime.state().key_input,
            vec![(
                "%1".to_owned(),
                TerminalKey::Enter,
                tmex_protocol::TERMINAL_KEY_MOD_CTRL | tmex_protocol::TERMINAL_KEY_MOD_SHIFT,
                TerminalKeyAction::Press,
            )]
        );

        harness
            .session
            .handle_command(subscribe_command(&["device-a"], 5))
            .await
            .expect("command handled");
        harness
            .session
            .handle_command(subscribe_command(&[], 4))
            .await
            .expect("command handled");
        let acknowledgements = harness
            .events()
            .into_iter()
            .filter_map(|event| match event {
                CanonicalEvent::SubscriptionApplied(applied) => Some(applied),
                _ => None,
            })
            .collect::<Vec<_>>();
        let last = acknowledgements
            .last()
            .expect("subscription acknowledgement");
        assert_eq!(last.generation, 5);
        assert_eq!(last.active_panes.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejected_input_is_correlated_and_remains_retryable_with_the_same_id() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        runtime.state().input_failures_remaining = 1;
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        let input = CanonicalTerminalInput {
            request_id: REQUEST_ID,
            pane: target("device-a"),
            pane_epoch: PANE_EPOCH,
            input_id: [0x55; 16],
            data: b"x".to_vec(),
        };
        harness
            .session
            .handle_command(CanonicalCommand::TerminalInput(input.clone()))
            .await
            .expect("failed enqueue handled");
        harness
            .session
            .handle_command(CanonicalCommand::TerminalInput(input))
            .await
            .expect("retry handled");

        assert_eq!(runtime.state().input, [("%1".to_owned(), b"x".to_vec())]);
        let error = harness
            .events()
            .into_iter()
            .find_map(|event| match event {
                CanonicalEvent::Error(error) => Some(error),
                _ => None,
            })
            .expect("correlated input error");
        assert_eq!(error.request_id, Some(REQUEST_ID));
        assert!(error.retryable);
        assert_eq!(harness.session.snapshot_stats().input_dedup_ids, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_screen_requests_share_capture_and_all_complete() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let gate = Arc::new(Semaphore::new(0));
        runtime.state().screen_capture_gate = Some(gate.clone());
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        for request_id in [REQUEST_ID, [0x34; 16]] {
            harness
                .session
                .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                    request_id,
                    pane: target("device-a"),
                    byte_limit: CANONICAL_MAX_SCREEN_BYTES,
                }))
                .await
                .expect("screen request handled");
        }
        tokio::task::yield_now().await;
        assert_eq!(runtime.state().screen_capture_count, 1);
        gate.add_permits(1);
        harness.poll_tasks().await;

        let events = harness.events();
        let request_ids = events
            .iter()
            .filter_map(|event| match event {
                CanonicalEvent::ScreenBegin(begin) => Some(begin.request_id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(request_ids, [REQUEST_ID, [0x34; 16]]);
        let stats = harness.session.snapshot_stats();
        assert_eq!(stats.screen_transactions_started, 2);
        assert_eq!(stats.screen_transactions_completed, 2);
        assert_eq!(stats.screen_transactions_cancelled, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shared_screen_capture_rejects_fanout_beyond_the_outbound_byte_budget() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let gate = Arc::new(Semaphore::new(0));
        {
            let mut state = runtime.state();
            state.screen_capture_gate = Some(gate.clone());
            state.screen_data = vec![b's'; CANONICAL_MAX_SCREEN_BYTES as usize];
        }
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), runtime)]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        for request_id in [REQUEST_ID, [0x34; 16]] {
            harness
                .session
                .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                    request_id,
                    pane: target("device-a"),
                    byte_limit: CANONICAL_MAX_SCREEN_BYTES,
                }))
                .await
                .expect("screen request handled");
        }
        gate.add_permits(1);
        harness.poll_tasks().await;

        let events = harness.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, CanonicalEvent::ScreenBegin(_)))
                .count(),
            1
        );
        let error = events
            .iter()
            .find_map(|event| match event {
                CanonicalEvent::Error(error) => Some(error),
                _ => None,
            })
            .expect("excess waiter receives an error");
        assert_eq!(error.request_id, Some([0x34; 16]));
        assert!(error.retryable);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_cut_drops_stale_pending_data_and_sends_suffix_after_commit() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            vec!["device-a".to_owned()],
            false,
        );
        harness
            .session
            .handle_command(subscribe_command(&["device-a"], 1))
            .await
            .expect("command handled");
        runtime.output(b"live");
        runtime.state().base_seq_override = Some(3);
        harness
            .session
            .handle_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: REQUEST_ID,
                pane: target("device-a"),
                byte_limit: CANONICAL_MAX_SCREEN_BYTES,
            }))
            .await
            .expect("command handled");
        harness.poll_tasks().await;

        let events = harness.events();
        assert_eq!(
            events.iter().map(event_kind).collect::<Vec<_>>(),
            vec![
                "FeedReady",
                "SourceMetadataSnapshot",
                "SubscriptionApplied",
                "ScreenBegin",
                "ScreenChunk",
                "ScreenCommit",
                "PaneData"
            ]
        );
        let CanonicalEvent::PaneData(data) = events.last().expect("pane data") else {
            panic!("expected pane data");
        };
        assert_eq!((data.seq_start, data.seq_end), (3, 4));
        assert_eq!(data.data, b"e");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pending_pane_gap_overflow_escalates_to_one_stream_rebase() {
        let runtime_a = Arc::new(FakeRuntime::new("device-a"));
        let runtime_b = Arc::new(FakeRuntime::new("device-b"));
        let mut harness = Harness::new(
            HashMap::from([
                ("device-a".to_owned(), Arc::clone(&runtime_a)),
                ("device-b".to_owned(), Arc::clone(&runtime_b)),
            ]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            Some(1),
            Vec::new(),
            true,
        );
        harness
            .session
            .handle_command(subscribe_command(&["device-a", "device-b"], 1))
            .await
            .expect("command handled");
        runtime_a.output(b"a");
        runtime_b.output(b"b");
        harness.now_ms.store(16, Ordering::SeqCst);
        harness.session.advance(16);
        let stats = harness.session.snapshot_stats();
        assert_eq!(stats.pending_pane_gaps, 0);
        assert!(stats.stream_gap_pending);
        assert_eq!(stats.pane_data_drops, 2);
        assert_eq!(stats.pane_data_drop_bytes, 2);
        assert_eq!(stats.pending_pane_gap_overflows, 1);

        harness.session.on_drain();
        let stats = harness.session.snapshot_stats();
        assert!(!stats.stream_gap_pending);
        assert_eq!(stats.stream_gaps_sent, 1);
        assert!(harness.events().iter().any(|event| matches!(
            event,
            CanonicalEvent::SourceGap(CanonicalSourceGap {
                scope: CanonicalGapScope::Stream,
                ..
            })
        )));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn metadata_records_are_atomic_chunks_with_one_revision_and_snapshot_id() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        runtime.state().metadata_records = Some(
            (0..12)
                .map(|index| metadata_record("device-a", &format!("%{index}"), &"x".repeat(100)))
                .collect(),
        );
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), runtime)]),
            512,
            None,
            Vec::new(),
            false,
        );
        harness
            .session
            .handle_command(CanonicalCommand::TerminalInput(CanonicalTerminalInput {
                request_id: REQUEST_ID,
                pane: target("device-a"),
                pane_epoch: PANE_EPOCH,
                input_id: [0x99; 16],
                data: Vec::new(),
            }))
            .await
            .expect("command handled");
        let snapshots = harness
            .events()
            .into_iter()
            .filter_map(|event| match event {
                CanonicalEvent::SourceMetadataSnapshot(snapshot) => Some(snapshot),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(snapshots.len() > 1);
        assert_eq!(
            snapshots
                .iter()
                .map(|chunk| chunk.records.len())
                .sum::<usize>(),
            12
        );
        for (index, chunk) in snapshots.iter().enumerate() {
            assert_eq!(chunk.revision, 1);
            assert_eq!(chunk.snapshot_id, [0x55; 16]);
            assert_eq!(chunk.chunk_index as usize, index);
            assert_eq!(chunk.total_chunks as usize, snapshots.len());
            let payload =
                encode_canonical_event(CanonicalEvent::SourceMetadataSnapshot(chunk.clone()))
                    .expect("snapshot encodes");
            assert!(payload.len() + WS_ENVELOPE_WIRE_OVERHEAD_BYTES <= 512);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_event_queue_overflow_requests_poll_and_forces_stream_and_metadata_rebase() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            Vec::new(),
            false,
        );
        harness
            .session
            .handle_command(subscribe_command(&["device-a"], 1))
            .await
            .expect("command handled");
        harness.poll_requests.store(0, Ordering::SeqCst);

        for _ in 0..=CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY {
            runtime.output(b"x");
        }
        assert_eq!(
            harness.poll_requests.load(Ordering::SeqCst),
            (CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY + 1) as u64
        );

        harness.session.advance(0);
        let stats = harness.session.snapshot_stats();
        assert_eq!(stats.runtime_event_overflows, 1);
        assert_eq!(stats.stream_gaps_sent, 1);
        assert_eq!(stats.pane_data_deliveries, 0);
        assert!(
            harness.poll_requests.load(Ordering::SeqCst)
                > CANONICAL_RUNTIME_EVENT_QUEUE_CAPACITY as u64
        );

        let events = harness.events();
        assert!(events.iter().any(|event| matches!(
            event,
            CanonicalEvent::SourceGap(CanonicalSourceGap {
                reason: SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
                scope: CanonicalGapScope::Stream,
            })
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, CanonicalEvent::SourceMetadataSnapshot(_)))
                .count(),
            2
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn close_deterministically_closes_the_lease_and_listener() {
        let runtime = Arc::new(FakeRuntime::new("device-a"));
        let mut harness = Harness::new(
            HashMap::from([("device-a".to_owned(), Arc::clone(&runtime))]),
            CANONICAL_STATE_MAX_FRAME_BYTES,
            None,
            vec!["device-a".to_owned()],
            false,
        );
        harness
            .session
            .handle_command(subscribe_command(&["device-a"], 1))
            .await
            .expect("command handled");
        harness.session.close();
        harness.session.close();
        let state = runtime.state();
        assert_eq!(state.lease_closes, 1);
        assert_eq!(state.listener_detaches, 1);
        assert!(state.callbacks.is_none());
        assert!(state.listener.is_none());
        drop(state);
        assert!(harness.session.is_closed());
        assert_eq!(harness.session.snapshot_stats().attached_runtimes, 0);
    }
}
