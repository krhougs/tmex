use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use tmex_protocol::{CanonicalHistoryCursor, CanonicalTerminalCursor, WireToken};
use tokio::runtime::Handle;
use tokio::sync::broadcast;

use crate::state::{
    CanonicalDetachHandle, CanonicalFeedRuntime, CanonicalFeedRuntimeListener,
    CanonicalRuntimeError, MetadataProjectionSnapshot as CanonicalMetadataSnapshot,
    PaneDataSegment as CanonicalPaneDataSegment,
    PaneHistoryCursorError as CanonicalHistoryCursorError,
    PaneHistoryCursorErrorReason as CanonicalHistoryCursorErrorReason,
    PaneHistoryPage as CanonicalHistoryPage, PaneIdentity as CanonicalPaneIdentity,
    PaneReplayGap as CanonicalPaneReplayGap, PaneReplayGapReason as CanonicalPaneReplayGapReason,
    PaneReplayPlan as CanonicalPaneReplayPlan,
    PaneRetentionConsumer as CanonicalPaneRetentionConsumer,
    PaneRetentionConsumerCallbacks as CanonicalPaneRetentionCallbacks, PaneRetentionLease,
    PaneScreenCheckpoint as CanonicalScreenCheckpoint,
    PaneSubscriptionApplyResult as CanonicalSubscriptionApplyResult,
    PaneSubscriptionRejection as CanonicalSubscriptionRejection,
    PaneSubscriptionRejectionReason as CanonicalSubscriptionRejectionReason,
    PaneSubscriptionRequest as CanonicalSubscriptionRequest, RuntimeFuture,
};

use super::device_session_runtime::{DeviceSessionRuntime, DeviceSessionRuntimeError};
use super::metadata_projection::{
    MetadataProjectionFlush, MetadataProjectionSnapshot as TmuxMetadataSnapshot,
};
use super::pane_history_reader::{
    CapturedPaneHistoryPage, PaneHistoryCursor, PaneHistoryCursorError,
    PaneHistoryCursorErrorReason,
};
use super::pane_retention::{
    PaneDataSegment, PaneIdentity, PaneReplayGap, PaneReplayGapReason, PaneReplayPlan,
    PaneRetention, PaneRetentionConsumerCallbacks, PaneRetentionConsumerLease,
    PaneScreenCheckpoint, PaneSubscriptionApplyResult, PaneSubscriptionRejection,
    PaneSubscriptionRejectionReason, PaneSubscriptionRequest, PaneTerminalCursor,
};
use super::TmuxRuntimeEvent;

#[derive(Clone)]
pub(super) struct DeviceCanonicalState {
    retention: PaneRetention,
    view: Arc<RwLock<CanonicalView>>,
}

struct CanonicalView {
    closed: bool,
    server_epoch: Option<WireToken>,
    metadata: TmuxMetadataSnapshot,
    panes: HashMap<String, PaneIdentity>,
}

impl DeviceCanonicalState {
    pub(super) fn new(retention: PaneRetention, metadata: TmuxMetadataSnapshot) -> Self {
        Self {
            retention,
            view: Arc::new(RwLock::new(CanonicalView {
                closed: false,
                server_epoch: None,
                metadata,
                panes: HashMap::new(),
            })),
        }
    }

    pub(super) fn retention(&self) -> &PaneRetention {
        &self.retention
    }

    pub(super) fn sync_projection(
        &self,
        server_epoch: Option<WireToken>,
        metadata: TmuxMetadataSnapshot,
        panes: &[PaneIdentity],
    ) {
        let mut view = self
            .view
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        view.server_epoch = server_epoch;
        view.metadata = metadata;
        view.panes = panes
            .iter()
            .map(|pane| (pane.pane_id.clone(), pane.clone()))
            .collect();
    }

    pub(super) fn sync_metadata(
        &self,
        server_epoch: Option<WireToken>,
        metadata: TmuxMetadataSnapshot,
    ) {
        let mut view = self
            .view
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if view.server_epoch != server_epoch {
            view.panes.clear();
        }
        view.server_epoch = server_epoch;
        view.metadata = metadata;
    }

    pub(super) fn close(&self) {
        self.view
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed = true;
    }

    pub(super) fn is_closed(&self) -> bool {
        self.view
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed
    }

    fn server_epoch(&self) -> Option<WireToken> {
        self.view
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .server_epoch
    }

    fn metadata_snapshot(&self) -> CanonicalMetadataSnapshot {
        let metadata = &self
            .view
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .metadata;
        canonical_metadata_snapshot(metadata)
    }

    fn pane_identity(&self, pane_id: &str) -> Option<CanonicalPaneIdentity> {
        self.view
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .panes
            .get(pane_id)
            .map(canonical_pane_identity)
    }
}

#[derive(Clone)]
pub struct DeviceCanonicalRuntime {
    runtime: DeviceSessionRuntime,
}

impl DeviceCanonicalRuntime {
    pub fn new(runtime: DeviceSessionRuntime) -> Result<Self, CanonicalRuntimeError> {
        if runtime.is_terminated() || runtime.canonical.is_closed() {
            return Err(CanonicalRuntimeError::new(
                "device session runtime is closed",
            ));
        }
        Ok(Self { runtime })
    }
}

impl CanonicalFeedRuntime for DeviceCanonicalRuntime {
    fn get_server_epoch(&self) -> Option<WireToken> {
        self.runtime.canonical.server_epoch()
    }

    fn get_metadata_snapshot(&self) -> CanonicalMetadataSnapshot {
        self.runtime.canonical.metadata_snapshot()
    }

    fn get_pane_identity(&self, pane_id: &str) -> Option<CanonicalPaneIdentity> {
        self.runtime.canonical.pane_identity(pane_id)
    }

    fn attach_pane_consumer(
        &self,
        callbacks: CanonicalPaneRetentionCallbacks,
    ) -> Result<PaneRetentionLease, CanonicalRuntimeError> {
        if self.runtime.canonical.is_closed() {
            return Err(CanonicalRuntimeError::new(
                "device session runtime is closed",
            ));
        }
        let on_data = callbacks.on_data;
        let on_gap = callbacks.on_gap;
        let on_asset = callbacks.on_kitty_asset;
        let callbacks = PaneRetentionConsumerCallbacks::new(move |segment| {
            on_data(canonical_data_segment(segment));
        })
        .with_gap(move |gap| {
            on_gap(canonical_replay_gap(gap));
        })
        .with_asset(move |asset| {
            on_asset(asset.clone());
        });
        let lease = self
            .runtime
            .canonical
            .retention()
            .attach_consumer(callbacks)
            .map_err(canonical_error)?;
        Ok(PaneRetentionLease::new(DevicePaneRetentionConsumer {
            lease: Some(lease),
        }))
    }

    fn subscribe(
        &self,
        listener: CanonicalFeedRuntimeListener,
    ) -> Result<CanonicalDetachHandle, CanonicalRuntimeError> {
        let mut events = self.runtime.subscribe();
        if self.runtime.canonical.is_closed() {
            return Err(CanonicalRuntimeError::new(
                "device session runtime is closed",
            ));
        }
        let runtime_handle = Handle::try_current().map_err(|_| {
            CanonicalRuntimeError::new("canonical runtime subscription requires a Tokio runtime")
        })?;
        let canonical = self.runtime.canonical.clone();
        let task = runtime_handle.spawn(async move {
            loop {
                match events.recv().await {
                    Ok(TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Patch(patch))) => {
                        (listener.on_metadata_patch)(patch);
                    }
                    Ok(TmuxRuntimeEvent::Metadata(MetadataProjectionFlush::Rebase(snapshot))) => {
                        (listener.on_metadata_rebase_required)(canonical_metadata_snapshot(
                            &snapshot,
                        ));
                    }
                    Ok(TmuxRuntimeEvent::Closed { .. }) => {
                        (listener.on_close)();
                        break;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        (listener.on_metadata_rebase_required)(canonical.metadata_snapshot());
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        (listener.on_close)();
                        break;
                    }
                }
            }
        });
        let abort = task.abort_handle();
        drop(task);
        Ok(CanonicalDetachHandle::new(move || abort.abort()))
    }

    fn read_pane_history<'a>(
        &'a self,
        pane_id: &'a str,
        before_cursor: Option<CanonicalHistoryCursor>,
        byte_limit: u32,
    ) -> RuntimeFuture<
        'a,
        Result<
            Result<Option<CanonicalHistoryPage>, CanonicalHistoryCursorError>,
            CanonicalRuntimeError,
        >,
    > {
        let runtime = self.runtime.clone();
        let pane_id = pane_id.to_owned();
        let cursor = before_cursor.map(|cursor| PaneHistoryCursor {
            pane_epoch: cursor.pane_epoch,
            history_epoch: cursor.history_epoch,
            before_line: cursor.before_line,
        });
        let byte_limit = usize::try_from(byte_limit).unwrap_or(usize::MAX);
        Box::pin(async move {
            match runtime
                .read_pane_history(&pane_id, cursor, byte_limit)
                .await
            {
                Ok(page) => Ok(Ok(page.map(canonical_history_page))),
                Err(DeviceSessionRuntimeError::History(error)) => {
                    Ok(Err(canonical_history_error(error)))
                }
                Err(error) => Err(canonical_error(error)),
            }
        })
    }

    fn capture_canonical_screen<'a>(
        &'a self,
        pane_id: &'a str,
        byte_limit: u32,
    ) -> RuntimeFuture<'a, Result<Option<CanonicalScreenCheckpoint>, CanonicalRuntimeError>> {
        let runtime = self.runtime.clone();
        let pane_id = pane_id.to_owned();
        let byte_limit = usize::try_from(byte_limit).unwrap_or(usize::MAX);
        Box::pin(async move {
            runtime
                .capture_canonical_screen(&pane_id, byte_limit)
                .await
                .map(|checkpoint| checkpoint.map(canonical_screen_checkpoint))
                .map_err(canonical_error)
        })
    }

    fn send_input_bytes<'a>(
        &'a self,
        pane_id: &'a str,
        data: &'a [u8],
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .enqueue_input_bytes(pane_id, data)
                .await
                .map_err(canonical_error)
        })
    }

    fn send_key_input<'a>(
        &'a self,
        pane_id: &'a str,
        key: tmex_protocol::TerminalKey,
        modifiers: u16,
        action: tmex_protocol::TerminalKeyAction,
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .send_key_input(pane_id, key, modifiers, action)
                .await
                .map_err(canonical_error)
        })
    }

    fn resize_pane<'a>(
        &'a self,
        pane_id: &'a str,
        cols: u16,
        rows: u16,
    ) -> RuntimeFuture<'a, Result<(), CanonicalRuntimeError>> {
        // Canonical ResizePane is the client grid for the owning window, the
        // same as JS runtime.resizePane → resize-window. resize-pane would
        // briefly apply and then snap back to the control client's size.
        Box::pin(async move {
            self.runtime
                .resize_window_for_pane(pane_id, cols, rows)
                .await
                .map_err(canonical_error)
        })
    }
}

struct DevicePaneRetentionConsumer {
    lease: Option<PaneRetentionConsumerLease>,
}

impl CanonicalPaneRetentionConsumer for DevicePaneRetentionConsumer {
    fn apply_subscriptions(
        &mut self,
        generation: u64,
        active_panes: &[CanonicalSubscriptionRequest],
        hot_panes: &[CanonicalSubscriptionRequest],
    ) -> Result<CanonicalSubscriptionApplyResult, CanonicalRuntimeError> {
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| CanonicalRuntimeError::new("pane retention lease is closed"))?;
        let active_panes = active_panes
            .iter()
            .map(tmux_subscription_request)
            .collect::<Vec<_>>();
        let hot_panes = hot_panes
            .iter()
            .map(tmux_subscription_request)
            .collect::<Vec<_>>();
        lease
            .apply_subscriptions(generation, &active_panes, &hot_panes)
            .map(canonical_subscription_result)
            .map_err(canonical_error)
    }

    fn close(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.close();
        }
    }
}

fn canonical_metadata_snapshot(snapshot: &TmuxMetadataSnapshot) -> CanonicalMetadataSnapshot {
    CanonicalMetadataSnapshot {
        metadata_epoch: snapshot.metadata_epoch,
        revision: snapshot.revision,
        records: snapshot.records.clone(),
    }
}

fn canonical_pane_identity(identity: &PaneIdentity) -> CanonicalPaneIdentity {
    CanonicalPaneIdentity {
        pane_id: identity.pane_id.clone(),
        pane_epoch: identity.pane_epoch,
    }
}

fn canonical_data_segment(segment: &PaneDataSegment) -> CanonicalPaneDataSegment {
    CanonicalPaneDataSegment {
        pane_id: segment.pane_id.clone(),
        pane_epoch: segment.pane_epoch,
        seq_start: segment.seq_start,
        seq_end: segment.seq_end,
        data: segment.data.clone(),
    }
}

fn canonical_replay_gap(gap: &PaneReplayGap) -> CanonicalPaneReplayGap {
    CanonicalPaneReplayGap {
        pane_id: gap.pane_id.clone(),
        pane_epoch: gap.pane_epoch,
        reason: match gap.reason {
            PaneReplayGapReason::PaneGap => CanonicalPaneReplayGapReason::PaneGap,
            PaneReplayGapReason::EpochChanged => CanonicalPaneReplayGapReason::EpochChanged,
            PaneReplayGapReason::CacheEvicted => CanonicalPaneReplayGapReason::CacheEvicted,
        },
        expected_pane_epoch: gap.expected_pane_epoch,
        expected_seq: gap.expected_seq,
        available_seq: gap.available_seq,
    }
}

fn canonical_replay_plan(plan: PaneReplayPlan) -> CanonicalPaneReplayPlan {
    CanonicalPaneReplayPlan {
        pane_id: plan.pane_id,
        pane_epoch: plan.pane_epoch,
        segments: plan.segments.iter().map(canonical_data_segment).collect(),
        gap: plan.gap.as_ref().map(canonical_replay_gap),
        needs_screen: plan.needs_screen,
    }
}

fn canonical_rejection(rejection: PaneSubscriptionRejection) -> CanonicalSubscriptionRejection {
    CanonicalSubscriptionRejection {
        pane_id: rejection.pane_id,
        pane_epoch: rejection.pane_epoch,
        reason: match rejection.reason {
            PaneSubscriptionRejectionReason::NotFound => {
                CanonicalSubscriptionRejectionReason::NotFound
            }
            PaneSubscriptionRejectionReason::ResourceExhausted => {
                CanonicalSubscriptionRejectionReason::ResourceExhausted
            }
            PaneSubscriptionRejectionReason::EpochChanged => {
                CanonicalSubscriptionRejectionReason::EpochChanged
            }
        },
    }
}

fn canonical_subscription_result(
    result: PaneSubscriptionApplyResult,
) -> CanonicalSubscriptionApplyResult {
    CanonicalSubscriptionApplyResult {
        generation: result.generation,
        active_panes: result
            .active_panes
            .iter()
            .map(canonical_pane_identity)
            .collect(),
        hot_panes: result
            .hot_panes
            .iter()
            .map(canonical_pane_identity)
            .collect(),
        rejected: result
            .rejected
            .into_iter()
            .map(canonical_rejection)
            .collect(),
        replay: result
            .replay
            .into_iter()
            .map(canonical_replay_plan)
            .collect(),
    }
}

fn tmux_subscription_request(request: &CanonicalSubscriptionRequest) -> PaneSubscriptionRequest {
    PaneSubscriptionRequest {
        pane_id: request.pane_id.clone(),
        pane_epoch: request.pane_epoch,
        cursor: request
            .cursor
            .as_ref()
            .map(|cursor: &CanonicalTerminalCursor| PaneTerminalCursor {
                pane_epoch: cursor.pane_epoch,
                terminal_seq: cursor.terminal_seq,
            }),
    }
}

fn canonical_history_page(page: CapturedPaneHistoryPage) -> CanonicalHistoryPage {
    CanonicalHistoryPage {
        pane_id: page.pane_id,
        pane_epoch: page.pane_epoch,
        history_epoch: page.history_epoch,
        line_start: page.line_start,
        line_end: page.line_end,
        truncated: page.truncated,
        data: page.data,
        next_cursor: page.next_cursor.map(|cursor| CanonicalHistoryCursor {
            pane_epoch: cursor.pane_epoch,
            history_epoch: cursor.history_epoch,
            before_line: cursor.before_line,
        }),
    }
}

pub(super) fn canonical_history_error(
    error: PaneHistoryCursorError,
) -> CanonicalHistoryCursorError {
    CanonicalHistoryCursorError::new(
        match error.reason {
            PaneHistoryCursorErrorReason::EpochChanged => {
                CanonicalHistoryCursorErrorReason::EpochChanged
            }
            PaneHistoryCursorErrorReason::CacheEvicted => {
                CanonicalHistoryCursorErrorReason::CacheEvicted
            }
            PaneHistoryCursorErrorReason::ResourceExhausted => {
                CanonicalHistoryCursorErrorReason::ResourceExhausted
            }
        },
        error.message,
    )
}

fn canonical_screen_checkpoint(checkpoint: PaneScreenCheckpoint) -> CanonicalScreenCheckpoint {
    CanonicalScreenCheckpoint {
        pane_id: checkpoint.pane_id,
        pane_epoch: checkpoint.pane_epoch,
        base_seq: checkpoint.base_seq,
        rows: checkpoint.rows,
        cols: checkpoint.cols,
        modes: checkpoint.modes,
        data: checkpoint.data,
        history_cursor: checkpoint.history_cursor,
        captured_at_ms: checkpoint.captured_at_ms,
    }
}

fn canonical_error(error: impl std::fmt::Display) -> CanonicalRuntimeError {
    CanonicalRuntimeError::new(error.to_string())
}
