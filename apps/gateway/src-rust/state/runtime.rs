use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tmex_protocol::{
    CanonicalHistoryCursor, CanonicalTerminalCursor, SourceMetadataPatch, SourceMetadataRecord,
    WireToken,
};

pub type RuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type CanonicalTask = RuntimeFuture<'static, ()>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalRuntimeError {
    pub message: String,
}

impl CanonicalRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CanonicalRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CanonicalRuntimeError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetadataProjectionSnapshot {
    pub metadata_epoch: WireToken,
    pub revision: u64,
    pub records: Vec<SourceMetadataRecord>,
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

#[derive(Clone, Debug)]
pub enum KittyGraphicsAsset {
    Image {
        pane_id: String,
        pane_epoch: WireToken,
        image_id: u32,
        width: u32,
        height: u32,
        format: u8,
        data: Vec<u8>,
    },
    Placement {
        pane_id: String,
        pane_epoch: WireToken,
        placement_id: u32,
        image_id: u32,
        src_x: u32,
        src_y: u32,
        src_width: u32,
        src_height: u32,
        columns: u16,
        rows: u16,
        x_offset: u16,
        y_offset: u16,
        z_index: i32,
    },
    Delete {
        pane_id: String,
        pane_epoch: WireToken,
        image_id: Option<u32>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneReplayGapReason {
    PaneGap,
    EpochChanged,
    CacheEvicted,
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
pub struct PaneSubscriptionRequest {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub cursor: Option<CanonicalTerminalCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneSubscriptionRejectionReason {
    NotFound,
    ResourceExhausted,
    EpochChanged,
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
    pub history_epoch: WireToken,
    pub line_start: u32,
    pub line_end: u32,
    pub truncated: bool,
    pub data: Vec<u8>,
    pub next_cursor: Option<CanonicalHistoryCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneHistoryCursorErrorReason {
    EpochChanged,
    CacheEvicted,
    ResourceExhausted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneHistoryCursorError {
    pub reason: PaneHistoryCursorErrorReason,
    pub message: String,
}

impl PaneHistoryCursorError {
    pub fn new(reason: PaneHistoryCursorErrorReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl fmt::Display for PaneHistoryCursorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PaneHistoryCursorError {}

#[derive(Clone)]
pub struct PaneRetentionConsumerCallbacks {
    pub on_data: Arc<dyn Fn(PaneDataSegment) + Send + Sync>,
    pub on_gap: Arc<dyn Fn(PaneReplayGap) + Send + Sync>,
    pub on_kitty_asset: Arc<dyn Fn(KittyGraphicsAsset) + Send + Sync>,
}

pub trait PaneRetentionConsumer: Send {
    fn apply_subscriptions(
        &mut self,
        generation: u64,
        active_panes: &[PaneSubscriptionRequest],
        hot_panes: &[PaneSubscriptionRequest],
    ) -> Result<PaneSubscriptionApplyResult, CanonicalRuntimeError>;

    fn close(&mut self);
}

pub struct PaneRetentionLease {
    consumer: Option<Box<dyn PaneRetentionConsumer>>,
}

impl PaneRetentionLease {
    pub fn new(consumer: impl PaneRetentionConsumer + 'static) -> Self {
        Self {
            consumer: Some(Box::new(consumer)),
        }
    }

    pub fn apply_subscriptions(
        &mut self,
        generation: u64,
        active_panes: &[PaneSubscriptionRequest],
        hot_panes: &[PaneSubscriptionRequest],
    ) -> Result<PaneSubscriptionApplyResult, CanonicalRuntimeError> {
        self.consumer
            .as_mut()
            .ok_or_else(|| CanonicalRuntimeError::new("pane retention lease is closed"))?
            .apply_subscriptions(generation, active_panes, hot_panes)
    }

    pub fn close(&mut self) {
        if let Some(mut consumer) = self.consumer.take() {
            consumer.close();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.consumer.is_none()
    }
}

impl Drop for PaneRetentionLease {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct CanonicalDetachHandle {
    detach: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl CanonicalDetachHandle {
    pub fn new(detach: impl FnOnce() + Send + 'static) -> Self {
        Self {
            detach: Mutex::new(Some(Box::new(detach))),
        }
    }

    pub fn detached() -> Self {
        Self {
            detach: Mutex::new(None),
        }
    }

    pub fn close(&self) {
        let detach = self
            .detach
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(detach) = detach {
            detach();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.detach
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none()
    }
}

impl Drop for CanonicalDetachHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Clone)]
pub struct CanonicalFeedRuntimeListener {
    pub on_metadata_patch: Arc<dyn Fn(SourceMetadataPatch) + Send + Sync>,
    pub on_metadata_rebase_required: Arc<dyn Fn(MetadataProjectionSnapshot) + Send + Sync>,
    pub on_close: Arc<dyn Fn() + Send + Sync>,
}

pub trait CanonicalFeedRuntime: Send + Sync {
    fn get_server_epoch(&self) -> Option<WireToken>;

    fn get_metadata_snapshot(&self) -> MetadataProjectionSnapshot;

    fn get_pane_identity(&self, pane_id: &str) -> Option<PaneIdentity>;

    fn attach_pane_consumer(
        &self,
        callbacks: PaneRetentionConsumerCallbacks,
    ) -> Result<PaneRetentionLease, CanonicalRuntimeError>;

    fn subscribe(
        &self,
        listener: CanonicalFeedRuntimeListener,
    ) -> Result<CanonicalDetachHandle, CanonicalRuntimeError>;

    fn read_pane_history<'a>(
        &'a self,
        pane_id: &'a str,
        before_cursor: Option<CanonicalHistoryCursor>,
        byte_limit: u32,
    ) -> RuntimeFuture<
        'a,
        Result<Result<Option<PaneHistoryPage>, PaneHistoryCursorError>, CanonicalRuntimeError>,
    >;

    fn capture_canonical_screen<'a>(
        &'a self,
        pane_id: &'a str,
        byte_limit: u32,
    ) -> RuntimeFuture<'a, Result<Option<PaneScreenCheckpoint>, CanonicalRuntimeError>>;

    fn send_input_bytes<'a>(
        &'a self,
        pane_id: &'a str,
        data: &'a [u8],
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>>;

    fn send_key_input<'a>(
        &'a self,
        pane_id: &'a str,
        key: tmex_protocol::TerminalKey,
        modifiers: u16,
        action: tmex_protocol::TerminalKeyAction,
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>>;

    fn resize_pane<'a>(
        &'a self,
        pane_id: &'a str,
        cols: u16,
        rows: u16,
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>>;
}
