use std::collections::{HashMap, HashSet};

use tmex_protocol::{
    decode_payload, encode_canonical_event, encode_payload, AgentEvent, AgentSubscribe,
    AgentUnsubscribe, CanonicalEvent, ClipboardWrite, DeviceConnect, DeviceConnected,
    DeviceDisconnect, DeviceDisconnected, DeviceEvent, Envelope, ErrorPayload, EventNotifyS2c,
    MessageKind, ProtocolErrorCode, SettingsUpdateS2c, SiteThemeUpdateC2s, SiteThemeUpdateS2c,
    StateSnapshot, StateSnapshotDiff, TermHistory, TermInput, TermKeyInput, TermOutput, TermPaste,
    TermResize, TmuxApplyStackedLayout, TmuxBreakPane, TmuxClosePane, TmuxCloseWindow,
    TmuxCreateWindow, TmuxEvent, TmuxFetchPaneHistory, TmuxFocusPane, TmuxMovePane, TmuxRenamePane,
    TmuxRenameWindow, TmuxReorderPanes, TmuxReorderWindows, TmuxResizePane, TmuxSelect,
    TmuxSelectWindow, TmuxSetWindowStyle, TmuxSplitPane, TmuxSubscribePanes, TmuxWindowCreated,
    WatchEvent, WireToken, AGENT_EVENT_SYNC, SITE_THEME_DARK, SITE_THEME_LIGHT,
    TERMINAL_INPUT_MAX_BYTES, TERMINAL_PASTE_MAX_BYTES,
};

use super::{
    DeviceConnectionState, LegacyBorshSession, LegacyFrameSink, LegacySessionState, SessionAction,
    SessionConfig, SessionProtocolError, SwitchBarrier, SwitchBarrierContext, SwitchBarrierEvent,
    TerminalOutputBatch, TerminalOutputBatcher, WsConnectionState,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedPaneHistory {
    pub data: Vec<u8>,
    pub alternate_screen: bool,
    pub modes: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacySplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyPanePosition {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyTmuxEventDelivery {
    Broadcast,
    Bell {
        pane_id: String,
        throttle_seconds: u64,
    },
    Notification {
        pane_id: String,
        source: String,
        throttle_seconds: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyRuntimeCommand {
    ConnectDevice {
        device_id: String,
    },
    DisconnectDevice {
        device_id: String,
    },
    RequestSnapshot {
        device_id: String,
    },
    SelectWindow {
        device_id: String,
        window_id: String,
    },
    SelectPane {
        device_id: String,
        window_id: String,
        pane_id: String,
        size: Option<(u16, u16)>,
    },
    CreateWindow {
        completion_id: u64,
        device_id: String,
        name: Option<String>,
        cwd: Option<String>,
    },
    CloseWindow {
        device_id: String,
        window_id: String,
    },
    ClosePane {
        device_id: String,
        pane_id: String,
    },
    RenameWindow {
        device_id: String,
        window_id: String,
        name: Option<String>,
    },
    SetWindowStyle {
        device_id: String,
        style: String,
    },
    ReorderWindows {
        device_id: String,
        window_ids: Vec<String>,
    },
    ReorderPanes {
        device_id: String,
        window_id: String,
        pane_ids: Vec<String>,
    },
    ApplyStackedLayout {
        device_id: String,
        window_id: String,
        cols: u16,
        rows: u16,
    },
    SplitPane {
        device_id: String,
        pane_id: String,
        direction: LegacySplitDirection,
        cwd: Option<String>,
    },
    FocusPane {
        device_id: String,
        window_id: String,
        pane_id: String,
    },
    RenamePane {
        device_id: String,
        pane_id: String,
        name: Option<String>,
    },
    MovePane {
        device_id: String,
        source_pane_id: String,
        destination_pane_id: String,
        position: LegacyPanePosition,
    },
    BreakPane {
        device_id: String,
        pane_id: String,
    },
    SendInput {
        device_id: String,
        pane_id: String,
        data: String,
    },
    SendKey {
        device_id: String,
        pane_id: String,
        key: tmex_protocol::TerminalKey,
        modifiers: u16,
        action: tmex_protocol::TerminalKeyAction,
    },
    SendInputBatch {
        device_id: String,
        pane_id: String,
        chunks: Vec<String>,
    },
    ResizeWindow {
        device_id: String,
        window_id: String,
        cols: u16,
        rows: u16,
    },
    ResizePane {
        device_id: String,
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    ResizePaneById {
        device_id: String,
        pane_id: String,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    FetchPaneHistory {
        device_id: String,
        pane_id: String,
        request_token: WireToken,
    },
    LoadAgentSync {
        session_id: String,
        generation: u64,
    },
    UpdateSiteTheme {
        theme: u8,
    },
}

pub trait LegacyBusinessRuntime {
    fn dispatch(&mut self, command: LegacyRuntimeCommand);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyBusinessEvent {
    Negotiated,
    Barrier(SwitchBarrierEvent),
    Warning { kind: MessageKind, message: String },
    Unhandled(Envelope),
    DetachDevice { device_id: String },
    Closed,
}

#[derive(Debug)]
pub struct LegacyBusinessSession {
    wire: LegacyBorshSession,
    state: LegacySessionState,
    barrier: SwitchBarrier,
    output_batcher: TerminalOutputBatcher,
    selected_panes: HashMap<String, Option<String>>,
    subscribed_panes: HashMap<String, HashSet<String>>,
    snapshots: HashMap<String, StateSnapshot>,
    attached_devices: HashSet<String>,
    agent_subscriptions: HashMap<String, u64>,
    next_agent_subscription_generation: u64,
    pending_window_creates: HashMap<u64, String>,
    next_completion_id: u64,
    watch_registered: bool,
    closed: bool,
}

impl LegacyBusinessSession {
    pub fn new(config: SessionConfig, now_ms: u64) -> Self {
        Self {
            wire: LegacyBorshSession::new(config, now_ms),
            state: LegacySessionState::new(now_ms),
            barrier: SwitchBarrier::default(),
            output_batcher: TerminalOutputBatcher::default(),
            selected_panes: HashMap::new(),
            subscribed_panes: HashMap::new(),
            snapshots: HashMap::new(),
            attached_devices: HashSet::new(),
            agent_subscriptions: HashMap::new(),
            next_agent_subscription_generation: 1,
            pending_window_creates: HashMap::new(),
            next_completion_id: 1,
            watch_registered: false,
            closed: false,
        }
    }

    pub fn wire(&self) -> &LegacyBorshSession {
        &self.wire
    }

    pub fn state(&self) -> &LegacySessionState {
        &self.state
    }

    pub fn barrier(&self) -> &SwitchBarrier {
        &self.barrier
    }

    pub fn selected_pane(&self, device_id: &str) -> Option<&str> {
        self.selected_panes
            .get(device_id)
            .and_then(|pane_id| pane_id.as_deref())
    }

    pub fn subscribed_panes(&self, device_id: &str) -> Option<&HashSet<String>> {
        self.subscribed_panes.get(device_id)
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn receive_frame(
        &mut self,
        frame: &[u8],
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        if self.closed {
            return Ok(Vec::new());
        }
        let actions = self.wire.receive_frame(frame, now_ms);
        self.process_session_actions(actions, now_ms, runtime, sink)
    }

    pub fn receive_envelope(
        &mut self,
        envelope: Envelope,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        if self.closed {
            return Ok(Vec::new());
        }
        let actions = self.wire.receive_envelope(envelope, now_ms);
        self.process_session_actions(actions, now_ms, runtime, sink)
    }

    pub fn device_connected(
        &mut self,
        device_id: &str,
        snapshot: Option<StateSnapshot>,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed {
            return Ok(());
        }
        self.attached_devices.insert(device_id.to_owned());
        self.selected_panes.entry(device_id.to_owned()).or_default();
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Connected, now_ms);
        self.send_payload(
            MessageKind::DeviceConnected,
            encode_payload(&DeviceConnected {
                device_id: device_id.to_owned(),
            })?,
            sink,
        )?;
        if let Some(snapshot) = snapshot {
            self.receive_snapshot(snapshot, sink)?;
        } else {
            runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                device_id: device_id.to_owned(),
            });
        }
        Ok(())
    }

    pub fn device_connected_without_legacy_snapshot(
        &mut self,
        device_id: &str,
        snapshot: Option<StateSnapshot>,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed {
            return Ok(());
        }
        self.attached_devices.insert(device_id.to_owned());
        self.selected_panes.entry(device_id.to_owned()).or_default();
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Connected, now_ms);
        self.send_payload(
            MessageKind::DeviceConnected,
            encode_payload(&DeviceConnected {
                device_id: device_id.to_owned(),
            })?,
            sink,
        )?;
        if let Some(snapshot) = snapshot {
            self.update_snapshot_without_send(snapshot);
        } else {
            runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                device_id: device_id.to_owned(),
            });
        }
        Ok(())
    }

    pub fn device_connect_failed(&mut self, device_id: &str, now_ms: u64) {
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Failed, now_ms);
    }

    pub fn receive_snapshot(
        &mut self,
        snapshot: StateSnapshot,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.attached_devices.contains(&snapshot.device_id) {
            return Ok(());
        }
        self.snapshots
            .insert(snapshot.device_id.clone(), snapshot.clone());
        self.send_payload(MessageKind::StateSnapshot, encode_payload(&snapshot)?, sink)?;
        Ok(())
    }

    pub fn update_snapshot_without_send(&mut self, snapshot: StateSnapshot) {
        if self.closed || !self.attached_devices.contains(&snapshot.device_id) {
            return;
        }
        self.snapshots.insert(snapshot.device_id.clone(), snapshot);
    }

    pub fn detach_runtime(&mut self, device_id: &str, now_ms: u64) -> bool {
        let was_attached = self.attached_devices.remove(device_id);
        self.selected_panes.remove(device_id);
        self.subscribed_panes.remove(device_id);
        self.snapshots.remove(device_id);
        self.output_batcher.discard_device(device_id);
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Detached, now_ms);
        was_attached
    }

    pub fn receive_snapshot_diff(
        &mut self,
        diff: StateSnapshotDiff,
        current_snapshot: Option<StateSnapshot>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.attached_devices.contains(&diff.device_id) {
            return Ok(());
        }
        if let Some(snapshot) = current_snapshot {
            self.snapshots.insert(diff.device_id.clone(), snapshot);
        }
        self.send_payload(MessageKind::StateSnapshotDiff, encode_payload(&diff)?, sink)?;
        Ok(())
    }

    pub fn receive_terminal_output(
        &mut self,
        device_id: &str,
        pane_id: &str,
        data: &[u8],
        now_ms: u64,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.wants_pane_output(device_id, pane_id) {
            return Ok(());
        }
        let batches = self.output_batcher.push(device_id, pane_id, data, now_ms);
        self.send_output_batches(batches, sink)
    }

    pub fn receive_terminal_history(
        &mut self,
        device_id: &str,
        pane_id: &str,
        history: &CapturedPaneHistory,
        now_ms: u64,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        if self.closed || !self.attached_devices.contains(device_id) {
            return Ok(Vec::new());
        }
        let transaction_pane = self
            .barrier
            .get_transaction_pane_id(&mut self.state, device_id)
            .map(str::to_owned);
        let should_route = transaction_pane.as_deref() == Some(pane_id)
            || (transaction_pane.is_none() && self.selected_pane(device_id) == Some(pane_id));
        if !should_route {
            return Ok(Vec::new());
        }
        let events = self.barrier.send_term_history(
            &mut self.wire,
            &mut self.state,
            sink,
            device_id,
            pane_id,
            &history.data,
            history.alternate_screen,
            history.modes,
            now_ms,
        )?;
        Ok(events
            .into_iter()
            .map(LegacyBusinessEvent::Barrier)
            .collect())
    }

    pub fn complete_pane_history_request(
        &mut self,
        device_id: &str,
        pane_id: &str,
        request_token: WireToken,
        captured: Option<CapturedPaneHistory>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed {
            return Ok(());
        }
        let captured = captured.unwrap_or(CapturedPaneHistory {
            data: Vec::new(),
            alternate_screen: false,
            modes: 0,
        });
        self.send_payload(
            MessageKind::TermHistory,
            encode_payload(&TermHistory {
                device_id: device_id.to_owned(),
                pane_id: pane_id.to_owned(),
                select_token: request_token,
                encoding: 1,
                alternate_screen: captured.alternate_screen,
                modes: captured.modes,
                data: captured.data,
            })?,
            sink,
        )?;
        Ok(())
    }

    pub fn complete_create_window(
        &mut self,
        completion_id: u64,
        window_id: Option<String>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        let Some(device_id) = self.pending_window_creates.remove(&completion_id) else {
            return Ok(());
        };
        if self.closed {
            return Ok(());
        }
        let Some(window_id) = window_id.filter(|window_id| !window_id.is_empty()) else {
            return Ok(());
        };
        self.send_payload(
            MessageKind::TmuxWindowCreated,
            encode_payload(&TmuxWindowCreated {
                device_id,
                window_id,
            })?,
            sink,
        )?;
        Ok(())
    }

    pub fn receive_device_event(
        &mut self,
        event: DeviceEvent,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed
            || (!self.attached_devices.contains(&event.device_id)
                && !self
                    .state
                    .device_connections
                    .get(&event.device_id)
                    .is_some_and(|context| {
                        matches!(
                            context.state,
                            DeviceConnectionState::Connecting | DeviceConnectionState::Failed
                        )
                    }))
        {
            return Ok(());
        }
        self.send_payload(MessageKind::DeviceEvent, encode_payload(&event)?, sink)?;
        Ok(())
    }

    pub fn receive_tmux_event(
        &mut self,
        event: TmuxEvent,
        delivery: LegacyTmuxEventDelivery,
        now_ms: u64,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.attached_devices.contains(&event.device_id) {
            return Ok(());
        }
        let allowed = match delivery {
            LegacyTmuxEventDelivery::Broadcast => true,
            LegacyTmuxEventDelivery::Bell {
                pane_id,
                throttle_seconds,
            } => self
                .state
                .should_allow_bell(&event.device_id, &pane_id, throttle_seconds, now_ms),
            LegacyTmuxEventDelivery::Notification {
                pane_id,
                source,
                throttle_seconds,
            } => self.state.should_allow_notification(
                &event.device_id,
                &pane_id,
                &source,
                throttle_seconds,
                now_ms,
            ),
        };
        if allowed {
            self.send_payload(MessageKind::TmuxEvent, encode_payload(&event)?, sink)?;
        }
        Ok(())
    }

    pub fn receive_clipboard_write(
        &mut self,
        clipboard: ClipboardWrite,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed
            || !self.attached_devices.contains(&clipboard.device_id)
            || self.selected_pane(&clipboard.device_id) != Some(clipboard.pane_id.as_str())
        {
            return Ok(());
        }
        self.send_payload(
            MessageKind::ClipboardWrite,
            encode_payload(&clipboard)?,
            sink,
        )?;
        Ok(())
    }

    pub fn receive_clipboard_write_unfiltered(
        &mut self,
        clipboard: ClipboardWrite,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.attached_devices.contains(&clipboard.device_id) {
            return Ok(());
        }
        self.send_payload(
            MessageKind::ClipboardWrite,
            encode_payload(&clipboard)?,
            sink,
        )?;
        Ok(())
    }

    pub fn receive_site_theme_update(
        &mut self,
        update: SiteThemeUpdateS2c,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if !self.closed {
            self.send_payload(MessageKind::SiteThemeUpdate, encode_payload(&update)?, sink)?;
        }
        Ok(())
    }

    pub fn receive_settings_update(
        &mut self,
        update: SettingsUpdateS2c,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if !self.closed {
            self.send_payload(MessageKind::SettingsUpdate, encode_payload(&update)?, sink)?;
        }
        Ok(())
    }

    pub fn receive_notify_event(
        &mut self,
        event: EventNotifyS2c,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if !self.closed {
            self.send_payload(MessageKind::NotifyEvent, encode_payload(&event)?, sink)?;
        }
        Ok(())
    }

    pub fn complete_agent_sync(
        &mut self,
        session_id: &str,
        generation: u64,
        sync_json: Option<Vec<u8>>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || self.agent_subscriptions.get(session_id).copied() != Some(generation) {
            return Ok(());
        }
        if let Some(payload) = sync_json {
            self.send_agent_event(session_id, 0, AGENT_EVENT_SYNC, payload, sink)?;
        }
        Ok(())
    }

    pub fn receive_agent_event(
        &mut self,
        session_id: &str,
        seq: u32,
        event_type: u8,
        json_payload: Vec<u8>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.agent_subscriptions.contains_key(session_id) {
            return Ok(());
        }
        self.send_agent_event(session_id, seq, event_type, json_payload, sink)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn receive_watch_event(
        &mut self,
        rule_id: &str,
        device_id: &str,
        pane_id: &str,
        event_type: u8,
        json_payload: Vec<u8>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if self.closed || !self.watch_registered {
            return Ok(());
        }
        self.send_payload(
            MessageKind::WatchEvent,
            encode_payload(&WatchEvent {
                rule_id: rule_id.to_owned(),
                device_id: device_id.to_owned(),
                pane_id: pane_id.to_owned(),
                event_type,
                payload: json_payload,
            })?,
            sink,
        )?;
        Ok(())
    }

    pub fn send_canonical_event(
        &mut self,
        event: CanonicalEvent,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<bool, SessionProtocolError> {
        if self.closed {
            return Ok(false);
        }
        self.send_payload(
            MessageKind::CanonicalEvent,
            encode_canonical_event(event)?,
            sink,
        )
    }

    pub fn send_protocol_error(
        &mut self,
        ref_seq: Option<u32>,
        error: SessionProtocolError,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        self.send_error(ref_seq, error.code, error.message, error.retryable, sink)
    }

    pub fn poll(
        &mut self,
        now_ms: u64,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        if self.closed {
            return Ok(Vec::new());
        }
        self.wire.cleanup_chunks(now_ms);
        let batches = self.output_batcher.poll(now_ms);
        self.send_output_batches(batches, sink)?;
        let barrier_events = self
            .barrier
            .poll(&mut self.wire, &mut self.state, sink, now_ms)?;
        Ok(barrier_events
            .into_iter()
            .map(LegacyBusinessEvent::Barrier)
            .collect())
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        [
            self.output_batcher.next_deadline_ms(),
            self.barrier.next_deadline_ms(),
            self.wire.next_chunk_deadline_ms(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub fn close(&mut self) -> Vec<LegacyBusinessEvent> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        self.barrier.cleanup(&mut self.state);
        let mut attached_devices: Vec<String> = self.attached_devices.drain().collect();
        attached_devices.sort();
        for device_id in &attached_devices {
            self.output_batcher.discard_device(device_id);
        }
        self.selected_panes.clear();
        self.subscribed_panes.clear();
        self.snapshots.clear();
        self.agent_subscriptions.clear();
        self.pending_window_creates.clear();
        self.watch_registered = false;
        let mut events: Vec<LegacyBusinessEvent> = attached_devices
            .into_iter()
            .map(|device_id| LegacyBusinessEvent::DetachDevice { device_id })
            .collect();
        events.push(LegacyBusinessEvent::Closed);
        events
    }

    fn process_session_actions(
        &mut self,
        actions: Vec<SessionAction>,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        let mut events = Vec::new();
        for action in actions {
            match action {
                SessionAction::Negotiated(_) => {
                    self.watch_registered = true;
                    self.state.ws_connection.state = WsConnectionState::Ready;
                    self.state.ws_connection.connected_at_ms = Some(now_ms);
                    events.push(LegacyBusinessEvent::Negotiated);
                }
                SessionAction::SendBatch(frames) => {
                    sink.send_batch(frames);
                }
                SessionAction::Inbound(envelope) => {
                    self.state.update_last_activity(now_ms);
                    events.extend(self.dispatch_business(envelope, now_ms, runtime, sink)?);
                }
            }
        }
        Ok(events)
    }

    fn dispatch_business(
        &mut self,
        envelope: Envelope,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        let kind = MessageKind::try_from(envelope.kind).map_err(SessionProtocolError::from)?;
        let ref_seq = envelope.seq;
        macro_rules! decode {
            ($ty:ty) => {
                match decode_payload::<$ty>(&envelope.payload) {
                    Ok(value) => value,
                    Err(error) => {
                        let error = SessionProtocolError::from(error);
                        self.send_error(
                            Some(ref_seq),
                            error.code,
                            error.message,
                            error.retryable,
                            sink,
                        )?;
                        return Ok(Vec::new());
                    }
                }
            };
        }

        match kind {
            MessageKind::DeviceConnect => {
                let command = decode!(DeviceConnect);
                self.state.transition_device_state(
                    &command.device_id,
                    DeviceConnectionState::Connecting,
                    now_ms,
                );
                runtime.dispatch(LegacyRuntimeCommand::ConnectDevice {
                    device_id: command.device_id,
                });
            }
            MessageKind::DeviceDisconnect => {
                let command = decode!(DeviceDisconnect);
                self.disconnect_device(&command.device_id, now_ms, runtime, sink)?;
            }
            MessageKind::TmuxSelect => {
                let command = decode!(TmuxSelect);
                return self.handle_select(command, now_ms, runtime, sink);
            }
            MessageKind::TmuxSelectWindow => {
                let command = decode!(TmuxSelectWindow);
                if !self.attached_devices.contains(&command.device_id) {
                    return Ok(Vec::new());
                }
                if self.can_select_window(&command.device_id, &command.window_id) {
                    runtime.dispatch(LegacyRuntimeCommand::SelectWindow {
                        device_id: command.device_id,
                        window_id: command.window_id,
                    });
                } else {
                    runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                        device_id: command.device_id,
                    });
                }
            }
            MessageKind::TmuxCreateWindow => {
                let command = match decode_payload::<TmuxCreateWindow>(&envelope.payload) {
                    Ok(command) => command,
                    Err(error) => {
                        return Ok(vec![LegacyBusinessEvent::Warning {
                            kind,
                            message: SessionProtocolError::from(error).message,
                        }]);
                    }
                };
                if self.attached_devices.contains(&command.device_id) {
                    let completion_id = self.take_completion_id();
                    self.pending_window_creates
                        .insert(completion_id, command.device_id.clone());
                    runtime.dispatch(LegacyRuntimeCommand::CreateWindow {
                        completion_id,
                        device_id: command.device_id,
                        name: command.name,
                        cwd: command.cwd,
                    });
                }
            }
            MessageKind::TmuxCloseWindow => {
                let command = decode!(TmuxCloseWindow);
                if self.attached_devices.contains(&command.device_id) {
                    runtime.dispatch(LegacyRuntimeCommand::CloseWindow {
                        device_id: command.device_id,
                        window_id: command.window_id,
                    });
                }
            }
            MessageKind::TmuxClosePane => {
                let command = decode!(TmuxClosePane);
                if self.attached_devices.contains(&command.device_id) {
                    runtime.dispatch(LegacyRuntimeCommand::ClosePane {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                    });
                }
            }
            MessageKind::TmuxRenameWindow => {
                let command = decode!(TmuxRenameWindow);
                runtime.dispatch(LegacyRuntimeCommand::RenameWindow {
                    device_id: command.device_id,
                    window_id: command.window_id,
                    name: normalize_custom_name(&command.name),
                });
            }
            MessageKind::TmuxSetWindowStyle => {
                let command = decode!(TmuxSetWindowStyle);
                if self.attached_devices.contains(&command.device_id) {
                    runtime.dispatch(LegacyRuntimeCommand::SetWindowStyle {
                        device_id: command.device_id,
                        style: command.style,
                    });
                }
            }
            MessageKind::TmuxReorderWindows => {
                let command = decode!(TmuxReorderWindows);
                runtime.dispatch(LegacyRuntimeCommand::ReorderWindows {
                    device_id: command.device_id,
                    window_ids: command.window_ids,
                });
            }
            MessageKind::TmuxReorderPanes => {
                let command = decode!(TmuxReorderPanes);
                runtime.dispatch(LegacyRuntimeCommand::ReorderPanes {
                    device_id: command.device_id,
                    window_id: command.window_id,
                    pane_ids: command.pane_ids,
                });
            }
            MessageKind::TmuxSubscribePanes => {
                let command = decode!(TmuxSubscribePanes);
                self.handle_subscribe_panes(command, sink)?;
            }
            MessageKind::TmuxFetchPaneHistory => {
                let command = decode!(TmuxFetchPaneHistory);
                if self.attached_devices.contains(&command.device_id)
                    && is_tmux_id(&command.pane_id, '%')
                {
                    runtime.dispatch(LegacyRuntimeCommand::FetchPaneHistory {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        request_token: command.request_token,
                    });
                }
            }
            MessageKind::TmuxApplyStackedLayout => {
                let command = decode!(TmuxApplyStackedLayout);
                self.handle_apply_stacked_layout(command, runtime);
            }
            MessageKind::TmuxSplitPane => {
                let command = decode!(TmuxSplitPane);
                if self.attached_devices.contains(&command.device_id)
                    && is_tmux_id(&command.pane_id, '%')
                {
                    runtime.dispatch(LegacyRuntimeCommand::SplitPane {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        direction: if command.direction == 2 {
                            LegacySplitDirection::Vertical
                        } else {
                            LegacySplitDirection::Horizontal
                        },
                        cwd: command.cwd,
                    });
                }
            }
            MessageKind::TmuxFocusPane => {
                let command = decode!(TmuxFocusPane);
                if !self.attached_devices.contains(&command.device_id) {
                    return Ok(Vec::new());
                }
                if self.can_select_pane(&command.device_id, &command.window_id, &command.pane_id) {
                    self.selected_panes
                        .insert(command.device_id.clone(), Some(command.pane_id.clone()));
                    runtime.dispatch(LegacyRuntimeCommand::FocusPane {
                        device_id: command.device_id,
                        window_id: command.window_id,
                        pane_id: command.pane_id,
                    });
                } else {
                    runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                        device_id: command.device_id,
                    });
                }
            }
            MessageKind::TmuxRenamePane => {
                let command = decode!(TmuxRenamePane);
                if is_tmux_id(&command.pane_id, '%') {
                    runtime.dispatch(LegacyRuntimeCommand::RenamePane {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        name: normalize_custom_name(&command.name),
                    });
                }
            }
            MessageKind::TmuxMovePane => {
                let command = decode!(TmuxMovePane);
                if self.attached_devices.contains(&command.device_id)
                    && is_tmux_id(&command.src_pane_id, '%')
                    && is_tmux_id(&command.dst_pane_id, '%')
                    && command.src_pane_id != command.dst_pane_id
                {
                    let position = match command.position {
                        1 => Some(LegacyPanePosition::Left),
                        2 => Some(LegacyPanePosition::Right),
                        3 => Some(LegacyPanePosition::Top),
                        4 => Some(LegacyPanePosition::Bottom),
                        _ => None,
                    };
                    if let Some(position) = position {
                        runtime.dispatch(LegacyRuntimeCommand::MovePane {
                            device_id: command.device_id,
                            source_pane_id: command.src_pane_id,
                            destination_pane_id: command.dst_pane_id,
                            position,
                        });
                    }
                }
            }
            MessageKind::TmuxBreakPane => {
                let command = decode!(TmuxBreakPane);
                if self.attached_devices.contains(&command.device_id)
                    && is_tmux_id(&command.pane_id, '%')
                {
                    runtime.dispatch(LegacyRuntimeCommand::BreakPane {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                    });
                }
            }
            MessageKind::TmuxResizePane => {
                let command = decode!(TmuxResizePane);
                if self.attached_devices.contains(&command.device_id)
                    && is_tmux_id(&command.pane_id, '%')
                    && (command.cols.is_some() || command.rows.is_some())
                {
                    runtime.dispatch(LegacyRuntimeCommand::ResizePaneById {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        cols: command.cols,
                        rows: command.rows,
                    });
                }
            }
            MessageKind::TermInput => {
                let command = decode!(TermInput);
                if command.data.len() > TERMINAL_INPUT_MAX_BYTES {
                    self.send_error(
                        Some(ref_seq),
                        ProtocolErrorCode::FrameTooLarge,
                        "Terminal input exceeds the 1 MiB limit".to_owned(),
                        false,
                        sink,
                    )?;
                    return Ok(Vec::new());
                }
                if !command.is_composing && self.attached_devices.contains(&command.device_id) {
                    runtime.dispatch(LegacyRuntimeCommand::SendInput {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        data: String::from_utf8_lossy(&command.data).into_owned(),
                    });
                }
            }
            MessageKind::TermKeyInput => {
                let command = decode!(TermKeyInput);
                if self.attached_devices.contains(&command.device_id) {
                    runtime.dispatch(LegacyRuntimeCommand::SendKey {
                        device_id: command.device_id,
                        pane_id: command.pane_id,
                        key: command.key,
                        modifiers: command.modifiers,
                        action: command.action,
                    });
                }
            }
            MessageKind::TermPaste => {
                let command = decode!(TermPaste);
                if command.data.len() > TERMINAL_PASTE_MAX_BYTES {
                    self.send_error(
                        Some(ref_seq),
                        ProtocolErrorCode::FrameTooLarge,
                        "Terminal paste exceeds the 1 MiB limit".to_owned(),
                        false,
                        sink,
                    )?;
                    return Ok(Vec::new());
                }
                if self.attached_devices.contains(&command.device_id) {
                    let text = String::from_utf8_lossy(&command.data);
                    let chunks = js_string_chunks(&text, 1_024);
                    if !chunks.is_empty() {
                        runtime.dispatch(LegacyRuntimeCommand::SendInputBatch {
                            device_id: command.device_id,
                            pane_id: command.pane_id,
                            chunks,
                        });
                    }
                }
            }
            MessageKind::TermResize | MessageKind::TermSyncSize => {
                let command = decode!(TermResize);
                self.handle_term_resize(command, runtime);
            }
            MessageKind::AgentSubscribe => {
                let command = decode!(AgentSubscribe);
                let generation = if let Some(generation) =
                    self.agent_subscriptions.get(&command.session_id).copied()
                {
                    generation
                } else {
                    let generation = self.next_agent_subscription_generation;
                    self.next_agent_subscription_generation = generation.saturating_add(1);
                    self.agent_subscriptions
                        .insert(command.session_id.clone(), generation);
                    generation
                };
                runtime.dispatch(LegacyRuntimeCommand::LoadAgentSync {
                    session_id: command.session_id,
                    generation,
                });
            }
            MessageKind::AgentUnsubscribe => {
                let command = decode!(AgentUnsubscribe);
                self.agent_subscriptions.remove(&command.session_id);
            }
            MessageKind::SiteThemeUpdate => {
                let command = decode!(SiteThemeUpdateC2s);
                if !matches!(command.theme, SITE_THEME_DARK | SITE_THEME_LIGHT) {
                    self.send_error(
                        None,
                        ProtocolErrorCode::PayloadDecodeFailed,
                        format!("invalid theme value: {}", command.theme),
                        false,
                        sink,
                    )?;
                } else {
                    runtime.dispatch(LegacyRuntimeCommand::UpdateSiteTheme {
                        theme: command.theme,
                    });
                }
            }
            MessageKind::CanonicalCommand => {
                return Ok(vec![LegacyBusinessEvent::Unhandled(envelope)]);
            }
            _ => {
                return Err(SessionProtocolError::invalid_frame(
                    "Legacy session received a non-client message kind",
                ));
            }
        }
        Ok(Vec::new())
    }

    fn handle_select(
        &mut self,
        command: TmuxSelect,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<Vec<LegacyBusinessEvent>, SessionProtocolError> {
        if !self.attached_devices.contains(&command.device_id) {
            return Ok(Vec::new());
        }
        let (Some(window_id), Some(pane_id)) = (command.window_id, command.pane_id) else {
            return Ok(Vec::new());
        };
        if !self.can_select_pane(&command.device_id, &window_id, &pane_id) {
            runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                device_id: command.device_id,
            });
            return Ok(Vec::new());
        }
        self.flush_output_device(&command.device_id, sink)?;
        let context = SwitchBarrierContext {
            device_id: command.device_id.clone(),
            window_id: window_id.clone(),
            pane_id: pane_id.clone(),
            select_token: command.select_token,
            want_history: command.want_history,
            cols: command.cols,
            rows: command.rows,
        };
        if !self
            .barrier
            .start_transaction(&mut self.state, context, now_ms)
        {
            self.send_error(
                None,
                ProtocolErrorCode::SelectConflict,
                "Failed to start select transaction".to_owned(),
                false,
                sink,
            )?;
            return Ok(Vec::new());
        }
        self.selected_panes
            .insert(command.device_id.clone(), Some(pane_id.clone()));
        let events = self.barrier.send_switch_ack(
            &mut self.wire,
            &mut self.state,
            sink,
            &command.device_id,
            now_ms,
        )?;
        runtime.dispatch(LegacyRuntimeCommand::SelectPane {
            device_id: command.device_id,
            window_id,
            pane_id,
            size: command.cols.zip(command.rows),
        });
        Ok(events
            .into_iter()
            .map(LegacyBusinessEvent::Barrier)
            .collect())
    }

    fn handle_subscribe_panes(
        &mut self,
        command: TmuxSubscribePanes,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        if !self.attached_devices.contains(&command.device_id) {
            return Ok(());
        }
        let known = self.known_pane_ids(&command.device_id);
        let accepted: HashSet<String> = command
            .pane_ids
            .into_iter()
            .filter(|pane_id| is_tmux_id(pane_id, '%') && known.contains(pane_id))
            .collect();
        self.flush_output_device(&command.device_id, sink)?;
        if accepted.is_empty() {
            self.subscribed_panes.remove(&command.device_id);
        } else {
            self.subscribed_panes.insert(command.device_id, accepted);
        }
        Ok(())
    }

    fn handle_apply_stacked_layout(
        &self,
        command: TmuxApplyStackedLayout,
        runtime: &mut dyn LegacyBusinessRuntime,
    ) {
        if !self.attached_devices.contains(&command.device_id) {
            return;
        }
        if !self.can_select_window(&command.device_id, &command.window_id) {
            runtime.dispatch(LegacyRuntimeCommand::RequestSnapshot {
                device_id: command.device_id,
            });
            return;
        }
        if command.cols < 2 || command.rows < 2 {
            return;
        }
        let Some(window) = self
            .snapshots
            .get(&command.device_id)
            .and_then(|snapshot| snapshot.session.as_ref())
            .and_then(|session| {
                session
                    .windows
                    .iter()
                    .find(|window| window.id == command.window_id)
            })
        else {
            return;
        };
        let pane_count = window.panes.len();
        if pane_count == 0
            || window
                .panes
                .iter()
                .all(|pane| pane.width == command.cols && pane.height == command.rows)
        {
            return;
        }
        let total_cols = pane_count
            .saturating_mul(usize::from(command.cols))
            .saturating_add(pane_count - 1);
        let clamped_cols = total_cols.min(10_000) as u16;
        if pane_count == 1 {
            runtime.dispatch(LegacyRuntimeCommand::ResizeWindow {
                device_id: command.device_id,
                window_id: command.window_id,
                cols: clamped_cols,
                rows: command.rows,
            });
        } else {
            runtime.dispatch(LegacyRuntimeCommand::ApplyStackedLayout {
                device_id: command.device_id,
                window_id: command.window_id,
                cols: clamped_cols,
                rows: command.rows,
            });
        }
    }

    fn handle_term_resize(&self, command: TermResize, runtime: &mut dyn LegacyBusinessRuntime) {
        if !self.attached_devices.contains(&command.device_id) {
            return;
        }
        let window = self.snapshots.get(&command.device_id).and_then(|snapshot| {
            snapshot
                .session
                .as_ref()?
                .windows
                .iter()
                .find(|window| window.panes.iter().any(|pane| pane.id == command.pane_id))
        });
        if let Some(window) = window.filter(|window| window.panes.len() > 1) {
            if parse_window_layout_size(window.layout.as_deref())
                == Some((command.cols, command.rows))
            {
                return;
            }
            runtime.dispatch(LegacyRuntimeCommand::ResizeWindow {
                device_id: command.device_id,
                window_id: window.id.clone(),
                cols: command.cols,
                rows: command.rows,
            });
            return;
        }
        if window
            .and_then(|window| window.panes.iter().find(|pane| pane.id == command.pane_id))
            .is_some_and(|pane| pane.width == command.cols && pane.height == command.rows)
        {
            return;
        }
        runtime.dispatch(LegacyRuntimeCommand::ResizePane {
            device_id: command.device_id,
            pane_id: command.pane_id,
            cols: command.cols,
            rows: command.rows,
        });
    }

    fn disconnect_device(
        &mut self,
        device_id: &str,
        now_ms: u64,
        runtime: &mut dyn LegacyBusinessRuntime,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        let was_attached = self.attached_devices.remove(device_id);
        self.selected_panes.remove(device_id);
        self.subscribed_panes.remove(device_id);
        self.snapshots.remove(device_id);
        self.output_batcher.discard_device(device_id);
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Disconnecting, now_ms);
        self.state
            .transition_device_state(device_id, DeviceConnectionState::Detached, now_ms);
        if was_attached {
            runtime.dispatch(LegacyRuntimeCommand::DisconnectDevice {
                device_id: device_id.to_owned(),
            });
        }
        self.send_payload(
            MessageKind::DeviceDisconnected,
            encode_payload(&DeviceDisconnected {
                device_id: device_id.to_owned(),
            })?,
            sink,
        )?;
        Ok(())
    }

    fn flush_output_device(
        &mut self,
        device_id: &str,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        let batches = self.output_batcher.flush_device(device_id);
        self.send_output_batches(batches, sink)
    }

    fn send_output_batches(
        &mut self,
        batches: Vec<TerminalOutputBatch>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        for batch in batches {
            if !self.wants_pane_output(&batch.device_id, &batch.pane_id) {
                continue;
            }
            let focused = self.selected_pane(&batch.device_id) == Some(batch.pane_id.as_str());
            if focused && self.state.is_buffering(&batch.device_id) {
                self.state.buffer_output(&batch.device_id, &batch.data);
                continue;
            }
            self.send_payload(
                MessageKind::TermOutput,
                encode_payload(&TermOutput {
                    device_id: batch.device_id,
                    pane_id: batch.pane_id,
                    encoding: 1,
                    data: batch.data,
                })?,
                sink,
            )?;
        }
        Ok(())
    }

    fn wants_pane_output(&self, device_id: &str, pane_id: &str) -> bool {
        self.selected_pane(device_id) == Some(pane_id)
            || self
                .subscribed_panes
                .get(device_id)
                .is_some_and(|panes| panes.contains(pane_id))
    }

    fn known_pane_ids(&self, device_id: &str) -> HashSet<String> {
        self.snapshots
            .get(device_id)
            .and_then(|snapshot| snapshot.session.as_ref())
            .map(|session| {
                session
                    .windows
                    .iter()
                    .flat_map(|window| window.panes.iter().map(|pane| pane.id.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn can_select_window(&self, device_id: &str, window_id: &str) -> bool {
        is_tmux_id(window_id, '@')
            && self
                .snapshots
                .get(device_id)
                .and_then(|snapshot| snapshot.session.as_ref())
                .is_some_and(|session| session.windows.iter().any(|window| window.id == window_id))
    }

    fn can_select_pane(&self, device_id: &str, window_id: &str, pane_id: &str) -> bool {
        self.can_select_window(device_id, window_id)
            && is_tmux_id(pane_id, '%')
            && self
                .snapshots
                .get(device_id)
                .and_then(|snapshot| snapshot.session.as_ref())
                .and_then(|session| session.windows.iter().find(|window| window.id == window_id))
                .is_some_and(|window| window.panes.iter().any(|pane| pane.id == pane_id))
    }

    fn send_agent_event(
        &mut self,
        session_id: &str,
        seq: u32,
        event_type: u8,
        payload: Vec<u8>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        self.send_payload(
            MessageKind::AgentEvent,
            encode_payload(&AgentEvent {
                session_id: session_id.to_owned(),
                seq,
                event_type,
                payload,
            })?,
            sink,
        )?;
        Ok(())
    }

    fn send_error(
        &mut self,
        ref_seq: Option<u32>,
        code: ProtocolErrorCode,
        message: String,
        retryable: bool,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<(), SessionProtocolError> {
        self.send_payload(
            MessageKind::Error,
            encode_payload(&ErrorPayload {
                ref_seq,
                code: code as u16,
                message,
                retryable,
            })?,
            sink,
        )?;
        Ok(())
    }

    fn send_payload(
        &mut self,
        kind: MessageKind,
        payload: Vec<u8>,
        sink: &mut dyn LegacyFrameSink,
    ) -> Result<bool, SessionProtocolError> {
        if !sink.can_send() {
            return Ok(false);
        }
        let frames = self.wire.prepare_outbound(kind as u16, payload)?;
        Ok(sink.send_batch(frames))
    }

    fn take_completion_id(&mut self) -> u64 {
        let completion_id = self.next_completion_id;
        self.next_completion_id = if completion_id == u64::MAX {
            1
        } else {
            completion_id + 1
        };
        completion_id
    }
}

fn is_tmux_id(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix).is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub fn parse_window_layout_size(layout: Option<&str>) -> Option<(u16, u16)> {
    let layout = layout?;
    let (_, dimensions) = layout.split_once(',')?;
    let dimensions = dimensions.split([',', '[', '{']).next()?;
    let (cols, rows) = dimensions.split_once('x')?;
    Some((cols.parse().ok()?, rows.parse().ok()?))
}

fn js_string_chunks(value: &str, maximum_utf16_units: usize) -> Vec<String> {
    value
        .encode_utf16()
        .collect::<Vec<_>>()
        .chunks(maximum_utf16_units)
        .map(String::from_utf16_lossy)
        .collect()
}

fn normalize_custom_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let utf16: Vec<u16> = trimmed.encode_utf16().take(64).collect();
    Some(String::from_utf16_lossy(&utf16))
}

#[cfg(test)]
mod tests {
    use tmex_protocol::{
        decode_payload, encode_payload, AgentEvent, AgentSubscribe, AgentUnsubscribe, ErrorPayload,
        HelloC2s, MessageKind, PaneWire, SessionWire, StateSnapshot, TmuxSelect, WatchEvent,
        WindowWire, CURRENT_VERSION, DEFAULT_MAX_FRAME_BYTES,
    };

    use super::*;

    #[derive(Default)]
    struct Runtime {
        commands: Vec<LegacyRuntimeCommand>,
    }

    impl LegacyBusinessRuntime for Runtime {
        fn dispatch(&mut self, command: LegacyRuntimeCommand) {
            self.commands.push(command);
        }
    }

    #[derive(Default)]
    struct Sink {
        batches: Vec<Vec<Envelope>>,
        gaps: usize,
        available: bool,
        send_result: bool,
    }

    impl Sink {
        fn new() -> Self {
            Self {
                available: true,
                send_result: true,
                ..Self::default()
            }
        }

        fn envelopes(&self) -> impl Iterator<Item = &Envelope> {
            self.batches.iter().flatten()
        }
    }

    impl LegacyFrameSink for Sink {
        fn can_send(&mut self) -> bool {
            self.available
        }

        fn send_batch(&mut self, frames: Vec<Envelope>) -> bool {
            self.batches.push(frames);
            self.send_result
        }

        fn mark_stream_gap(&mut self) {
            self.gaps += 1;
        }
    }

    fn inbound(kind: MessageKind, seq: u32, payload: Vec<u8>) -> Envelope {
        Envelope::new(kind as u16, payload, seq, 0, CURRENT_VERSION)
    }

    fn negotiate(session: &mut LegacyBusinessSession, runtime: &mut Runtime, sink: &mut Sink) {
        session
            .receive_envelope(
                inbound(
                    MessageKind::HelloC2s,
                    1,
                    encode_payload(&HelloC2s {
                        client_impl: "tmex-fe".into(),
                        client_version: "test".into(),
                        max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u32,
                        supports_compression: false,
                        supports_diff_snapshot: false,
                    })
                    .expect("encode hello"),
                ),
                0,
                runtime,
                sink,
            )
            .expect("hello");
        sink.batches.clear();
    }

    fn snapshot() -> StateSnapshot {
        StateSnapshot {
            device_id: "device".into(),
            session: Some(SessionWire {
                id: "$1".into(),
                name: "tmex".into(),
                windows: vec![WindowWire {
                    id: "@1".into(),
                    name: "main".into(),
                    custom_name: None,
                    index: 0,
                    active: true,
                    layout: Some("abcd,80x24,0,0".into()),
                    panes: vec![PaneWire {
                        id: "%1".into(),
                        window_id: "@1".into(),
                        index: 0,
                        title: None,
                        custom_name: None,
                        active: true,
                        width: 80,
                        height: 24,
                        current_path: None,
                        current_command: None,
                        left: None,
                        top: None,
                    }],
                }],
            }),
        }
    }

    #[test]
    fn select_flushes_old_output_before_ack_and_dispatches_runtime_after_ack() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);
        session
            .device_connected("device", Some(snapshot()), 0, &mut runtime, &mut sink)
            .expect("connected");
        sink.batches.clear();

        session
            .selected_panes
            .insert("device".into(), Some("%1".into()));
        session
            .receive_terminal_output("device", "%1", &[7, 8], 1, &mut sink)
            .expect("output");
        session
            .receive_envelope(
                inbound(
                    MessageKind::TmuxSelect,
                    9,
                    encode_payload(&TmuxSelect {
                        device_id: "device".into(),
                        window_id: Some("@1".into()),
                        pane_id: Some("%1".into()),
                        select_token: [4; 16],
                        want_history: true,
                        cols: Some(100),
                        rows: Some(30),
                    })
                    .expect("encode select"),
                ),
                2,
                &mut runtime,
                &mut sink,
            )
            .expect("select");

        assert_eq!(
            sink.envelopes().map(|frame| frame.kind).collect::<Vec<_>>(),
            vec![
                MessageKind::TermOutput as u16,
                MessageKind::SwitchAck as u16
            ]
        );
        assert_eq!(
            runtime.commands.last(),
            Some(&LegacyRuntimeCommand::SelectPane {
                device_id: "device".into(),
                window_id: "@1".into(),
                pane_id: "%1".into(),
                size: Some((100, 30)),
            })
        );
    }

    #[test]
    fn payload_decode_error_preserves_the_inbound_ref_seq() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);

        session
            .receive_envelope(
                Envelope::new(
                    MessageKind::TermInput as u16,
                    vec![0xff],
                    77,
                    0,
                    CURRENT_VERSION,
                ),
                1,
                &mut runtime,
                &mut sink,
            )
            .expect("decode error frame");
        let error_frame = sink.envelopes().last().expect("error envelope");
        assert_eq!(error_frame.kind, MessageKind::Error as u16);
        let error: ErrorPayload = decode_payload(&error_frame.payload).expect("decode error");
        assert_eq!(error.ref_seq, Some(77));
        assert_eq!(error.code, ProtocolErrorCode::PayloadDecodeFailed as u16);
        assert!(!error.retryable);
    }

    #[test]
    fn oversized_terminal_input_and_paste_return_frame_too_large_without_dispatch() {
        let cases = [
            (
                MessageKind::TermInput,
                encode_payload(&TermInput {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    encoding: 2,
                    data: vec![b'x'; TERMINAL_INPUT_MAX_BYTES + 1],
                    is_composing: false,
                })
                .expect("encode input"),
            ),
            (
                MessageKind::TermPaste,
                encode_payload(&TermPaste {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    encoding: 2,
                    data: vec![b'x'; TERMINAL_PASTE_MAX_BYTES + 1],
                    is_composing: false,
                })
                .expect("encode paste"),
            ),
        ];

        for (index, (kind, payload)) in cases.into_iter().enumerate() {
            let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
            let mut runtime = Runtime::default();
            let mut sink = Sink::new();
            negotiate(&mut session, &mut runtime, &mut sink);
            let seq = u32::try_from(index + 2).expect("test sequence fits u32");
            session
                .dispatch_business(
                    inbound(kind, seq, payload),
                    1,
                    &mut runtime,
                    &mut sink,
                )
                .expect("oversized input handled");

            let error_frame = sink.envelopes().last().expect("error envelope");
            let error: ErrorPayload =
                decode_payload(&error_frame.payload).expect("decode error payload");
            assert_eq!(error.ref_seq, Some(seq));
            assert_eq!(error.code, ProtocolErrorCode::FrameTooLarge as u16);
            assert!(!error.retryable);
            assert!(runtime.commands.is_empty());
        }
    }

    #[test]
    fn agent_subscription_generation_and_watch_json_bytes_are_transport_neutral() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);

        session
            .receive_envelope(
                inbound(
                    MessageKind::AgentSubscribe,
                    2,
                    encode_payload(&AgentSubscribe {
                        session_id: "agent-1".into(),
                    })
                    .expect("encode subscribe"),
                ),
                1,
                &mut runtime,
                &mut sink,
            )
            .expect("subscribe");
        let LegacyRuntimeCommand::LoadAgentSync { generation, .. } =
            runtime.commands.last().expect("sync request")
        else {
            panic!("expected agent sync request")
        };
        let generation = *generation;
        session
            .complete_agent_sync(
                "agent-1",
                generation,
                Some(br#"{"status":"idle"}"#.to_vec()),
                &mut sink,
            )
            .expect("sync");
        let agent_frame = sink.envelopes().last().expect("agent event");
        let agent: AgentEvent = decode_payload(&agent_frame.payload).expect("agent payload");
        assert_eq!(agent.seq, 0);
        assert_eq!(agent.event_type, AGENT_EVENT_SYNC);
        assert_eq!(agent.payload, br#"{"status":"idle"}"#);

        session
            .receive_envelope(
                inbound(
                    MessageKind::AgentUnsubscribe,
                    3,
                    encode_payload(&AgentUnsubscribe {
                        session_id: "agent-1".into(),
                    })
                    .expect("encode unsubscribe"),
                ),
                2,
                &mut runtime,
                &mut sink,
            )
            .expect("unsubscribe");
        let before = sink.batches.len();
        session
            .complete_agent_sync("agent-1", generation, Some(b"late".to_vec()), &mut sink)
            .expect("late sync ignored");
        assert_eq!(sink.batches.len(), before);

        session
            .receive_watch_event(
                "rule-1",
                "device",
                "%1",
                1,
                br#"{"summary":"matched"}"#.to_vec(),
                &mut sink,
            )
            .expect("watch");
        let watch_frame = sink.envelopes().last().expect("watch event");
        let watch: WatchEvent = decode_payload(&watch_frame.payload).expect("watch payload");
        assert_eq!(watch.rule_id, "rule-1");
        assert_eq!(watch.payload, br#"{"summary":"matched"}"#);
    }

    #[test]
    fn blocked_generic_send_does_not_consume_an_outbound_sequence() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);

        sink.available = false;
        session
            .receive_watch_event("rule", "device", "%1", 1, b"{}".to_vec(), &mut sink)
            .expect("blocked watch");
        assert!(sink.batches.is_empty());

        sink.available = true;
        session
            .receive_watch_event("rule", "device", "%1", 1, b"{}".to_vec(), &mut sink)
            .expect("watch");
        assert_eq!(sink.envelopes().next().map(|frame| frame.seq), Some(2));
        assert_eq!(sink.gaps, 0);
    }

    #[test]
    fn every_legacy_client_kind_is_handled_and_only_canonical_is_forwarded() {
        macro_rules! encoded {
            ($kind:expr, $payload:expr) => {
                (
                    $kind,
                    encode_payload(&$payload).expect("encode client command"),
                )
            };
        }

        let commands = vec![
            encoded!(
                MessageKind::DeviceConnect,
                DeviceConnect {
                    device_id: "device".into()
                }
            ),
            encoded!(
                MessageKind::DeviceDisconnect,
                DeviceDisconnect {
                    device_id: "device".into()
                }
            ),
            encoded!(
                MessageKind::TmuxSelect,
                TmuxSelect {
                    device_id: "device".into(),
                    window_id: Some("@1".into()),
                    pane_id: Some("%1".into()),
                    select_token: [1; 16],
                    want_history: false,
                    cols: None,
                    rows: None,
                }
            ),
            encoded!(
                MessageKind::TmuxSelectWindow,
                TmuxSelectWindow {
                    device_id: "device".into(),
                    window_id: "@1".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxCreateWindow,
                TmuxCreateWindow {
                    device_id: "device".into(),
                    name: Some("new".into()),
                    cwd: Some("/tmp".into()),
                }
            ),
            encoded!(
                MessageKind::TmuxCloseWindow,
                TmuxCloseWindow {
                    device_id: "device".into(),
                    window_id: "not-validated-by-legacy".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxClosePane,
                TmuxClosePane {
                    device_id: "device".into(),
                    pane_id: "not-validated-by-legacy".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxRenameWindow,
                TmuxRenameWindow {
                    device_id: "device".into(),
                    window_id: "not-validated-by-legacy".into(),
                    name: format!("  {}  ", "n".repeat(70)),
                }
            ),
            encoded!(
                MessageKind::TmuxSetWindowStyle,
                TmuxSetWindowStyle {
                    device_id: "device".into(),
                    style: "bg=#000000".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxReorderWindows,
                TmuxReorderWindows {
                    device_id: "device".into(),
                    window_ids: vec!["raw-window-id".into()],
                }
            ),
            encoded!(
                MessageKind::TmuxReorderPanes,
                TmuxReorderPanes {
                    device_id: "device".into(),
                    window_id: "raw-window-id".into(),
                    pane_ids: vec!["raw-pane-id".into()],
                }
            ),
            encoded!(
                MessageKind::TmuxSubscribePanes,
                TmuxSubscribePanes {
                    device_id: "device".into(),
                    pane_ids: vec!["%1".into()],
                }
            ),
            encoded!(
                MessageKind::TmuxFetchPaneHistory,
                TmuxFetchPaneHistory {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    request_token: [2; 16],
                }
            ),
            encoded!(
                MessageKind::TmuxResizePane,
                TmuxResizePane {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    cols: Some(90),
                    rows: None,
                }
            ),
            encoded!(
                MessageKind::TmuxApplyStackedLayout,
                TmuxApplyStackedLayout {
                    device_id: "device".into(),
                    window_id: "@1".into(),
                    cols: 40,
                    rows: 20,
                }
            ),
            encoded!(
                MessageKind::TmuxSplitPane,
                TmuxSplitPane {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    direction: 2,
                    cwd: None,
                }
            ),
            encoded!(
                MessageKind::TmuxFocusPane,
                TmuxFocusPane {
                    device_id: "device".into(),
                    window_id: "@1".into(),
                    pane_id: "%1".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxRenamePane,
                TmuxRenamePane {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    name: "  pane  ".into(),
                }
            ),
            encoded!(
                MessageKind::TmuxMovePane,
                TmuxMovePane {
                    device_id: "device".into(),
                    src_pane_id: "%1".into(),
                    dst_pane_id: "%2".into(),
                    position: 4,
                }
            ),
            encoded!(
                MessageKind::TmuxBreakPane,
                TmuxBreakPane {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                }
            ),
            encoded!(
                MessageKind::TermInput,
                TermInput {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    encoding: 1,
                    data: b"input".to_vec(),
                    is_composing: false,
                }
            ),
            encoded!(
                MessageKind::TermPaste,
                TermPaste {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    encoding: 1,
                    data: b"paste".to_vec(),
                    is_composing: false,
                }
            ),
            encoded!(
                MessageKind::TermResize,
                TermResize {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    cols: 100,
                    rows: 30,
                }
            ),
            encoded!(
                MessageKind::TermSyncSize,
                TermResize {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    cols: 100,
                    rows: 30,
                }
            ),
            encoded!(
                MessageKind::AgentSubscribe,
                AgentSubscribe {
                    session_id: "agent".into()
                }
            ),
            encoded!(
                MessageKind::AgentUnsubscribe,
                AgentUnsubscribe {
                    session_id: "agent".into()
                }
            ),
            encoded!(
                MessageKind::SiteThemeUpdate,
                SiteThemeUpdateC2s {
                    theme: SITE_THEME_LIGHT
                }
            ),
            (MessageKind::CanonicalCommand, vec![0]),
        ];

        assert_eq!(commands.len(), 28);
        for (index, (kind, payload)) in commands.into_iter().enumerate() {
            let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
            let mut runtime = Runtime::default();
            let mut sink = Sink::new();
            negotiate(&mut session, &mut runtime, &mut sink);
            session
                .device_connected("device", Some(snapshot()), 0, &mut runtime, &mut sink)
                .expect("attach device");
            sink.batches.clear();
            runtime.commands.clear();

            let events = session
                .receive_envelope(
                    inbound(kind, u32::try_from(index + 2).expect("test seq"), payload),
                    1,
                    &mut runtime,
                    &mut sink,
                )
                .expect("dispatch client kind");
            let unhandled = events
                .iter()
                .filter(|event| matches!(event, LegacyBusinessEvent::Unhandled(_)))
                .count();
            assert_eq!(
                unhandled,
                usize::from(kind == MessageKind::CanonicalCommand),
                "unexpected dispatch result for {}",
                kind.as_str()
            );
            if kind == MessageKind::TmuxCreateWindow {
                let Some(LegacyRuntimeCommand::CreateWindow { completion_id, .. }) =
                    runtime.commands.last()
                else {
                    panic!("create-window runtime command missing")
                };
                session
                    .complete_create_window(*completion_id, Some("@9".into()), &mut sink)
                    .expect("complete create-window");
                let frame = sink.envelopes().last().expect("window-created frame");
                assert_eq!(frame.kind, MessageKind::TmuxWindowCreated as u16);
                let created: TmuxWindowCreated =
                    decode_payload(&frame.payload).expect("window-created payload");
                assert_eq!(created.window_id, "@9");
            }
        }
    }

    #[test]
    fn close_returns_each_attached_device_once_without_wire_disconnect_frames() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);
        for device_id in ["device-b", "device-a"] {
            let mut device_snapshot = snapshot();
            device_snapshot.device_id = device_id.into();
            session
                .device_connected(device_id, Some(device_snapshot), 0, &mut runtime, &mut sink)
                .expect("attach");
        }
        sink.batches.clear();

        assert_eq!(
            session.close(),
            vec![
                LegacyBusinessEvent::DetachDevice {
                    device_id: "device-a".into(),
                },
                LegacyBusinessEvent::DetachDevice {
                    device_id: "device-b".into(),
                },
                LegacyBusinessEvent::Closed,
            ]
        );
        assert!(sink.batches.is_empty());
        assert!(session.close().is_empty());
    }

    #[test]
    fn create_decode_warns_without_error_and_invalid_theme_errors_without_ref_seq() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);

        let events = session
            .receive_envelope(
                inbound(MessageKind::TmuxCreateWindow, 41, vec![0xff]),
                1,
                &mut runtime,
                &mut sink,
            )
            .expect("create decode warning");
        assert!(matches!(
            events.as_slice(),
            [LegacyBusinessEvent::Warning {
                kind: MessageKind::TmuxCreateWindow,
                ..
            }]
        ));
        assert!(sink.batches.is_empty());

        session
            .receive_envelope(
                inbound(
                    MessageKind::SiteThemeUpdate,
                    42,
                    encode_payload(&SiteThemeUpdateC2s { theme: 7 }).expect("theme"),
                ),
                2,
                &mut runtime,
                &mut sink,
            )
            .expect("invalid theme error");
        let frame = sink.envelopes().last().expect("error frame");
        let error: ErrorPayload = decode_payload(&frame.payload).expect("error payload");
        assert_eq!(error.ref_seq, None);
        assert_eq!(error.code, ProtocolErrorCode::PayloadDecodeFailed as u16);
        assert_eq!(error.message, "invalid theme value: 7");
    }

    #[test]
    fn s2c_injection_keeps_clipboard_selection_and_tmux_throttle_filters() {
        let mut session = LegacyBusinessSession::new(SessionConfig::default(), 0);
        let mut runtime = Runtime::default();
        let mut sink = Sink::new();
        negotiate(&mut session, &mut runtime, &mut sink);
        session
            .device_connected("device", Some(snapshot()), 0, &mut runtime, &mut sink)
            .expect("attach");
        session
            .selected_panes
            .insert("device".into(), Some("%1".into()));
        sink.batches.clear();

        session
            .receive_clipboard_write(
                ClipboardWrite {
                    device_id: "device".into(),
                    pane_id: "%2".into(),
                    text: "ignored".into(),
                },
                &mut sink,
            )
            .expect("filtered clipboard");
        session
            .receive_clipboard_write(
                ClipboardWrite {
                    device_id: "device".into(),
                    pane_id: "%1".into(),
                    text: "sent".into(),
                },
                &mut sink,
            )
            .expect("selected clipboard");

        let bell = TmuxEvent {
            device_id: "device".into(),
            event_type: 9,
            event_data: Vec::new(),
        };
        for now_ms in [10_000, 10_001] {
            session
                .receive_tmux_event(
                    bell.clone(),
                    LegacyTmuxEventDelivery::Bell {
                        pane_id: "%1".into(),
                        throttle_seconds: 1,
                    },
                    now_ms,
                    &mut sink,
                )
                .expect("bell");
        }
        assert_eq!(
            sink.envelopes().map(|frame| frame.kind).collect::<Vec<_>>(),
            vec![
                MessageKind::ClipboardWrite as u16,
                MessageKind::TmuxEvent as u16,
            ]
        );
    }
}
