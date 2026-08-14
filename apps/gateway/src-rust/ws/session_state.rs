use std::collections::{HashMap, VecDeque};

use tmex_protocol::WireToken;

pub const OUTPUT_GATE_MAX_ITEMS: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WsConnectionState {
    Idle,
    Connecting,
    HelloNegotiating,
    Ready,
    ReconnectBackoff,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WsConnectionContext {
    pub state: WsConnectionState,
    pub connected_at_ms: Option<u64>,
    pub last_activity_at_ms: u64,
    pub seq: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceConnectionState {
    Detached,
    Connecting,
    Connected,
    Failed,
    Disconnecting,
    Reconnecting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceConnectionContext {
    pub state: DeviceConnectionState,
    pub device_id: String,
    pub connected_at_ms: Option<u64>,
    pub last_error: Option<String>,
    pub reconnect_attempts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectTransactionState {
    Stable,
    Selecting,
    Acked,
    HistoryApplied,
    Live,
    SelectFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectTransactionContext {
    pub state: SelectTransactionState,
    pub device_id: String,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    pub select_token: Option<WireToken>,
    pub started_at_ms: u64,
    pub acked_at_ms: Option<u64>,
    pub history_applied_at_ms: Option<u64>,
    pub live_resumed_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputGateState {
    Flowing,
    Buffering,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputGateContext {
    pub state: OutputGateState,
    pub buffer: VecDeque<Vec<u8>>,
    pub max_buffer_size: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThrottleContext {
    pub last_at_ms: u64,
    pub throttle_seconds: u64,
}

#[derive(Debug)]
pub struct LegacySessionState {
    pub ws_connection: WsConnectionContext,
    pub device_connections: HashMap<String, DeviceConnectionContext>,
    pub select_transactions: HashMap<String, SelectTransactionContext>,
    pub output_gates: HashMap<String, OutputGateContext>,
    bell_throttles: HashMap<String, ThrottleContext>,
    notification_throttles: HashMap<String, ThrottleContext>,
}

impl LegacySessionState {
    pub fn new(now_ms: u64) -> Self {
        Self {
            ws_connection: WsConnectionContext {
                state: WsConnectionState::Idle,
                connected_at_ms: None,
                last_activity_at_ms: now_ms,
                seq: 0,
            },
            device_connections: HashMap::new(),
            select_transactions: HashMap::new(),
            output_gates: HashMap::new(),
            bell_throttles: HashMap::new(),
            notification_throttles: HashMap::new(),
        }
    }

    pub fn transition_ws_state(&mut self, next: WsConnectionState, now_ms: u64) -> bool {
        use WsConnectionState as State;
        let valid = matches!(
            (self.ws_connection.state, next),
            (State::Idle, State::Connecting | State::Closed)
                | (
                    State::Connecting,
                    State::HelloNegotiating | State::ReconnectBackoff | State::Closed
                )
                | (
                    State::HelloNegotiating,
                    State::Ready | State::ReconnectBackoff | State::Closed
                )
                | (State::Ready, State::ReconnectBackoff | State::Closed)
                | (State::ReconnectBackoff, State::Connecting | State::Closed)
        );
        if !valid {
            return false;
        }
        self.ws_connection.state = next;
        if next == State::Ready {
            self.ws_connection.connected_at_ms = Some(now_ms);
        }
        true
    }

    pub fn update_last_activity(&mut self, now_ms: u64) {
        self.ws_connection.last_activity_at_ms = now_ms;
    }

    pub fn increment_seq(&mut self) -> u32 {
        self.ws_connection.seq = match self.ws_connection.seq {
            u32::MAX => 1,
            value => value + 1,
        };
        self.ws_connection.seq
    }

    pub fn device_connection(&mut self, device_id: &str) -> &mut DeviceConnectionContext {
        self.device_connections
            .entry(device_id.to_owned())
            .or_insert_with(|| DeviceConnectionContext {
                state: DeviceConnectionState::Detached,
                device_id: device_id.to_owned(),
                connected_at_ms: None,
                last_error: None,
                reconnect_attempts: 0,
            })
    }

    pub fn transition_device_state(
        &mut self,
        device_id: &str,
        next: DeviceConnectionState,
        now_ms: u64,
    ) -> bool {
        use DeviceConnectionState as State;
        let context = self.device_connection(device_id);
        let valid = matches!(
            (context.state, next),
            (State::Detached, State::Connecting)
                | (State::Connecting, State::Connected | State::Failed)
                | (State::Connected, State::Disconnecting | State::Reconnecting)
                | (State::Failed, State::Connecting)
                | (State::Disconnecting, State::Detached)
                | (State::Reconnecting, State::Connected | State::Failed)
        );
        if !valid {
            return false;
        }
        context.state = next;
        match next {
            State::Connected => {
                context.connected_at_ms = Some(now_ms);
                context.reconnect_attempts = 0;
                context.last_error = None;
            }
            State::Failed => {
                context.reconnect_attempts = context.reconnect_attempts.saturating_add(1)
            }
            _ => {}
        }
        true
    }

    pub fn select_transaction(&mut self, device_id: &str) -> &mut SelectTransactionContext {
        self.select_transactions
            .entry(device_id.to_owned())
            .or_insert_with(|| SelectTransactionContext {
                state: SelectTransactionState::Stable,
                device_id: device_id.to_owned(),
                window_id: None,
                pane_id: None,
                select_token: None,
                started_at_ms: 0,
                acked_at_ms: None,
                history_applied_at_ms: None,
                live_resumed_at_ms: None,
            })
    }

    pub fn start_select_transaction(
        &mut self,
        device_id: &str,
        window_id: String,
        pane_id: String,
        select_token: WireToken,
        now_ms: u64,
    ) {
        let context = self.select_transaction(device_id);
        context.state = SelectTransactionState::Selecting;
        context.window_id = Some(window_id);
        context.pane_id = Some(pane_id);
        context.select_token = Some(select_token);
        context.started_at_ms = now_ms;
        context.acked_at_ms = None;
        context.history_applied_at_ms = None;
        context.live_resumed_at_ms = None;
        self.start_output_buffering(device_id);
    }

    pub fn transition_select_state(
        &mut self,
        device_id: &str,
        next: SelectTransactionState,
        now_ms: u64,
    ) -> bool {
        use SelectTransactionState as State;
        let context = self.select_transaction(device_id);
        let valid = matches!(
            (context.state, next),
            (State::Stable, State::Selecting)
                | (State::Selecting, State::Acked | State::SelectFailed)
                | (
                    State::Acked,
                    State::HistoryApplied | State::Live | State::SelectFailed
                )
                | (State::HistoryApplied, State::Live | State::SelectFailed)
                | (State::Live, State::Stable | State::Selecting)
                | (State::SelectFailed, State::Stable | State::Selecting)
        );
        if !valid {
            return false;
        }
        context.state = next;
        match next {
            State::Acked => context.acked_at_ms = Some(now_ms),
            State::HistoryApplied => context.history_applied_at_ms = Some(now_ms),
            State::Live => context.live_resumed_at_ms = Some(now_ms),
            State::Stable => context.select_token = None,
            _ => {}
        }
        true
    }

    pub fn output_gate(&mut self, device_id: &str) -> &mut OutputGateContext {
        self.output_gates
            .entry(device_id.to_owned())
            .or_insert_with(|| OutputGateContext {
                state: OutputGateState::Flowing,
                buffer: VecDeque::new(),
                max_buffer_size: OUTPUT_GATE_MAX_ITEMS,
            })
    }

    pub fn start_output_buffering(&mut self, device_id: &str) {
        let gate = self.output_gate(device_id);
        gate.state = OutputGateState::Buffering;
        gate.buffer.clear();
    }

    pub fn stop_output_buffering(&mut self, device_id: &str) -> Vec<Vec<u8>> {
        let gate = self.output_gate(device_id);
        gate.state = OutputGateState::Flowing;
        gate.buffer.drain(..).collect()
    }

    pub fn buffer_output(&mut self, device_id: &str, data: &[u8]) -> bool {
        let gate = self.output_gate(device_id);
        if gate.state != OutputGateState::Buffering {
            return false;
        }
        if gate.buffer.len() >= gate.max_buffer_size {
            gate.buffer.pop_front();
        }
        gate.buffer.push_back(data.to_vec());
        true
    }

    pub fn is_buffering(&mut self, device_id: &str) -> bool {
        self.output_gate(device_id).state == OutputGateState::Buffering
    }

    pub fn should_allow_bell(
        &mut self,
        device_id: &str,
        pane_id: &str,
        throttle_seconds: u64,
        now_ms: u64,
    ) -> bool {
        let key = format!("{device_id}:{pane_id}");
        should_allow(&mut self.bell_throttles, key, throttle_seconds, now_ms)
    }

    pub fn should_allow_notification(
        &mut self,
        device_id: &str,
        pane_id: &str,
        source: &str,
        throttle_seconds: u64,
        now_ms: u64,
    ) -> bool {
        let key = format!("{device_id}:{pane_id}:{source}");
        should_allow(
            &mut self.notification_throttles,
            key,
            throttle_seconds,
            now_ms,
        )
    }

    pub fn cleanup_device(&mut self, device_id: &str) {
        self.device_connections.remove(device_id);
        self.select_transactions.remove(device_id);
        self.output_gates.remove(device_id);
        let prefix = format!("{device_id}:");
        self.bell_throttles
            .retain(|key, _| !key.starts_with(&prefix));
        self.notification_throttles
            .retain(|key, _| !key.starts_with(&prefix));
    }
}

fn should_allow(
    contexts: &mut HashMap<String, ThrottleContext>,
    key: String,
    throttle_seconds: u64,
    now_ms: u64,
) -> bool {
    let context = contexts.entry(key).or_insert(ThrottleContext {
        last_at_ms: 0,
        throttle_seconds,
    });
    if now_ms.saturating_sub(context.last_at_ms) < throttle_seconds.saturating_mul(1_000) {
        return false;
    }
    context.last_at_ms = now_ms;
    context.throttle_seconds = throttle_seconds;
    true
}
