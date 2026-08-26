use super::{
    CHUNK_PAYLOAD_OVERHEAD_BYTES, ENVELOPE_OVERHEAD_BYTES, MAX_CHUNKS_PER_MESSAGE,
    MAX_CHUNK_STREAM_BYTES,
};

pub const GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES: usize = 1_048_576;
pub const GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS: u64 = 5_000;
pub const GATEWAY_WS_MAX_ATOMIC_BATCH_BYTES: usize = MAX_CHUNK_STREAM_BYTES
    + MAX_CHUNKS_PER_MESSAGE as usize * (ENVELOPE_OVERHEAD_BYTES + CHUNK_PAYLOAD_OVERHEAD_BYTES);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackpressureConfig {
    pub queued_bytes_limit: usize,
    pub atomic_batch_bytes_limit: usize,
    pub timeout_ms: u64,
}

impl Default for BackpressureConfig {
    fn default() -> Self {
        Self {
            queued_bytes_limit: GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES,
            atomic_batch_bytes_limit: GATEWAY_WS_MAX_ATOMIC_BATCH_BYTES,
            timeout_ms: GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    Sent,
    Backpressured,
    Dropped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackpressureTermination {
    BackpressureGap,
    BackpressureTimeout,
    BackpressureLimit,
    DroppedFrame,
    OversizedFrame,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackpressureAction {
    AbortTransport(BackpressureTermination),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Available,
    Backpressured {
        deadline_ms: u64,
        skipped_frame: bool,
    },
    Unavailable,
}

#[derive(Debug)]
pub struct BackpressureGuard {
    config: BackpressureConfig,
    state: State,
}

impl Default for BackpressureGuard {
    fn default() -> Self {
        Self::new(BackpressureConfig::default())
    }
}

impl BackpressureGuard {
    pub fn new(config: BackpressureConfig) -> Self {
        Self {
            config,
            state: State::Available,
        }
    }

    pub fn can_send(&mut self) -> bool {
        match &mut self.state {
            State::Available => true,
            State::Backpressured { skipped_frame, .. } => {
                *skipped_frame = true;
                false
            }
            State::Unavailable => false,
        }
    }

    pub fn validate_frame_lengths(
        &mut self,
        frame_lengths: impl IntoIterator<Item = usize>,
        negotiated_max_frame_bytes: usize,
    ) -> Option<BackpressureAction> {
        if frame_lengths
            .into_iter()
            .any(|length| length > negotiated_max_frame_bytes)
        {
            return self.abort(BackpressureTermination::OversizedFrame);
        }
        None
    }

    pub fn observe_buffered_amount(&mut self, queued_bytes: usize) -> Option<BackpressureAction> {
        if queued_bytes >= self.config.queued_bytes_limit {
            return self.abort(BackpressureTermination::BackpressureLimit);
        }
        None
    }

    pub fn observe_buffered_batch(
        &mut self,
        queued_bytes: usize,
        batch_bytes: usize,
    ) -> Option<BackpressureAction> {
        if batch_bytes > self.config.atomic_batch_bytes_limit {
            return self.abort(BackpressureTermination::BackpressureLimit);
        }
        if queued_bytes == 0 {
            return None;
        }
        let buffered_limit = if batch_bytes > self.config.queued_bytes_limit {
            self.config.atomic_batch_bytes_limit
        } else {
            self.config.queued_bytes_limit
        };
        if queued_bytes.saturating_add(batch_bytes) >= buffered_limit {
            return self.abort(BackpressureTermination::BackpressureLimit);
        }
        None
    }

    pub fn record_send(
        &mut self,
        outcome: SendOutcome,
        has_remaining_frames: bool,
        now_ms: u64,
    ) -> Option<BackpressureAction> {
        if matches!(self.state, State::Unavailable) {
            return None;
        }

        match outcome {
            SendOutcome::Sent => None,
            SendOutcome::Backpressured => {
                self.state = State::Backpressured {
                    deadline_ms: now_ms.saturating_add(self.config.timeout_ms),
                    skipped_frame: has_remaining_frames,
                };
                None
            }
            SendOutcome::Dropped => self.abort(BackpressureTermination::DroppedFrame),
        }
    }

    pub fn mark_stream_gap(&mut self) {
        if let State::Backpressured { skipped_frame, .. } = &mut self.state {
            *skipped_frame = true;
        }
    }

    pub fn handle_drain(&mut self) -> Option<BackpressureAction> {
        let State::Backpressured { skipped_frame, .. } = self.state else {
            return None;
        };
        self.state = State::Available;
        if skipped_frame {
            return self.abort(BackpressureTermination::BackpressureGap);
        }
        None
    }

    pub fn poll(&mut self, now_ms: u64) -> Option<BackpressureAction> {
        let State::Backpressured { deadline_ms, .. } = self.state else {
            return None;
        };
        if now_ms >= deadline_ms {
            return self.abort(BackpressureTermination::BackpressureTimeout);
        }
        None
    }

    pub fn is_backpressured(&self) -> bool {
        matches!(self.state, State::Backpressured { .. })
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self.state, State::Unavailable)
    }

    pub fn forget(&mut self) {
        self.state = State::Available;
    }

    fn abort(&mut self, reason: BackpressureTermination) -> Option<BackpressureAction> {
        if matches!(self.state, State::Unavailable) {
            return None;
        }
        self.state = State::Unavailable;
        Some(BackpressureAction::AbortTransport(reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_recovers_only_when_no_frame_was_skipped() {
        let mut guard = BackpressureGuard::default();
        assert!(guard.can_send());
        assert_eq!(
            guard.record_send(SendOutcome::Backpressured, false, 10),
            None
        );
        assert_eq!(guard.handle_drain(), None);
        assert!(guard.can_send());

        assert_eq!(
            guard.record_send(SendOutcome::Backpressured, false, 20),
            None
        );
        assert!(!guard.can_send());
        assert_eq!(
            guard.handle_drain(),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureGap
            ))
        );
        assert!(guard.is_unavailable());
    }

    #[test]
    fn partial_batch_and_timeout_abort_without_a_close_frame() {
        let mut guard = BackpressureGuard::default();
        assert_eq!(guard.record_send(SendOutcome::Backpressured, true, 0), None);
        assert_eq!(
            guard.handle_drain(),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureGap
            ))
        );

        guard.forget();
        assert_eq!(
            guard.record_send(SendOutcome::Backpressured, false, 1),
            None
        );
        assert_eq!(guard.poll(5_000), None);
        assert_eq!(
            guard.poll(5_001),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureTimeout
            ))
        );
    }

    #[test]
    fn dropped_oversized_and_full_queue_frames_abort_immediately() {
        let mut guard = BackpressureGuard::default();
        assert_eq!(
            guard.record_send(SendOutcome::Dropped, false, 0),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::DroppedFrame
            ))
        );

        guard.forget();
        assert_eq!(
            guard.validate_frame_lengths([129], 128),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::OversizedFrame
            ))
        );

        guard.forget();
        assert_eq!(
            guard.observe_buffered_amount(GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureLimit
            ))
        );

        guard.forget();
        assert_eq!(
            guard.observe_buffered_batch(0, GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES + 1),
            None,
            "one bounded chunk batch must remain usable on an empty queue"
        );

        guard.forget();
        assert_eq!(
            guard.observe_buffered_batch(64 * 1024, 6 * 1024 * 1024),
            None,
            "a bounded first-screen transaction may share the atomic queue budget"
        );

        guard.forget();
        assert_eq!(
            guard.observe_buffered_batch(2 * 1024 * 1024, 7 * 1024 * 1024),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureLimit
            ))
        );

        guard.forget();
        assert_eq!(
            guard.observe_buffered_batch(0, GATEWAY_WS_MAX_ATOMIC_BATCH_BYTES + 1),
            Some(BackpressureAction::AbortTransport(
                BackpressureTermination::BackpressureLimit
            ))
        );
    }
}
