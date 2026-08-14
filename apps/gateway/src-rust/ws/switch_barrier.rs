use std::collections::HashMap;

use tmex_protocol::{
    encode_payload, Envelope, LiveResume, MessageKind, SwitchAck, TermHistory, TermOutput,
    WireToken,
};

use super::{LegacyBorshSession, LegacySessionState, SelectTransactionState, SessionProtocolError};

pub const SWITCH_ACK_TIMEOUT_MS: u64 = 1_500;
pub const SWITCH_HISTORY_TIMEOUT_MS: u64 = 1_500;
pub const SWITCH_LIVE_RESUME_DELAY_MS: u64 = 450;

pub trait LegacyFrameSink {
    fn can_send(&mut self) -> bool {
        true
    }

    fn send_batch(&mut self, frames: Vec<Envelope>) -> bool;
    fn mark_stream_gap(&mut self);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchBarrierContext {
    pub device_id: String,
    pub window_id: String,
    pub pane_id: String,
    pub select_token: WireToken,
    pub want_history: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchTimeoutStage {
    Ack,
    History,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwitchBarrierEvent {
    AckSent {
        device_id: String,
    },
    HistorySent {
        device_id: String,
    },
    LiveResumed {
        device_id: String,
    },
    Timeout {
        device_id: String,
        stage: SwitchTimeoutStage,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeadlineStage {
    Ack,
    History,
    LiveResume,
}

#[derive(Clone, Debug)]
struct PendingTransaction {
    context: SwitchBarrierContext,
    deadline: Option<(DeadlineStage, u64)>,
}

#[derive(Debug, Default)]
pub struct SwitchBarrier {
    pending: HashMap<String, PendingTransaction>,
    pending_order: Vec<String>,
}

impl SwitchBarrier {
    pub fn start_transaction(
        &mut self,
        state: &mut LegacySessionState,
        context: SwitchBarrierContext,
        now_ms: u64,
    ) -> bool {
        self.cancel_transaction(state, &context.device_id);
        state.start_select_transaction(
            &context.device_id,
            context.window_id.clone(),
            context.pane_id.clone(),
            context.select_token,
            now_ms,
        );
        let device_id = context.device_id.clone();
        self.pending.insert(
            device_id.clone(),
            PendingTransaction {
                context,
                deadline: Some((
                    DeadlineStage::Ack,
                    now_ms.saturating_add(SWITCH_ACK_TIMEOUT_MS),
                )),
            },
        );
        self.pending_order.push(device_id);
        true
    }

    pub fn send_switch_ack(
        &mut self,
        wire: &mut LegacyBorshSession,
        state: &mut LegacySessionState,
        sink: &mut dyn LegacyFrameSink,
        device_id: &str,
        now_ms: u64,
    ) -> Result<Vec<SwitchBarrierEvent>, SessionProtocolError> {
        let Some(pending) = self.pending.get_mut(device_id) else {
            return Ok(Vec::new());
        };
        if state.select_transaction(device_id).state != SelectTransactionState::Selecting {
            return Ok(Vec::new());
        }
        pending.deadline = None;
        if !state.transition_select_state(device_id, SelectTransactionState::Acked, now_ms) {
            return Ok(Vec::new());
        }
        let context = pending.context.clone();
        let payload = encode_payload(&SwitchAck {
            device_id: device_id.to_owned(),
            window_id: context.window_id,
            pane_id: context.pane_id,
            select_token: context.select_token,
        })?;
        let frame = wire.prepare_outbound_unfragmented(MessageKind::SwitchAck as u16, payload);
        if !sink.send_batch(vec![frame]) {
            sink.mark_stream_gap();
            self.complete_transaction(state, device_id, now_ms);
            return Ok(Vec::new());
        }
        pending.deadline = Some((
            if context.want_history {
                DeadlineStage::History
            } else {
                DeadlineStage::LiveResume
            },
            now_ms.saturating_add(if context.want_history {
                SWITCH_HISTORY_TIMEOUT_MS
            } else {
                SWITCH_LIVE_RESUME_DELAY_MS
            }),
        ));
        Ok(vec![SwitchBarrierEvent::AckSent {
            device_id: device_id.to_owned(),
        }])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn send_term_history(
        &mut self,
        wire: &mut LegacyBorshSession,
        state: &mut LegacySessionState,
        sink: &mut dyn LegacyFrameSink,
        device_id: &str,
        pane_id: &str,
        history_data: &[u8],
        alternate_screen: bool,
        modes: u8,
        now_ms: u64,
    ) -> Result<Vec<SwitchBarrierEvent>, SessionProtocolError> {
        let Some(pending) = self.pending.get_mut(device_id) else {
            return Ok(Vec::new());
        };
        if state.select_transaction(device_id).state != SelectTransactionState::Acked
            || pending.context.pane_id != pane_id
        {
            return Ok(Vec::new());
        }
        pending.deadline = None;
        if !state.transition_select_state(device_id, SelectTransactionState::HistoryApplied, now_ms)
        {
            return Ok(Vec::new());
        }
        let context = pending.context.clone();
        let payload = encode_payload(&TermHistory {
            device_id: device_id.to_owned(),
            pane_id: context.pane_id,
            select_token: context.select_token,
            encoding: 2,
            alternate_screen,
            modes,
            data: history_data.to_vec(),
        })?;
        let frames = wire.prepare_outbound(MessageKind::TermHistory as u16, payload)?;
        if !sink.send_batch(frames) {
            sink.mark_stream_gap();
            self.complete_transaction(state, device_id, now_ms);
            return Ok(Vec::new());
        }
        pending.deadline = Some((
            DeadlineStage::LiveResume,
            now_ms.saturating_add(SWITCH_LIVE_RESUME_DELAY_MS),
        ));
        Ok(vec![SwitchBarrierEvent::HistorySent {
            device_id: device_id.to_owned(),
        }])
    }

    pub fn send_live_resume(
        &mut self,
        wire: &mut LegacyBorshSession,
        state: &mut LegacySessionState,
        sink: &mut dyn LegacyFrameSink,
        device_id: &str,
        expected_token: Option<WireToken>,
        now_ms: u64,
    ) -> Result<Vec<SwitchBarrierEvent>, SessionProtocolError> {
        let Some(pending) = self.pending.get_mut(device_id) else {
            return Ok(Vec::new());
        };
        let select_state = state.select_transaction(device_id).state;
        if !matches!(
            select_state,
            SelectTransactionState::Acked | SelectTransactionState::HistoryApplied
        ) || expected_token.is_some_and(|token| token != pending.context.select_token)
        {
            return Ok(Vec::new());
        }
        pending.deadline = None;
        if !state.transition_select_state(device_id, SelectTransactionState::Live, now_ms) {
            return Ok(Vec::new());
        }
        let context = pending.context.clone();
        let buffered = state.stop_output_buffering(device_id);
        let payload = encode_payload(&LiveResume {
            device_id: device_id.to_owned(),
            pane_id: context.pane_id.clone(),
            select_token: context.select_token,
        })?;
        let frame = wire.prepare_outbound_unfragmented(MessageKind::LiveResume as u16, payload);
        if !sink.send_batch(vec![frame]) {
            sink.mark_stream_gap();
            self.complete_transaction(state, device_id, now_ms);
            return Ok(Vec::new());
        }

        for data in buffered {
            let payload = encode_payload(&TermOutput {
                device_id: device_id.to_owned(),
                pane_id: context.pane_id.clone(),
                encoding: 1,
                data,
            })?;
            let frame = wire.prepare_outbound_unfragmented(MessageKind::TermOutput as u16, payload);
            if !sink.send_batch(vec![frame]) {
                sink.mark_stream_gap();
                break;
            }
        }
        self.complete_transaction(state, device_id, now_ms);
        Ok(vec![SwitchBarrierEvent::LiveResumed {
            device_id: device_id.to_owned(),
        }])
    }

    pub fn poll(
        &mut self,
        wire: &mut LegacyBorshSession,
        state: &mut LegacySessionState,
        sink: &mut dyn LegacyFrameSink,
        now_ms: u64,
    ) -> Result<Vec<SwitchBarrierEvent>, SessionProtocolError> {
        let due: Vec<(String, DeadlineStage, WireToken)> = self
            .pending_order
            .iter()
            .filter_map(|device_id| {
                let pending = self.pending.get(device_id)?;
                let (stage, deadline_ms) = pending.deadline?;
                (now_ms >= deadline_ms)
                    .then(|| (device_id.clone(), stage, pending.context.select_token))
            })
            .collect();
        let mut events = Vec::new();
        for (device_id, stage, token) in due {
            match stage {
                DeadlineStage::Ack => {
                    if self.pending.get(&device_id).is_none_or(|pending| {
                        pending.context.select_token != token
                            || pending.deadline.map(|value| value.0) != Some(DeadlineStage::Ack)
                    }) {
                        continue;
                    }
                    state.transition_select_state(
                        &device_id,
                        SelectTransactionState::SelectFailed,
                        now_ms,
                    );
                    state.stop_output_buffering(&device_id);
                    self.pending.remove(&device_id);
                    self.pending_order
                        .retain(|candidate| candidate != &device_id);
                    events.push(SwitchBarrierEvent::Timeout {
                        device_id,
                        stage: SwitchTimeoutStage::Ack,
                    });
                }
                DeadlineStage::History => {
                    events.extend(self.send_live_resume(
                        wire,
                        state,
                        sink,
                        &device_id,
                        Some(token),
                        now_ms,
                    )?);
                    state.stop_output_buffering(&device_id);
                    events.push(SwitchBarrierEvent::Timeout {
                        device_id,
                        stage: SwitchTimeoutStage::History,
                    });
                }
                DeadlineStage::LiveResume => events.extend(self.send_live_resume(
                    wire,
                    state,
                    sink,
                    &device_id,
                    Some(token),
                    now_ms,
                )?),
            }
        }
        Ok(events)
    }

    pub fn get_transaction_pane_id(
        &mut self,
        state: &mut LegacySessionState,
        device_id: &str,
    ) -> Option<&str> {
        if state.select_transaction(device_id).state != SelectTransactionState::Acked {
            return None;
        }
        self.pending
            .get(device_id)
            .map(|pending| pending.context.pane_id.as_str())
    }

    pub fn get_select_token(&self, device_id: &str) -> Option<WireToken> {
        self.pending
            .get(device_id)
            .map(|pending| pending.context.select_token)
    }

    pub fn validate_token(&self, device_id: &str, token: &WireToken) -> bool {
        self.get_select_token(device_id).as_ref() == Some(token)
    }

    pub fn cancel_transaction(&mut self, state: &mut LegacySessionState, device_id: &str) {
        if self.pending.remove(device_id).is_some() {
            self.pending_order
                .retain(|candidate| candidate != device_id);
            state.stop_output_buffering(device_id);
        }
    }

    pub fn cleanup(&mut self, state: &mut LegacySessionState) {
        let device_ids: Vec<String> = self.pending.keys().cloned().collect();
        for device_id in device_ids {
            self.cancel_transaction(state, &device_id);
        }
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.pending
            .values()
            .filter_map(|pending| pending.deadline.map(|value| value.1))
            .min()
    }

    pub fn is_pending(&self, device_id: &str) -> bool {
        self.pending.contains_key(device_id)
    }

    fn complete_transaction(
        &mut self,
        state: &mut LegacySessionState,
        device_id: &str,
        now_ms: u64,
    ) {
        if state.transition_select_state(device_id, SelectTransactionState::Stable, now_ms) {
            self.pending.remove(device_id);
            self.pending_order
                .retain(|candidate| candidate != device_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use tmex_protocol::{decode_payload, MessageKind, TermHistory, TermOutput};

    use super::*;
    use crate::ws::{OutputGateState, SessionConfig};

    #[derive(Default)]
    struct Sink {
        batches: Vec<Vec<Envelope>>,
        outcomes: VecDeque<bool>,
        gaps: usize,
    }

    impl LegacyFrameSink for Sink {
        fn send_batch(&mut self, frames: Vec<Envelope>) -> bool {
            self.batches.push(frames);
            self.outcomes.pop_front().unwrap_or(true)
        }

        fn mark_stream_gap(&mut self) {
            self.gaps += 1;
        }
    }

    fn context(want_history: bool) -> SwitchBarrierContext {
        SwitchBarrierContext {
            device_id: "device".into(),
            window_id: "@1".into(),
            pane_id: "%1".into(),
            select_token: [7; 16],
            want_history,
            cols: None,
            rows: None,
        }
    }

    #[test]
    fn ack_history_live_and_buffered_output_keep_wire_order() {
        let mut wire = LegacyBorshSession::new(SessionConfig::default(), 0);
        let mut state = LegacySessionState::new(0);
        let mut barrier = SwitchBarrier::default();
        let mut sink = Sink::default();

        barrier.start_transaction(&mut state, context(true), 0);
        state.buffer_output("device", b"live");
        barrier
            .send_switch_ack(&mut wire, &mut state, &mut sink, "device", 1)
            .expect("ack");
        barrier
            .send_term_history(
                &mut wire, &mut state, &mut sink, "device", "%1", b"history", false, 3, 2,
            )
            .expect("history");
        barrier
            .poll(&mut wire, &mut state, &mut sink, 452)
            .expect("live resume");

        let kinds: Vec<u16> = sink
            .batches
            .iter()
            .flat_map(|batch| batch.iter().map(|envelope| envelope.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                MessageKind::SwitchAck as u16,
                MessageKind::TermHistory as u16,
                MessageKind::LiveResume as u16,
                MessageKind::TermOutput as u16,
            ]
        );
        let history: TermHistory = decode_payload(&sink.batches[1][0].payload).expect("history");
        assert_eq!(history.encoding, 2);
        assert_eq!(history.select_token, [7; 16]);
        let output: TermOutput = decode_payload(&sink.batches[3][0].payload).expect("output");
        assert_eq!(output.pane_id, "%1");
        assert_eq!(output.data, b"live");
        assert_eq!(
            state.select_transaction("device").state,
            SelectTransactionState::Stable
        );
        assert!(!barrier.is_pending("device"));
    }

    #[test]
    fn failed_ack_marks_gap_and_preserves_the_legacy_stuck_acked_gate() {
        let mut wire = LegacyBorshSession::new(SessionConfig::default(), 0);
        let mut state = LegacySessionState::new(0);
        let mut barrier = SwitchBarrier::default();
        let mut sink = Sink {
            outcomes: VecDeque::from([false]),
            ..Sink::default()
        };

        barrier.start_transaction(&mut state, context(true), 0);
        barrier
            .send_switch_ack(&mut wire, &mut state, &mut sink, "device", 1)
            .expect("ack encode");

        assert_eq!(sink.gaps, 1);
        assert_eq!(
            state.select_transaction("device").state,
            SelectTransactionState::Acked
        );
        assert_eq!(
            state.output_gate("device").state,
            OutputGateState::Buffering
        );
        assert!(barrier.is_pending("device"));
        assert_eq!(barrier.next_deadline_ms(), None);
    }

    #[test]
    fn barrier_control_and_buffered_live_frames_are_never_chunked() {
        let mut wire = LegacyBorshSession::new(
            SessionConfig {
                server_max_frame_bytes: 64,
                ..SessionConfig::default()
            },
            0,
        );
        let mut state = LegacySessionState::new(0);
        let mut barrier = SwitchBarrier::default();
        let mut sink = Sink::default();

        barrier.start_transaction(&mut state, context(false), 0);
        state.buffer_output("device", &[5; 128]);
        barrier
            .send_switch_ack(&mut wire, &mut state, &mut sink, "device", 1)
            .expect("ack");
        barrier
            .poll(
                &mut wire,
                &mut state,
                &mut sink,
                1 + SWITCH_LIVE_RESUME_DELAY_MS,
            )
            .expect("resume");

        assert_eq!(sink.batches.len(), 3);
        assert_eq!(sink.batches[0][0].kind, MessageKind::SwitchAck as u16);
        assert_eq!(sink.batches[1][0].kind, MessageKind::LiveResume as u16);
        assert_eq!(sink.batches[2][0].kind, MessageKind::TermOutput as u16);
        assert_eq!(sink.batches[2].len(), 1);
    }

    #[test]
    fn ack_and_history_timeouts_match_the_old_fallbacks() {
        let mut wire = LegacyBorshSession::new(SessionConfig::default(), 0);
        let mut state = LegacySessionState::new(0);
        let mut barrier = SwitchBarrier::default();
        let mut sink = Sink::default();

        barrier.start_transaction(&mut state, context(true), 0);
        let events = barrier
            .poll(&mut wire, &mut state, &mut sink, SWITCH_ACK_TIMEOUT_MS)
            .expect("ack timeout");
        assert_eq!(
            events,
            vec![SwitchBarrierEvent::Timeout {
                device_id: "device".into(),
                stage: SwitchTimeoutStage::Ack,
            }]
        );
        assert_eq!(
            state.select_transaction("device").state,
            SelectTransactionState::SelectFailed
        );

        barrier.start_transaction(&mut state, context(true), 2_000);
        barrier
            .send_switch_ack(&mut wire, &mut state, &mut sink, "device", 2_000)
            .expect("ack");
        let events = barrier
            .poll(
                &mut wire,
                &mut state,
                &mut sink,
                2_000 + SWITCH_HISTORY_TIMEOUT_MS,
            )
            .expect("history timeout");
        assert!(events.contains(&SwitchBarrierEvent::LiveResumed {
            device_id: "device".into(),
        }));
        assert!(events.contains(&SwitchBarrierEvent::Timeout {
            device_id: "device".into(),
            stage: SwitchTimeoutStage::History,
        }));
    }
}
