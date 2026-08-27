use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use tmex_protocol::{CanonicalHistoryCursor, WireToken};

pub const DEFAULT_MAX_ACTIVE_PANES: usize = 32;
pub const DEFAULT_MAX_HOT_PANES: usize = 8;
pub const DEFAULT_ROUTE_GRACE_MS: u64 = 2_000;
pub const DEFAULT_HOT_TTL_MS: u64 = 60_000;
pub const DEFAULT_REPLAY_TTL_MS: u64 = 15_000;
pub const DEFAULT_MAX_REPLAY_BYTES_PER_PANE: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE: usize = 6 * 1024 * 1024;
pub const DEFAULT_MAX_RETENTION_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneRetentionMode {
    Active,
    Grace,
    Hot,
    Cold,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneSubscriptionRejectionReason {
    NotFound,
    ResourceExhausted,
    EpochChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneReplayGapReason {
    PaneGap,
    EpochChanged,
    CacheEvicted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PaneRetentionEvictionReason {
    ReplayByteLimit,
    ReplayTtl,
    HotLimit,
    HotTtl,
    RetentionLimitCheckpoint,
    RetentionLimitReplay,
    EpochChanged,
}

const EVICTION_REASONS: [PaneRetentionEvictionReason; 7] = [
    PaneRetentionEvictionReason::ReplayByteLimit,
    PaneRetentionEvictionReason::ReplayTtl,
    PaneRetentionEvictionReason::HotLimit,
    PaneRetentionEvictionReason::HotTtl,
    PaneRetentionEvictionReason::RetentionLimitCheckpoint,
    PaneRetentionEvictionReason::RetentionLimitReplay,
    PaneRetentionEvictionReason::EpochChanged,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneRetentionLimits {
    pub max_active_panes: usize,
    pub max_hot_panes: usize,
    pub route_grace_ms: u64,
    pub hot_ttl_ms: u64,
    pub replay_ttl_ms: u64,
    pub max_replay_bytes_per_pane: usize,
    pub max_checkpoint_bytes_per_pane: usize,
    pub max_retention_bytes: usize,
}

impl Default for PaneRetentionLimits {
    fn default() -> Self {
        Self {
            max_active_panes: DEFAULT_MAX_ACTIVE_PANES,
            max_hot_panes: DEFAULT_MAX_HOT_PANES,
            route_grace_ms: DEFAULT_ROUTE_GRACE_MS,
            hot_ttl_ms: DEFAULT_HOT_TTL_MS,
            replay_ttl_ms: DEFAULT_REPLAY_TTL_MS,
            max_replay_bytes_per_pane: DEFAULT_MAX_REPLAY_BYTES_PER_PANE,
            max_checkpoint_bytes_per_pane: DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE,
            max_retention_bytes: DEFAULT_MAX_RETENTION_BYTES,
        }
    }
}

pub type PaneRetentionOptions = PaneRetentionLimits;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneTerminalCursor {
    pub pane_epoch: WireToken,
    pub terminal_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneSubscriptionRequest {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub cursor: Option<PaneTerminalCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneIdentity {
    pub pane_id: String,
    pub pane_epoch: WireToken,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneDataSegment {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneReplayGap {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub reason: PaneReplayGapReason,
    pub expected_pane_epoch: WireToken,
    pub expected_seq: u64,
    pub available_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneReplayPlan {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub segments: Vec<PaneDataSegment>,
    pub gap: Option<PaneReplayGap>,
    pub needs_screen: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneSubscriptionRejection {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub reason: PaneSubscriptionRejectionReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneSubscriptionApplyResult {
    pub generation: u64,
    pub active_panes: Vec<PaneIdentity>,
    pub hot_panes: Vec<PaneIdentity>,
    pub rejected: Vec<PaneSubscriptionRejection>,
    pub replay: Vec<PaneReplayPlan>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneScreenCheckpoint {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub base_seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub modes: u8,
    pub data: Vec<u8>,
    pub history_cursor: Option<CanonicalHistoryCursor>,
    pub captured_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneHistoryPage {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
    pub next_cursor: Option<PaneTerminalCursor>,
    pub gap: Option<PaneReplayGap>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneRetentionStats {
    pub known_panes: usize,
    pub active_panes: usize,
    pub grace_panes: usize,
    pub hot_panes: usize,
    pub cold_panes: usize,
    pub replay_bytes: usize,
    pub checkpoint_bytes: usize,
    pub retained_bytes: usize,
    pub evictions: u64,
    pub evictions_by_reason: BTreeMap<PaneRetentionEvictionReason, u64>,
    pub replay_hits: u64,
    pub replay_misses: u64,
    pub rebases: u64,
}

type DataCallback = Arc<dyn Fn(&PaneDataSegment) + Send + Sync + 'static>;
type GapCallback = Arc<dyn Fn(&PaneReplayGap) + Send + Sync + 'static>;
type AssetCallback = Arc<dyn Fn(&crate::state::KittyGraphicsAsset) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct PaneRetentionConsumerCallbacks {
    on_data: DataCallback,
    on_gap: Option<GapCallback>,
    on_asset: Option<AssetCallback>,
}

impl PaneRetentionConsumerCallbacks {
    pub fn new<Data>(on_data: Data) -> Self
    where
        Data: Fn(&PaneDataSegment) + Send + Sync + 'static,
    {
        Self {
            on_data: Arc::new(on_data),
            on_gap: None,
            on_asset: None,
        }
    }

    pub fn with_gap<Gap>(mut self, on_gap: Gap) -> Self
    where
        Gap: Fn(&PaneReplayGap) + Send + Sync + 'static,
    {
        self.on_gap = Some(Arc::new(on_gap));
        self
    }

    pub fn with_asset<Asset>(mut self, on_asset: Asset) -> Self
    where
        Asset: Fn(&crate::state::KittyGraphicsAsset) + Send + Sync + 'static,
    {
        self.on_asset = Some(Arc::new(on_asset));
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneRetentionError {
    Disposed,
    ConsumerClosed,
    GenerationConflict(u64),
    SequenceOverflow,
    AcceptedPaneDisappeared(String),
}

impl fmt::Display for PaneRetentionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disposed => formatter.write_str("pane retention is disposed"),
            Self::ConsumerClosed => formatter.write_str("pane retention consumer is closed"),
            Self::GenerationConflict(generation) => write!(
                formatter,
                "subscription generation {generation} was reused with different contents"
            ),
            Self::SequenceOverflow => formatter.write_str("pane terminal sequence overflow"),
            Self::AcceptedPaneDisappeared(pane_id) => {
                write!(
                    formatter,
                    "accepted pane disappeared before replay: {pane_id}"
                )
            }
        }
    }
}

impl std::error::Error for PaneRetentionError {}

#[derive(Clone)]
pub struct PaneRetention {
    shared: Arc<Mutex<RetentionState>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

pub struct PaneRetentionConsumerLease {
    owner: Weak<Mutex<RetentionState>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    consumer_id: u64,
    closed: AtomicBool,
}

#[derive(Clone)]
struct ReplayChunk {
    seq_start: u64,
    seq_end: u64,
    data: Vec<u8>,
    received_at: u64,
}

struct PaneState {
    pane_id: String,
    pane_epoch: WireToken,
    known: bool,
    latest_seq: u64,
    dirty_while_cold: bool,
    mode: PaneRetentionMode,
    explicit_hot: bool,
    grace_until: Option<u64>,
    hot_until: Option<u64>,
    last_touched_at: u64,
    order: u64,
    replay: VecDeque<ReplayChunk>,
    replay_bytes: usize,
    checkpoint: Option<PaneScreenCheckpoint>,
}

struct ConsumerState {
    callbacks: PaneRetentionConsumerCallbacks,
    generation: Option<u64>,
    fingerprint: Option<String>,
    active: BTreeMap<String, PaneSubscriptionRequest>,
    active_order: Vec<String>,
    hot: BTreeMap<String, PaneSubscriptionRequest>,
    hot_order: Vec<String>,
}

struct RetentionState {
    limits: PaneRetentionLimits,
    panes: BTreeMap<String, PaneState>,
    consumers: HashMap<u64, ConsumerState>,
    next_consumer_id: u64,
    next_pane_order: u64,
    disposed: bool,
    evictions: u64,
    evictions_by_reason: BTreeMap<PaneRetentionEvictionReason, u64>,
    replay_hits: u64,
    replay_misses: u64,
    rebases: u64,
}

impl PaneRetention {
    pub fn new(options: PaneRetentionOptions) -> Self {
        Self::with_clock(options, system_time_ms)
    }

    pub fn with_clock<Clock>(options: PaneRetentionOptions, clock: Clock) -> Self
    where
        Clock: Fn() -> u64 + Send + Sync + 'static,
    {
        let evictions_by_reason = EVICTION_REASONS
            .into_iter()
            .map(|reason| (reason, 0))
            .collect();
        Self {
            shared: Arc::new(Mutex::new(RetentionState {
                limits: options,
                panes: BTreeMap::new(),
                consumers: HashMap::new(),
                next_consumer_id: 1,
                next_pane_order: 0,
                disposed: false,
                evictions: 0,
                evictions_by_reason,
                replay_hits: 0,
                replay_misses: 0,
                rebases: 0,
            })),
            clock: Arc::new(clock),
        }
    }

    pub fn attach_consumer(
        &self,
        callbacks: PaneRetentionConsumerCallbacks,
    ) -> Result<PaneRetentionConsumerLease, PaneRetentionError> {
        let mut state = lock(&self.shared);
        if state.disposed {
            return Err(PaneRetentionError::Disposed);
        }
        let consumer_id = state.next_consumer_id;
        state.next_consumer_id = state.next_consumer_id.wrapping_add(1);
        state.consumers.insert(
            consumer_id,
            ConsumerState {
                callbacks,
                generation: None,
                fingerprint: None,
                active: BTreeMap::new(),
                active_order: Vec::new(),
                hot: BTreeMap::new(),
                hot_order: Vec::new(),
            },
        );
        Ok(PaneRetentionConsumerLease {
            owner: Arc::downgrade(&self.shared),
            clock: Arc::clone(&self.clock),
            consumer_id,
            closed: AtomicBool::new(false),
        })
    }

    pub fn reconcile_panes(&self, panes: &[PaneIdentity]) {
        let now = (self.clock)();
        let mut gap_callbacks = Vec::new();
        let mut state = lock(&self.shared);
        if state.disposed {
            return;
        }
        let mut seen = HashSet::new();
        for pane in panes {
            seen.insert(pane.pane_id.clone());
            if !state.panes.contains_key(&pane.pane_id) {
                let created = create_pane(&mut state, pane, true, now);
                state.panes.insert(pane.pane_id.clone(), created);
                continue;
            }
            let epoch_changed = state
                .panes
                .get(&pane.pane_id)
                .is_some_and(|current| current.pane_epoch != pane.pane_epoch);
            if let Some(current) = state.panes.get_mut(&pane.pane_id) {
                current.known = true;
            }
            if epoch_changed {
                gap_callbacks.extend(rotate_pane_epoch(
                    &mut state,
                    &pane.pane_id,
                    pane.pane_epoch,
                ));
            }
        }
        let removed = state
            .panes
            .iter()
            .filter(|(pane_id, pane)| pane.known && !seen.contains(*pane_id))
            .map(|(pane_id, _)| pane_id.clone())
            .collect::<Vec<_>>();
        for pane_id in removed {
            state.panes.remove(&pane_id);
            for consumer in state.consumers.values_mut() {
                consumer.active.remove(&pane_id);
                consumer
                    .active_order
                    .retain(|candidate| candidate != &pane_id);
                consumer.hot.remove(&pane_id);
                consumer.hot_order.retain(|candidate| candidate != &pane_id);
            }
        }
        refresh_modes(&mut state, now);
        drop(state);
        publish_gaps(gap_callbacks);
    }

    pub fn ingest(
        &self,
        pane_id: &str,
        pane_epoch: WireToken,
        data: &[u8],
    ) -> Result<Option<PaneDataSegment>, PaneRetentionError> {
        if data.is_empty() {
            return Ok(None);
        }
        let now = (self.clock)();
        let mut state = lock(&self.shared);
        if state.disposed {
            return Ok(None);
        }
        sweep_inner(&mut state, now);
        if !state.panes.contains_key(pane_id) {
            let identity = PaneIdentity {
                pane_id: pane_id.to_owned(),
                pane_epoch,
            };
            let created = create_pane(&mut state, &identity, false, now);
            state.panes.insert(pane_id.to_owned(), created);
        }
        let gap_callbacks = if state
            .panes
            .get(pane_id)
            .is_some_and(|pane| pane.pane_epoch != pane_epoch)
        {
            rotate_pane_epoch(&mut state, pane_id, pane_epoch)
        } else {
            Vec::new()
        };

        let limits = state.limits.clone();
        let (segment, evictions) = {
            let pane = state
                .panes
                .get_mut(pane_id)
                .ok_or_else(|| PaneRetentionError::AcceptedPaneDisappeared(pane_id.to_owned()))?;
            let seq_start = pane.latest_seq;
            let seq_end = seq_start
                .checked_add(data.len() as u64)
                .ok_or(PaneRetentionError::SequenceOverflow)?;
            pane.latest_seq = seq_end;
            if pane.mode != PaneRetentionMode::Cold {
                pane.replay.push_back(ReplayChunk {
                    seq_start,
                    seq_end,
                    data: data.to_vec(),
                    received_at: now,
                });
                pane.replay_bytes = pane.replay_bytes.saturating_add(data.len());
            } else {
                pane.dirty_while_cold = true;
            }
            let evictions = trim_pane_replay(pane, &limits, now);
            (
                PaneDataSegment {
                    pane_id: pane_id.to_owned(),
                    pane_epoch: pane.pane_epoch,
                    seq_start,
                    seq_end,
                    data: data.to_vec(),
                },
                evictions,
            )
        };
        for reason in evictions {
            record_eviction(&mut state, reason);
        }
        let callbacks = state
            .consumers
            .values()
            .filter_map(|consumer| {
                let request = consumer
                    .active
                    .get(pane_id)
                    .or_else(|| consumer.hot.get(pane_id))?;
                (request.pane_epoch == pane_epoch).then(|| Arc::clone(&consumer.callbacks.on_data))
            })
            .collect::<Vec<_>>();
        enforce_bounds(&mut state, now);
        drop(state);
        publish_gaps(gap_callbacks);
        for callback in callbacks {
            let _ = catch_unwind(AssertUnwindSafe(|| callback(&segment)));
        }
        Ok(Some(segment))
    }

    pub fn latest_cursor(&self, pane_id: &str) -> Option<PaneTerminalCursor> {
        let state = lock(&self.shared);
        let pane = state.panes.get(pane_id).filter(|pane| pane.known)?;
        Some(PaneTerminalCursor {
            pane_epoch: pane.pane_epoch,
            terminal_seq: pane.latest_seq,
        })
    }

    pub fn notify_kitty_asset(&self, asset: &crate::state::KittyGraphicsAsset) {
        let (pane_id, pane_epoch) = match asset {
            crate::state::KittyGraphicsAsset::Image { pane_id, pane_epoch, .. } => (pane_id, *pane_epoch),
            crate::state::KittyGraphicsAsset::Placement { pane_id, pane_epoch, .. } => (pane_id, *pane_epoch),
            crate::state::KittyGraphicsAsset::Delete { pane_id, pane_epoch, .. } => (pane_id, *pane_epoch),
        };
        let state = lock(&self.shared);
        let callbacks = state
            .consumers
            .values()
            .filter_map(|consumer| {
                let request = consumer.active.get(pane_id).or_else(|| consumer.hot.get(pane_id))?;
                (request.pane_epoch == pane_epoch).then(|| consumer.callbacks.on_asset.clone())
            })
            .flatten()
            .collect::<Vec<_>>();
        drop(state);
        for callback in callbacks {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(asset)));
        }
    }

    pub fn is_pane_retained(&self, pane_id: &str) -> bool {
        lock(&self.shared)
            .panes
            .get(pane_id)
            .is_some_and(|pane| pane.known && pane.mode != PaneRetentionMode::Cold)
    }

    pub fn limits(&self) -> PaneRetentionLimits {
        lock(&self.shared).limits.clone()
    }

    pub fn read_replay(
        &self,
        pane_id: &str,
        cursor: &PaneTerminalCursor,
    ) -> Result<Option<PaneReplayPlan>, PaneRetentionError> {
        let mut state = lock(&self.shared);
        let Some(pane) = state.panes.get(pane_id).filter(|pane| pane.known) else {
            return Ok(None);
        };
        let request = PaneSubscriptionRequest {
            pane_id: pane_id.to_owned(),
            pane_epoch: pane.pane_epoch,
            cursor: Some(cursor.clone()),
        };
        build_replay_plan(&mut state, &request).map(Some)
    }

    pub fn screen_checkpoint(&self, pane_id: &str) -> Option<PaneScreenCheckpoint> {
        let now = (self.clock)();
        let mut state = lock(&self.shared);
        let pane = state.panes.get_mut(pane_id).filter(|pane| pane.known)?;
        let checkpoint = pane
            .checkpoint
            .as_ref()
            .filter(|checkpoint| checkpoint.pane_epoch == pane.pane_epoch)?
            .clone();
        pane.last_touched_at = now;
        Some(checkpoint)
    }

    pub fn store_screen_checkpoint(&self, checkpoint: PaneScreenCheckpoint) -> bool {
        let now = (self.clock)();
        let mut state = lock(&self.shared);
        let max_bytes = state.limits.max_checkpoint_bytes_per_pane;
        let pane_id = checkpoint.pane_id.clone();
        let Some(pane) = state
            .panes
            .get_mut(&checkpoint.pane_id)
            .filter(|pane| pane.known)
        else {
            return false;
        };
        if pane.pane_epoch != checkpoint.pane_epoch
            || checkpoint.base_seq > pane.latest_seq
            || checkpoint.data.len() > max_bytes
        {
            return false;
        }
        pane.checkpoint = Some(checkpoint);
        pane.last_touched_at = now;
        enforce_bounds(&mut state, now);
        state
            .panes
            .get(&pane_id)
            .is_some_and(|pane| pane.checkpoint.is_some())
    }

    pub fn read_history(
        &self,
        pane_id: &str,
        before_cursor: Option<&PaneTerminalCursor>,
        byte_limit: usize,
    ) -> Option<PaneHistoryPage> {
        let now = (self.clock)();
        let mut state = lock(&self.shared);
        let max_replay = state.limits.max_replay_bytes_per_pane;
        let pane = state.panes.get_mut(pane_id).filter(|pane| pane.known)?;
        let limit = byte_limit.min(max_replay);
        let before_seq = before_cursor.map_or(pane.latest_seq, |cursor| cursor.terminal_seq);
        let expected_epoch = before_cursor.map_or(pane.pane_epoch, |cursor| cursor.pane_epoch);
        if expected_epoch != pane.pane_epoch {
            return Some(empty_history_gap(
                pane,
                PaneReplayGapReason::EpochChanged,
                expected_epoch,
                before_seq,
            ));
        }
        let oldest_seq = pane
            .replay
            .front()
            .map_or(pane.latest_seq, |chunk| chunk.seq_start);
        if before_seq > pane.latest_seq || before_seq < oldest_seq {
            let reason = if before_seq > pane.latest_seq {
                PaneReplayGapReason::PaneGap
            } else {
                PaneReplayGapReason::CacheEvicted
            };
            return Some(empty_history_gap(pane, reason, expected_epoch, before_seq));
        }

        let mut reverse_parts = Vec::new();
        let mut remaining = limit;
        let mut seq_start = before_seq;
        for chunk in pane.replay.iter().rev() {
            if remaining == 0 || chunk.seq_start >= before_seq {
                continue;
            }
            let upper = chunk.seq_end.min(before_seq);
            if upper <= chunk.seq_start {
                continue;
            }
            let available = usize::try_from(upper - chunk.seq_start).unwrap_or(usize::MAX);
            let take = available.min(remaining);
            let end_offset = usize::try_from(upper - chunk.seq_start).ok()?;
            reverse_parts.push(chunk.data[end_offset - take..end_offset].to_vec());
            remaining -= take;
            seq_start = upper - take as u64;
        }
        reverse_parts.reverse();
        let data = reverse_parts.concat();
        pane.last_touched_at = now;
        Some(PaneHistoryPage {
            pane_id: pane.pane_id.clone(),
            pane_epoch: pane.pane_epoch,
            seq_start,
            seq_end: before_seq,
            data,
            next_cursor: (seq_start > oldest_seq).then_some(PaneTerminalCursor {
                pane_epoch: pane.pane_epoch,
                terminal_seq: seq_start,
            }),
            gap: None,
        })
    }

    pub fn stats(&self) -> PaneRetentionStats {
        let now = (self.clock)();
        let mut state = lock(&self.shared);
        sweep_inner(&mut state, now);
        let mut stats = PaneRetentionStats {
            known_panes: 0,
            active_panes: 0,
            grace_panes: 0,
            hot_panes: 0,
            cold_panes: 0,
            replay_bytes: 0,
            checkpoint_bytes: 0,
            retained_bytes: 0,
            evictions: state.evictions,
            evictions_by_reason: state.evictions_by_reason.clone(),
            replay_hits: state.replay_hits,
            replay_misses: state.replay_misses,
            rebases: state.rebases,
        };
        for pane in state.panes.values().filter(|pane| pane.known) {
            stats.known_panes += 1;
            match pane.mode {
                PaneRetentionMode::Active => stats.active_panes += 1,
                PaneRetentionMode::Grace => stats.grace_panes += 1,
                PaneRetentionMode::Hot => stats.hot_panes += 1,
                PaneRetentionMode::Cold => stats.cold_panes += 1,
            }
            stats.replay_bytes += pane.replay_bytes;
            stats.checkpoint_bytes += pane
                .checkpoint
                .as_ref()
                .map_or(0, |checkpoint| checkpoint.data.len());
        }
        stats.retained_bytes = stats.replay_bytes + stats.checkpoint_bytes;
        stats
    }

    pub fn sweep(&self, now: u64) {
        let mut state = lock(&self.shared);
        if !state.disposed {
            sweep_inner(&mut state, now);
        }
    }

    pub fn dispose(&self) {
        let mut state = lock(&self.shared);
        if state.disposed {
            return;
        }
        state.disposed = true;
        state.consumers.clear();
        state.panes.clear();
    }
}

impl Default for PaneRetention {
    fn default() -> Self {
        Self::new(PaneRetentionOptions::default())
    }
}

impl PaneRetentionConsumerLease {
    pub fn apply_subscriptions(
        &self,
        generation: u64,
        active_panes: &[PaneSubscriptionRequest],
        hot_panes: &[PaneSubscriptionRequest],
    ) -> Result<PaneSubscriptionApplyResult, PaneRetentionError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(PaneRetentionError::ConsumerClosed);
        }
        let owner = self
            .owner
            .upgrade()
            .ok_or(PaneRetentionError::ConsumerClosed)?;
        let mut state = lock(&owner);
        apply_subscriptions(
            &mut state,
            self.consumer_id,
            generation,
            active_panes,
            hot_panes,
            (self.clock)(),
        )
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let mut state = lock(&owner);
        if state.consumers.remove(&self.consumer_id).is_some() {
            refresh_modes(&mut state, (self.clock)());
        }
    }
}

impl Drop for PaneRetentionConsumerLease {
    fn drop(&mut self) {
        self.close();
    }
}

fn apply_subscriptions(
    state: &mut RetentionState,
    consumer_id: u64,
    generation: u64,
    requested_active: &[PaneSubscriptionRequest],
    requested_hot: &[PaneSubscriptionRequest],
    now: u64,
) -> Result<PaneSubscriptionApplyResult, PaneRetentionError> {
    if state.disposed {
        return Err(PaneRetentionError::Disposed);
    }
    let active_requests = unique_requests(requested_active);
    let active_ids = active_requests
        .iter()
        .map(|request| request.pane_id.as_str())
        .collect::<HashSet<_>>();
    let hot_requests = unique_requests(requested_hot)
        .into_iter()
        .filter(|request| !active_ids.contains(request.pane_id.as_str()))
        .collect::<Vec<_>>();
    let fingerprint = subscription_fingerprint(&active_requests, &hot_requests);
    let consumer = state
        .consumers
        .get(&consumer_id)
        .ok_or(PaneRetentionError::ConsumerClosed)?;
    if consumer
        .generation
        .is_some_and(|current| generation < current)
    {
        return Ok(current_apply_result(consumer));
    }
    if consumer.generation == Some(generation) {
        if consumer.fingerprint.as_deref() != Some(&fingerprint) {
            return Err(PaneRetentionError::GenerationConflict(generation));
        }
        return Ok(current_apply_result(consumer));
    }

    sweep_inner(state, now);
    let other_active = union_pane_ids(state, SubscriptionKind::Active, consumer_id);
    let other_hot = union_pane_ids(state, SubscriptionKind::Hot, consumer_id);
    let mut prospective_active = other_active;
    let mut prospective_hot = other_hot;
    let mut accepted_active = BTreeMap::new();
    let mut accepted_active_order = Vec::new();
    let mut accepted_hot = BTreeMap::new();
    let mut accepted_hot_order = Vec::new();
    let mut rejected = Vec::new();

    for request in active_requests {
        if let Some(reason) = validate_request(state.panes.get(&request.pane_id), &request) {
            rejected.push(rejection(&request, reason));
            continue;
        }
        if !prospective_active.contains(&request.pane_id)
            && prospective_active.len() >= state.limits.max_active_panes
        {
            rejected.push(rejection(
                &request,
                PaneSubscriptionRejectionReason::ResourceExhausted,
            ));
            continue;
        }
        prospective_active.insert(request.pane_id.clone());
        accepted_active_order.push(request.pane_id.clone());
        accepted_active.insert(request.pane_id.clone(), request);
    }
    for request in hot_requests {
        if let Some(reason) = validate_request(state.panes.get(&request.pane_id), &request) {
            rejected.push(rejection(&request, reason));
            continue;
        }
        if !prospective_hot.contains(&request.pane_id)
            && prospective_hot.len() >= state.limits.max_hot_panes
        {
            rejected.push(rejection(
                &request,
                PaneSubscriptionRejectionReason::ResourceExhausted,
            ));
            continue;
        }
        prospective_hot.insert(request.pane_id.clone());
        accepted_hot_order.push(request.pane_id.clone());
        accepted_hot.insert(request.pane_id.clone(), request);
    }

    for pane_id in accepted_active.keys().chain(accepted_hot.keys()) {
        if let Some(pane) = state.panes.get_mut(pane_id) {
            pane.last_touched_at = now;
        }
    }
    {
        let consumer = state
            .consumers
            .get_mut(&consumer_id)
            .ok_or(PaneRetentionError::ConsumerClosed)?;
        consumer.generation = Some(generation);
        consumer.fingerprint = Some(fingerprint);
        consumer.active = accepted_active;
        consumer.active_order = accepted_active_order;
        consumer.hot = accepted_hot;
        consumer.hot_order = accepted_hot_order;
    }
    refresh_modes(state, now);

    let (active, hot) = {
        let consumer = state
            .consumers
            .get(&consumer_id)
            .ok_or(PaneRetentionError::ConsumerClosed)?;
        (
            ordered_requests(&consumer.active, &consumer.active_order),
            ordered_requests(&consumer.hot, &consumer.hot_order),
        )
    };
    let mut replay = Vec::with_capacity(active.len() + hot.len());
    for request in active.iter().chain(&hot) {
        replay.push(build_replay_plan(state, request)?);
    }
    Ok(PaneSubscriptionApplyResult {
        generation,
        active_panes: active.iter().map(request_identity).collect(),
        hot_panes: hot.iter().map(request_identity).collect(),
        rejected,
        replay,
    })
}

fn build_replay_plan(
    state: &mut RetentionState,
    request: &PaneSubscriptionRequest,
) -> Result<PaneReplayPlan, PaneRetentionError> {
    let pane = state
        .panes
        .get(&request.pane_id)
        .filter(|pane| pane.known)
        .ok_or_else(|| PaneRetentionError::AcceptedPaneDisappeared(request.pane_id.clone()))?;
    let identity = pane_identity(pane);
    let Some(cursor) = &request.cursor else {
        state.replay_misses += 1;
        state.rebases += 1;
        return Ok(PaneReplayPlan {
            pane_id: identity.pane_id,
            pane_epoch: identity.pane_epoch,
            segments: Vec::new(),
            gap: None,
            needs_screen: true,
        });
    };
    if cursor.pane_epoch != pane.pane_epoch {
        let gap = create_gap(
            pane,
            PaneReplayGapReason::EpochChanged,
            cursor.pane_epoch,
            cursor.terminal_seq,
        );
        state.replay_misses += 1;
        state.rebases += 1;
        return Ok(PaneReplayPlan {
            pane_id: identity.pane_id,
            pane_epoch: identity.pane_epoch,
            segments: Vec::new(),
            gap: Some(gap),
            needs_screen: true,
        });
    }
    let oldest_seq = pane
        .replay
        .front()
        .map_or(pane.latest_seq, |chunk| chunk.seq_start);
    if cursor.terminal_seq > pane.latest_seq || cursor.terminal_seq < oldest_seq {
        let reason = if cursor.terminal_seq > pane.latest_seq {
            PaneReplayGapReason::PaneGap
        } else {
            PaneReplayGapReason::CacheEvicted
        };
        let gap = create_gap(pane, reason, cursor.pane_epoch, cursor.terminal_seq);
        state.replay_misses += 1;
        state.rebases += 1;
        return Ok(PaneReplayPlan {
            pane_id: identity.pane_id,
            pane_epoch: identity.pane_epoch,
            segments: Vec::new(),
            gap: Some(gap),
            needs_screen: true,
        });
    }
    let segments = pane
        .replay
        .iter()
        .filter_map(|chunk| {
            if chunk.seq_end <= cursor.terminal_seq {
                return None;
            }
            let offset = if cursor.terminal_seq > chunk.seq_start {
                usize::try_from(cursor.terminal_seq - chunk.seq_start).ok()?
            } else {
                0
            };
            Some(PaneDataSegment {
                pane_id: identity.pane_id.clone(),
                pane_epoch: identity.pane_epoch,
                seq_start: chunk.seq_start + offset as u64,
                seq_end: chunk.seq_end,
                data: chunk.data[offset..].to_vec(),
            })
        })
        .collect();
    state.replay_hits += 1;
    Ok(PaneReplayPlan {
        pane_id: identity.pane_id,
        pane_epoch: identity.pane_epoch,
        segments,
        gap: None,
        needs_screen: false,
    })
}

fn create_pane(
    state: &mut RetentionState,
    pane: &PaneIdentity,
    known: bool,
    now: u64,
) -> PaneState {
    let order = state.next_pane_order;
    state.next_pane_order = state.next_pane_order.wrapping_add(1);
    PaneState {
        pane_id: pane.pane_id.clone(),
        pane_epoch: pane.pane_epoch,
        known,
        latest_seq: 0,
        dirty_while_cold: false,
        mode: PaneRetentionMode::Cold,
        explicit_hot: false,
        grace_until: None,
        hot_until: None,
        last_touched_at: now,
        order,
        replay: VecDeque::new(),
        replay_bytes: 0,
        checkpoint: None,
    }
}

fn rotate_pane_epoch(
    state: &mut RetentionState,
    pane_id: &str,
    pane_epoch: WireToken,
) -> Vec<(GapCallback, PaneReplayGap)> {
    let (previous_epoch, previous_seq, had_retention) = {
        let Some(pane) = state.panes.get_mut(pane_id) else {
            return Vec::new();
        };
        let values = (
            pane.pane_epoch,
            pane.latest_seq,
            pane.replay_bytes > 0 || pane.checkpoint.is_some(),
        );
        pane.pane_epoch = pane_epoch;
        pane.latest_seq = 0;
        pane.dirty_while_cold = false;
        pane.replay.clear();
        pane.replay_bytes = 0;
        pane.checkpoint = None;
        pane.mode = PaneRetentionMode::Cold;
        pane.explicit_hot = false;
        pane.grace_until = None;
        pane.hot_until = None;
        values
    };
    if had_retention {
        record_eviction(state, PaneRetentionEvictionReason::EpochChanged);
    }
    let gap = PaneReplayGap {
        pane_id: pane_id.to_owned(),
        pane_epoch,
        reason: PaneReplayGapReason::EpochChanged,
        expected_pane_epoch: previous_epoch,
        expected_seq: previous_seq,
        available_seq: 0,
    };
    let mut callbacks = Vec::new();
    for consumer in state.consumers.values_mut() {
        if !consumer.active.contains_key(pane_id) && !consumer.hot.contains_key(pane_id) {
            continue;
        }
        consumer.active.remove(pane_id);
        consumer
            .active_order
            .retain(|candidate| candidate != pane_id);
        consumer.hot.remove(pane_id);
        consumer.hot_order.retain(|candidate| candidate != pane_id);
        if let Some(callback) = &consumer.callbacks.on_gap {
            callbacks.push((Arc::clone(callback), gap.clone()));
        }
    }
    callbacks
}

fn refresh_modes(state: &mut RetentionState, now: u64) {
    let active = union_pane_ids(state, SubscriptionKind::Active, u64::MAX);
    let hot = union_pane_ids(state, SubscriptionKind::Hot, u64::MAX);
    for pane in state.panes.values_mut() {
        if active.contains(&pane.pane_id) {
            pane.mode = PaneRetentionMode::Active;
            pane.explicit_hot = false;
            pane.grace_until = None;
            pane.hot_until = None;
        } else if hot.contains(&pane.pane_id) {
            pane.mode = PaneRetentionMode::Hot;
            pane.explicit_hot = true;
            pane.grace_until = None;
            pane.hot_until = None;
        } else if pane.mode == PaneRetentionMode::Active
            || (pane.mode == PaneRetentionMode::Hot && pane.explicit_hot)
        {
            pane.mode = PaneRetentionMode::Grace;
            pane.explicit_hot = false;
            pane.grace_until = Some(now.saturating_add(state.limits.route_grace_ms));
            pane.hot_until = None;
            pane.last_touched_at = now;
        }
    }
    enforce_bounds(state, now);
}

fn sweep_inner(state: &mut RetentionState, now: u64) {
    if state.disposed {
        return;
    }
    let pane_ids = state.panes.keys().cloned().collect::<Vec<_>>();
    for pane_id in pane_ids {
        let evictions = state
            .panes
            .get_mut(&pane_id)
            .map(|pane| trim_pane_replay(pane, &state.limits, now))
            .unwrap_or_default();
        for reason in evictions {
            record_eviction(state, reason);
        }
        let grace_expired = state.panes.get(&pane_id).is_some_and(|pane| {
            pane.mode == PaneRetentionMode::Grace
                && pane.grace_until.is_some_and(|deadline| now >= deadline)
        });
        if grace_expired {
            if let Some(pane) = state.panes.get_mut(&pane_id) {
                pane.mode = PaneRetentionMode::Hot;
                pane.grace_until = None;
                pane.hot_until = Some(now.saturating_add(state.limits.hot_ttl_ms));
                pane.explicit_hot = false;
            }
        }
        let hot_expired = state.panes.get(&pane_id).is_some_and(|pane| {
            pane.mode == PaneRetentionMode::Hot
                && !pane.explicit_hot
                && pane.hot_until.is_some_and(|deadline| now >= deadline)
        });
        if hot_expired
            && state
                .panes
                .get_mut(&pane_id)
                .is_some_and(|pane| make_cold(pane, PaneRetentionEvictionReason::HotTtl))
        {
            record_eviction(state, PaneRetentionEvictionReason::HotTtl);
        }
    }
    enforce_bounds(state, now);
}

fn trim_pane_replay(
    pane: &mut PaneState,
    limits: &PaneRetentionLimits,
    now: u64,
) -> Vec<PaneRetentionEvictionReason> {
    let mut evictions = Vec::new();
    loop {
        let Some(front) = pane.replay.front() else {
            break;
        };
        let reason = if pane.replay_bytes > limits.max_replay_bytes_per_pane {
            Some(PaneRetentionEvictionReason::ReplayByteLimit)
        } else if now.saturating_sub(front.received_at) > limits.replay_ttl_ms {
            Some(PaneRetentionEvictionReason::ReplayTtl)
        } else {
            None
        };
        let Some(reason) = reason else {
            break;
        };
        if let Some(removed) = pane.replay.pop_front() {
            pane.replay_bytes = pane.replay_bytes.saturating_sub(removed.data.len());
            evictions.push(reason);
        }
    }
    evictions
}

fn enforce_bounds(state: &mut RetentionState, now: u64) {
    let explicit_hot = state
        .panes
        .values()
        .filter(|pane| pane.mode == PaneRetentionMode::Hot && pane.explicit_hot)
        .count();
    let mut available_implicit = state.limits.max_hot_panes.saturating_sub(explicit_hot);
    let mut implicit_hot = state
        .panes
        .values()
        .filter(|pane| pane.mode == PaneRetentionMode::Hot && !pane.explicit_hot)
        .map(|pane| (pane.pane_id.clone(), pane.last_touched_at, pane.order))
        .collect::<Vec<_>>();
    implicit_hot.sort_by(|left, right| right.1.cmp(&left.1).then(left.2.cmp(&right.2)));
    for (pane_id, _, _) in implicit_hot {
        if available_implicit > 0 {
            available_implicit -= 1;
            continue;
        }
        if state
            .panes
            .get_mut(&pane_id)
            .is_some_and(|pane| make_cold(pane, PaneRetentionEvictionReason::HotLimit))
        {
            record_eviction(state, PaneRetentionEvictionReason::HotLimit);
        }
    }

    let mut retained = retained_bytes(state);
    if retained <= state.limits.max_retention_bytes {
        return;
    }
    let mut candidates = state
        .panes
        .values()
        .map(|pane| {
            let rank = if pane.mode == PaneRetentionMode::Active {
                2
            } else if pane.explicit_hot {
                1
            } else {
                0
            };
            (pane.pane_id.clone(), rank, pane.last_touched_at, pane.order)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, rank, touched, order)| (*rank, *touched, *order));

    for (pane_id, _, _, _) in &candidates {
        if retained <= state.limits.max_retention_bytes {
            break;
        }
        let Some(pane) = state.panes.get_mut(pane_id) else {
            continue;
        };
        if pane.mode == PaneRetentionMode::Hot && !pane.explicit_hot {
            let bytes = pane.replay_bytes
                + pane
                    .checkpoint
                    .as_ref()
                    .map_or(0, |checkpoint| checkpoint.data.len());
            if make_cold(pane, PaneRetentionEvictionReason::RetentionLimitReplay) {
                retained = retained.saturating_sub(bytes);
                record_eviction(state, PaneRetentionEvictionReason::RetentionLimitReplay);
            }
        }
    }
    for (pane_id, _, _, _) in &candidates {
        if retained <= state.limits.max_retention_bytes {
            break;
        }
        let checkpoint_bytes = state
            .panes
            .get(pane_id)
            .and_then(|pane| pane.checkpoint.as_ref())
            .map(|checkpoint| checkpoint.data.len());
        if let Some(bytes) = checkpoint_bytes {
            let Some(pane) = state.panes.get_mut(pane_id) else {
                continue;
            };
            pane.checkpoint = None;
            retained = retained.saturating_sub(bytes);
            record_eviction(state, PaneRetentionEvictionReason::RetentionLimitCheckpoint);
        }
    }
    while retained > state.limits.max_retention_bytes {
        let candidate = state
            .panes
            .values()
            .filter_map(|pane| {
                pane.replay
                    .front()
                    .map(|chunk| (pane.pane_id.clone(), chunk.received_at, pane.order))
            })
            .min_by_key(|(_, received_at, order)| (*received_at, *order));
        let Some((pane_id, _, _)) = candidate else {
            break;
        };
        let Some(pane) = state.panes.get_mut(&pane_id) else {
            continue;
        };
        let Some(chunk) = pane.replay.pop_front() else {
            break;
        };
        pane.replay_bytes = pane.replay_bytes.saturating_sub(chunk.data.len());
        retained = retained.saturating_sub(chunk.data.len());
        record_eviction(state, PaneRetentionEvictionReason::RetentionLimitReplay);
    }
    let _ = now;
}

fn make_cold(pane: &mut PaneState, _reason: PaneRetentionEvictionReason) -> bool {
    let had_retention = pane.replay_bytes > 0 || pane.checkpoint.is_some();
    pane.mode = PaneRetentionMode::Cold;
    pane.explicit_hot = false;
    pane.grace_until = None;
    pane.hot_until = None;
    pane.replay.clear();
    pane.replay_bytes = 0;
    pane.checkpoint = None;
    had_retention
}

fn retained_bytes(state: &RetentionState) -> usize {
    state
        .panes
        .values()
        .map(|pane| {
            pane.replay_bytes
                + pane
                    .checkpoint
                    .as_ref()
                    .map_or(0, |checkpoint| checkpoint.data.len())
        })
        .sum()
}

fn record_eviction(state: &mut RetentionState, reason: PaneRetentionEvictionReason) {
    state.evictions += 1;
    *state.evictions_by_reason.entry(reason).or_default() += 1;
}

#[derive(Clone, Copy)]
enum SubscriptionKind {
    Active,
    Hot,
}

fn union_pane_ids(
    state: &RetentionState,
    kind: SubscriptionKind,
    excluded_consumer_id: u64,
) -> HashSet<String> {
    state
        .consumers
        .iter()
        .filter(|(consumer_id, _)| **consumer_id != excluded_consumer_id)
        .flat_map(|(_, consumer)| match kind {
            SubscriptionKind::Active => consumer.active.keys(),
            SubscriptionKind::Hot => consumer.hot.keys(),
        })
        .cloned()
        .collect()
}

fn validate_request(
    pane: Option<&PaneState>,
    request: &PaneSubscriptionRequest,
) -> Option<PaneSubscriptionRejectionReason> {
    let Some(pane) = pane.filter(|pane| pane.known) else {
        return Some(PaneSubscriptionRejectionReason::NotFound);
    };
    (pane.pane_epoch != request.pane_epoch).then_some(PaneSubscriptionRejectionReason::EpochChanged)
}

fn current_apply_result(consumer: &ConsumerState) -> PaneSubscriptionApplyResult {
    PaneSubscriptionApplyResult {
        generation: consumer.generation.unwrap_or(0),
        active_panes: ordered_requests(&consumer.active, &consumer.active_order)
            .iter()
            .map(request_identity)
            .collect(),
        hot_panes: ordered_requests(&consumer.hot, &consumer.hot_order)
            .iter()
            .map(request_identity)
            .collect(),
        rejected: Vec::new(),
        replay: Vec::new(),
    }
}

fn ordered_requests(
    requests: &BTreeMap<String, PaneSubscriptionRequest>,
    order: &[String],
) -> Vec<PaneSubscriptionRequest> {
    order
        .iter()
        .filter_map(|pane_id| requests.get(pane_id).cloned())
        .collect()
}

fn unique_requests(requests: &[PaneSubscriptionRequest]) -> Vec<PaneSubscriptionRequest> {
    let mut seen = HashSet::new();
    requests
        .iter()
        .filter(|request| seen.insert(request.pane_id.clone()))
        .cloned()
        .collect()
}

fn subscription_fingerprint(
    active: &[PaneSubscriptionRequest],
    hot: &[PaneSubscriptionRequest],
) -> String {
    let mut active = active.iter().map(request_fingerprint).collect::<Vec<_>>();
    let mut hot = hot.iter().map(request_fingerprint).collect::<Vec<_>>();
    active.sort();
    hot.sort();
    format!("a={}|h={}", active.join(","), hot.join(","))
}

fn request_fingerprint(request: &PaneSubscriptionRequest) -> String {
    let cursor = request.cursor.as_ref().map_or_else(
        || "-".to_owned(),
        |cursor| format!("{}:{}", bytes_hex(&cursor.pane_epoch), cursor.terminal_seq),
    );
    format!(
        "{}:{}:{cursor}",
        request.pane_id,
        bytes_hex(&request.pane_epoch)
    )
}

fn bytes_hex(bytes: &WireToken) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn request_identity(request: &PaneSubscriptionRequest) -> PaneIdentity {
    PaneIdentity {
        pane_id: request.pane_id.clone(),
        pane_epoch: request.pane_epoch,
    }
}

fn pane_identity(pane: &PaneState) -> PaneIdentity {
    PaneIdentity {
        pane_id: pane.pane_id.clone(),
        pane_epoch: pane.pane_epoch,
    }
}

fn rejection(
    request: &PaneSubscriptionRequest,
    reason: PaneSubscriptionRejectionReason,
) -> PaneSubscriptionRejection {
    PaneSubscriptionRejection {
        pane_id: request.pane_id.clone(),
        pane_epoch: request.pane_epoch,
        reason,
    }
}

fn create_gap(
    pane: &PaneState,
    reason: PaneReplayGapReason,
    expected_pane_epoch: WireToken,
    expected_seq: u64,
) -> PaneReplayGap {
    PaneReplayGap {
        pane_id: pane.pane_id.clone(),
        pane_epoch: pane.pane_epoch,
        reason,
        expected_pane_epoch,
        expected_seq,
        available_seq: pane.latest_seq,
    }
}

fn empty_history_gap(
    pane: &PaneState,
    reason: PaneReplayGapReason,
    expected_pane_epoch: WireToken,
    expected_seq: u64,
) -> PaneHistoryPage {
    PaneHistoryPage {
        pane_id: pane.pane_id.clone(),
        pane_epoch: pane.pane_epoch,
        seq_start: pane.latest_seq,
        seq_end: pane.latest_seq,
        data: Vec::new(),
        next_cursor: None,
        gap: Some(create_gap(pane, reason, expected_pane_epoch, expected_seq)),
    }
}

fn publish_gaps(callbacks: Vec<(GapCallback, PaneReplayGap)>) {
    for (callback, gap) in callbacks {
        let _ = catch_unwind(AssertUnwindSafe(|| callback(&gap)));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn system_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const EPOCH_A: WireToken = [0x11; 16];
    const EPOCH_B: WireToken = [0x22; 16];

    fn request(
        pane_id: &str,
        pane_epoch: WireToken,
        terminal_seq: Option<u64>,
    ) -> PaneSubscriptionRequest {
        PaneSubscriptionRequest {
            pane_id: pane_id.to_owned(),
            pane_epoch,
            cursor: terminal_seq.map(|terminal_seq| PaneTerminalCursor {
                pane_epoch,
                terminal_seq,
            }),
        }
    }

    #[test]
    fn union_caps_replay_and_epoch_gaps_remain_explicit() {
        let now = Arc::new(AtomicU64::new(0));
        let clock = Arc::clone(&now);
        let retention = PaneRetention::with_clock(
            PaneRetentionOptions {
                max_active_panes: 1,
                ..PaneRetentionOptions::default()
            },
            move || clock.load(Ordering::Relaxed),
        );
        retention.reconcile_panes(&[
            PaneIdentity {
                pane_id: "%1".to_owned(),
                pane_epoch: EPOCH_A,
            },
            PaneIdentity {
                pane_id: "%2".to_owned(),
                pane_epoch: EPOCH_B,
            },
        ]);
        let gaps = Arc::new(Mutex::new(Vec::new()));
        let captured_gaps = Arc::clone(&gaps);
        let first = retention
            .attach_consumer(
                PaneRetentionConsumerCallbacks::new(|_| {}).with_gap(move |gap| {
                    lock(&captured_gaps).push(gap.reason);
                }),
            )
            .unwrap();
        let second = retention
            .attach_consumer(PaneRetentionConsumerCallbacks::new(|_| {}))
            .unwrap();
        first
            .apply_subscriptions(1, &[request("%1", EPOCH_A, None)], &[])
            .unwrap();
        assert_eq!(
            second
                .apply_subscriptions(1, &[request("%2", EPOCH_B, None)], &[])
                .unwrap()
                .rejected[0]
                .reason,
            PaneSubscriptionRejectionReason::ResourceExhausted
        );
        retention.ingest("%1", EPOCH_A, b"hello").unwrap();
        retention.reconcile_panes(&[PaneIdentity {
            pane_id: "%1".to_owned(),
            pane_epoch: EPOCH_B,
        }]);
        assert_eq!(*lock(&gaps), [PaneReplayGapReason::EpochChanged]);
    }

    #[test]
    fn byte_and_time_bounds_produce_history_gaps_instead_of_silent_loss() {
        let now = Arc::new(AtomicU64::new(0));
        let clock = Arc::clone(&now);
        let retention = PaneRetention::with_clock(
            PaneRetentionOptions {
                route_grace_ms: 1,
                hot_ttl_ms: 10,
                replay_ttl_ms: 100,
                max_replay_bytes_per_pane: 5,
                ..PaneRetentionOptions::default()
            },
            move || clock.load(Ordering::Relaxed),
        );
        retention.reconcile_panes(&[PaneIdentity {
            pane_id: "%1".to_owned(),
            pane_epoch: EPOCH_A,
        }]);
        let lease = retention
            .attach_consumer(PaneRetentionConsumerCallbacks::new(|_| {}))
            .unwrap();
        lease
            .apply_subscriptions(1, &[request("%1", EPOCH_A, None)], &[])
            .unwrap();
        retention.ingest("%1", EPOCH_A, b"abc").unwrap();
        retention.ingest("%1", EPOCH_A, b"def").unwrap();
        let page = retention
            .read_history(
                "%1",
                Some(&PaneTerminalCursor {
                    pane_epoch: EPOCH_A,
                    terminal_seq: 0,
                }),
                5,
            )
            .unwrap();
        assert_eq!(page.gap.unwrap().reason, PaneReplayGapReason::CacheEvicted);
        assert_eq!(
            retention.stats().evictions_by_reason[&PaneRetentionEvictionReason::ReplayByteLimit],
            1
        );

        drop(lease);
        now.store(1, Ordering::Relaxed);
        retention.sweep(1);
        now.store(11, Ordering::Relaxed);
        retention.sweep(11);
        assert_eq!(retention.stats().cold_panes, 1);
    }
}
