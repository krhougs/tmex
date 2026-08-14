use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::runtime::Handle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::{timeout_at, Instant};

use crate::tmux::{
    DeviceSessionRuntime, PaneDataSegment, PaneInfo, TmuxRuntimeEvent, TmuxRuntimeRegistry,
    RUNTIME_EVENT_QUEUE_CAPACITY,
};
use tmex_protocol::{StateSnapshot, WireToken};
use tmex_terminal::{PromptMarker, PromptMarkerKind};

use super::{
    AgentPortError, AgentTerminalLease, AgentTerminalProvider, CommandPromptMarker,
    CommandStreamUpdate, TerminalCommandStream, TerminalInputObservation,
};

const TERMINAL_EVENT_WAIT_MAX: Duration = Duration::from_secs(600);

#[derive(Clone)]
pub struct TmuxAgentTerminalProvider {
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
}

impl TmuxAgentTerminalProvider {
    pub fn new(registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl AgentTerminalProvider for TmuxAgentTerminalProvider {
    async fn acquire(
        &self,
        device_id: &str,
        pane_id: &str,
    ) -> Result<Box<dyn AgentTerminalLease>, AgentPortError> {
        let runtime_handle = Handle::try_current()
            .map_err(|_| AgentPortError::new("terminal runtime requires a Tokio executor"))?;
        let runtime = self
            .registry
            .acquire(device_id)
            .await
            .map_err(|error| terminal_error("failed to acquire terminal runtime", error))?;
        Ok(Box::new(TmuxAgentTerminalLease {
            reference: RegistryReference::new(
                self.registry.clone(),
                device_id.to_owned(),
                runtime,
                runtime_handle,
            ),
            pane_id: pane_id.to_owned(),
            closed: false,
        }))
    }
}

pub struct TmuxAgentTerminalLease {
    reference: RegistryReference,
    pane_id: String,
    closed: bool,
}

impl TmuxAgentTerminalLease {
    fn runtime(&self) -> Result<&Arc<DeviceSessionRuntime>, AgentPortError> {
        if self.closed {
            return Err(AgentPortError::new("terminal lease is closed"));
        }
        Ok(&self.reference.runtime)
    }
}

#[async_trait]
impl AgentTerminalLease for TmuxAgentTerminalLease {
    fn is_terminated(&self) -> bool {
        self.closed || self.reference.runtime.is_terminated()
    }

    async fn capture_pane_text(&mut self, history_lines: usize) -> Result<String, AgentPortError> {
        self.runtime()?
            .capture_pane_text(&self.pane_id, Some(history_lines))
            .await
            .map_err(|error| terminal_error("failed to capture terminal pane", error))
    }

    async fn get_pane_info(&mut self) -> Result<PaneInfo, AgentPortError> {
        enriched_pane_info(self.runtime()?, &self.pane_id).await
    }

    async fn send_input_and_observe(
        &mut self,
        data: &str,
        settle: Duration,
    ) -> Result<TerminalInputObservation, AgentPortError> {
        let runtime = self.runtime()?.clone();
        let mut events = runtime.subscribe();
        runtime
            .send_input_bytes(&self.pane_id, data.as_bytes())
            .await
            .map_err(|error| terminal_error("failed to send terminal input", error))?;
        let mut cursor = PaneEventCursor::default();
        let observed = collect_pane_events(&mut events, &self.pane_id, &mut cursor, settle).await?;
        let rendered_screen = runtime
            .capture_pane_text(&self.pane_id, Some(0))
            .await
            .map_err(|error| terminal_error("failed to capture terminal pane", error))?;
        let pane_info = runtime
            .pane_info(&self.pane_id)
            .await
            .map_err(|error| terminal_error("failed to read terminal pane info", error))?;
        Ok(TerminalInputObservation {
            bytes: observed.into_bytes(),
            rendered_screen: Some(rendered_screen),
            alternate_screen: pane_info.alternate_screen,
            pane_info: Some(pane_info),
        })
    }

    async fn open_command_stream(
        &mut self,
    ) -> Result<Box<dyn TerminalCommandStream>, AgentPortError> {
        let runtime = self.runtime()?.clone();
        let events = runtime.subscribe();
        let initial_screen = runtime
            .capture_pane_text(&self.pane_id, Some(0))
            .await
            .map_err(|error| terminal_error("failed to capture initial terminal screen", error))?;
        let initial_info = runtime
            .pane_info(&self.pane_id)
            .await
            .map_err(|error| terminal_error("failed to read initial terminal pane info", error))?;
        Ok(Box::new(TmuxAgentCommandStream {
            runtime,
            pane_id: self.pane_id.clone(),
            events: Some(events),
            initial_screen,
            initial_alternate_screen: initial_info.alternate_screen,
            cursor: PaneEventCursor::default(),
            command_boundary_pending: true,
        }))
    }

    async fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.reference.release().await;
    }
}

impl Drop for TmuxAgentTerminalLease {
    fn drop(&mut self) {
        self.closed = true;
    }
}

struct RegistryReference {
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    device_id: String,
    runtime: Arc<DeviceSessionRuntime>,
    runtime_handle: Handle,
    released: bool,
    release_task: Option<JoinHandle<()>>,
}

impl RegistryReference {
    fn new(
        registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
        device_id: String,
        runtime: Arc<DeviceSessionRuntime>,
        runtime_handle: Handle,
    ) -> Self {
        Self {
            registry,
            device_id,
            runtime,
            runtime_handle,
            released: false,
            release_task: None,
        }
    }

    fn begin_release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let registry = self.registry.clone();
        let device_id = self.device_id.clone();
        let runtime = self.runtime.clone();
        self.release_task = Some(self.runtime_handle.spawn(async move {
            registry.release(&device_id, Some(&runtime)).await;
        }));
    }

    async fn release(&mut self) {
        self.begin_release();
        if let Some(task) = self.release_task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for RegistryReference {
    fn drop(&mut self) {
        self.begin_release();
        drop(self.release_task.take());
    }
}

struct TmuxAgentCommandStream {
    runtime: Arc<DeviceSessionRuntime>,
    pane_id: String,
    events: Option<broadcast::Receiver<TmuxRuntimeEvent>>,
    initial_screen: String,
    initial_alternate_screen: bool,
    cursor: PaneEventCursor,
    command_boundary_pending: bool,
}

#[async_trait]
impl TerminalCommandStream for TmuxAgentCommandStream {
    fn initial_screen(&self) -> &str {
        &self.initial_screen
    }

    fn initial_alternate_screen(&self) -> bool {
        self.initial_alternate_screen
    }

    async fn send_input(&mut self, data: &str) -> Result<(), AgentPortError> {
        if self.command_boundary_pending {
            let events = self
                .events
                .as_mut()
                .ok_or_else(|| AgentPortError::new("terminal command stream is closed"))?;
            drain_precommand_events(events, RUNTIME_EVENT_QUEUE_CAPACITY)?;
            self.cursor = PaneEventCursor::default();
        } else if self.events.is_none() {
            return Err(AgentPortError::new("terminal command stream is closed"));
        }
        self.runtime
            .send_input_bytes(&self.pane_id, data.as_bytes())
            .await
            .map_err(|error| terminal_error("failed to send terminal command input", error))?;
        self.command_boundary_pending = false;
        Ok(())
    }

    async fn poll(&mut self, wait: Duration) -> Result<CommandStreamUpdate, AgentPortError> {
        let pane_id = self.pane_id.clone();
        let (events, cursor) = (&mut self.events, &mut self.cursor);
        let events = events
            .as_mut()
            .ok_or_else(|| AgentPortError::new("terminal command stream is closed"))?;
        let observed = collect_pane_events(events, &pane_id, cursor, wait).await?;
        let pane_info = self
            .runtime
            .pane_info(&self.pane_id)
            .await
            .map_err(|error| terminal_error("failed to read terminal command pane info", error))?;
        Ok(observed.into_command_update(pane_info.alternate_screen))
    }

    async fn close(&mut self) {
        self.events.take();
    }
}

async fn enriched_pane_info(
    runtime: &DeviceSessionRuntime,
    pane_id: &str,
) -> Result<PaneInfo, AgentPortError> {
    let info = runtime
        .pane_info(pane_id)
        .await
        .map_err(|error| terminal_error("failed to read terminal pane info", error))?;
    let snapshot = runtime
        .current_snapshot()
        .await
        .map_err(|error| terminal_error("failed to read terminal snapshot", error))?;
    let mut info = merge_pane_snapshot(info, snapshot.as_ref(), pane_id)?;
    fill_entry_environment(&mut info);
    Ok(info)
}

fn merge_pane_snapshot(
    mut info: PaneInfo,
    snapshot: Option<&StateSnapshot>,
    pane_id: &str,
) -> Result<PaneInfo, AgentPortError> {
    let Some(session) = snapshot.and_then(|snapshot| snapshot.session.as_ref()) else {
        return Ok(info);
    };
    let Some((window, pane)) = session.windows.iter().find_map(|window| {
        window
            .panes
            .iter()
            .find(|pane| pane.id == pane_id)
            .map(|pane| (window, pane))
    }) else {
        return Err(AgentPortError::new(
            "Bound pane no longer exists in snapshot.",
        ));
    };
    if info.title.is_none() {
        info.title = pane.title.clone();
    }
    if info.current_path.is_none() {
        info.current_path = pane.current_path.clone();
    }
    if info.window_name.is_none() {
        info.window_name = Some(window.name.clone());
    }
    if info.window_id.is_none() {
        info.window_id = Some(window.id.clone());
    }
    if info.session_id.is_none() {
        info.session_id = Some(session.id.clone());
    }
    if info.session_name.is_none() {
        info.session_name = Some(session.name.clone());
    }
    if info.split_pane_count.is_none() {
        info.split_pane_count = Some(window.panes.len());
    }
    Ok(info)
}

fn fill_entry_environment(info: &mut PaneInfo) {
    if info.term.is_none() {
        info.term = std::env::var("TERM").ok();
    }
    if info.term_program.is_none() {
        info.term_program = std::env::var("TERM_PROGRAM").ok();
    }
    if info.locale.is_none() {
        info.locale = std::env::var("LANG")
            .ok()
            .or_else(|| std::env::var("LC_ALL").ok());
    }
    if info.encoding.is_none() {
        info.encoding = Some("utf-8".to_owned());
    }
}

fn drain_precommand_events(
    receiver: &mut broadcast::Receiver<TmuxRuntimeEvent>,
    max_events: usize,
) -> Result<(), AgentPortError> {
    let mut drained = 0;
    let mut discarded_lag = false;
    while drained < max_events {
        match receiver.try_recv() {
            Ok(TmuxRuntimeEvent::Closed { device_id, manual }) => {
                return Err(runtime_closed_error(&device_id, manual));
            }
            Ok(_) => drained += 1,
            Err(broadcast::error::TryRecvError::Lagged(_)) if !discarded_lag => {
                discarded_lag = true;
            }
            Err(broadcast::error::TryRecvError::Lagged(_)) => {
                return Err(AgentPortError::new(
                    "terminal command boundary remained busy; command was not sent",
                ));
            }
            Err(broadcast::error::TryRecvError::Empty) => return Ok(()),
            Err(broadcast::error::TryRecvError::Closed) => {
                return Err(AgentPortError::new("terminal event stream closed"));
            }
        }
    }
    match receiver.try_recv() {
        Err(broadcast::error::TryRecvError::Empty) => Ok(()),
        Ok(TmuxRuntimeEvent::Closed { device_id, manual }) => {
            Err(runtime_closed_error(&device_id, manual))
        }
        Err(broadcast::error::TryRecvError::Closed) => {
            Err(AgentPortError::new("terminal event stream closed"))
        }
        Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => Err(AgentPortError::new(
            "terminal command boundary remained busy; command was not sent",
        )),
    }
}

#[derive(Debug, Default)]
struct PaneEventCursor {
    current: Option<(WireToken, u64)>,
}

impl PaneEventCursor {
    fn observe(&mut self, segment: &PaneDataSegment) -> Result<(), AgentPortError> {
        let data_len = u64::try_from(segment.data.len()).map_err(|_| {
            AgentPortError::new(format!(
                "terminal segment is too large for pane {}",
                segment.pane_id
            ))
        })?;
        if segment.seq_start.checked_add(data_len) != Some(segment.seq_end) {
            return Err(AgentPortError::new(format!(
                "terminal segment has an invalid sequence range for pane {}",
                segment.pane_id
            )));
        }
        if let Some((pane_epoch, expected_seq)) = self.current {
            if pane_epoch != segment.pane_epoch {
                return Err(AgentPortError::new(format!(
                    "terminal pane epoch changed for pane {}",
                    segment.pane_id
                )));
            }
            if expected_seq != segment.seq_start {
                return Err(AgentPortError::new(format!(
                    "terminal event gap for pane {}: expected sequence {expected_seq}, received sequence {}",
                    segment.pane_id, segment.seq_start
                )));
            }
        }
        self.current = Some((segment.pane_epoch, segment.seq_end));
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ObservedPaneEvent {
    Bytes(Vec<u8>),
    PromptMarker(CommandPromptMarker),
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ObservedPaneEvents {
    events: Vec<ObservedPaneEvent>,
}

impl ObservedPaneEvents {
    fn push(
        &mut self,
        event: TmuxRuntimeEvent,
        pane_id: &str,
        cursor: &mut PaneEventCursor,
    ) -> Result<(), AgentPortError> {
        match event {
            TmuxRuntimeEvent::Terminal(segment) if segment.pane_id == pane_id => {
                cursor.observe(&segment)?;
                self.events.push(ObservedPaneEvent::Bytes(segment.data));
            }
            TmuxRuntimeEvent::PromptMarker {
                pane_id: event_pane_id,
                marker,
            } if event_pane_id == pane_id => {
                self.events
                    .push(ObservedPaneEvent::PromptMarker(map_prompt_marker(marker)));
            }
            TmuxRuntimeEvent::ReplayGap(gap) if gap.pane_id == pane_id => {
                return Err(AgentPortError::new(format!(
                    "terminal replay gap for pane {pane_id}: expected sequence {}, available sequence {}",
                    gap.expected_seq, gap.available_seq
                )));
            }
            TmuxRuntimeEvent::Closed { device_id, manual } => {
                return Err(runtime_closed_error(&device_id, manual));
            }
            _ => {}
        }
        Ok(())
    }

    fn into_bytes(self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for event in self.events {
            if let ObservedPaneEvent::Bytes(chunk) = event {
                bytes.extend(chunk);
            }
        }
        bytes
    }

    fn into_command_update(self, alternate_screen: bool) -> CommandStreamUpdate {
        let mut update = CommandStreamUpdate {
            alternate_screen,
            ..CommandStreamUpdate::default()
        };
        for event in self.events {
            match event {
                ObservedPaneEvent::Bytes(chunk) => update.bytes.extend(chunk),
                ObservedPaneEvent::PromptMarker(marker) => update.markers.push(marker),
            }
        }
        update
    }
}

async fn collect_pane_events(
    receiver: &mut broadcast::Receiver<TmuxRuntimeEvent>,
    pane_id: &str,
    cursor: &mut PaneEventCursor,
    wait: Duration,
) -> Result<ObservedPaneEvents, AgentPortError> {
    let deadline = Instant::now() + wait.min(TERMINAL_EVENT_WAIT_MAX);
    let mut observed = ObservedPaneEvents::default();
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match timeout_at(deadline, receiver.recv()).await {
            Ok(Ok(event)) => observed.push(event, pane_id, cursor)?,
            Ok(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                return Err(lagged_error(skipped));
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                return Err(AgentPortError::new("terminal event stream closed"));
            }
            Err(_) => break,
        }
    }
    for _ in 0..RUNTIME_EVENT_QUEUE_CAPACITY {
        match receiver.try_recv() {
            Ok(event) => observed.push(event, pane_id, cursor)?,
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                return Err(lagged_error(skipped));
            }
            Err(broadcast::error::TryRecvError::Closed) => {
                return Err(AgentPortError::new("terminal event stream closed"));
            }
        }
    }
    Ok(observed)
}

fn map_prompt_marker(marker: PromptMarker) -> CommandPromptMarker {
    CommandPromptMarker {
        kind: match marker.kind {
            PromptMarkerKind::A => 'A',
            PromptMarkerKind::B => 'B',
            PromptMarkerKind::C => 'C',
            PromptMarkerKind::D => 'D',
        },
        exit_code: marker.exit_code,
        params: marker.params,
    }
}

fn lagged_error(skipped: u64) -> AgentPortError {
    AgentPortError::new(format!(
        "terminal event stream lagged and lost {skipped} messages"
    ))
}

fn runtime_closed_error(device_id: &str, manual: bool) -> AgentPortError {
    AgentPortError::new(format!(
        "terminal runtime closed for device {device_id} (manual={manual})"
    ))
}

fn terminal_error(context: &str, error: impl std::fmt::Display) -> AgentPortError {
    AgentPortError::new(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tmux::{
        ControlClient, DeviceSessionConfig, DeviceSessionRuntimeError, LocalTmuxConfig,
        RuntimeRegistryError, StandaloneSpawnPolicy, TmuxCommandResult, TmuxRuntimeFactory,
        TmuxTransport, TmuxTransportConfig, TmuxTransportError, TmuxTransportFactory,
        TMEX_SERVER_EPOCH_OPTION,
    };
    use tmex_protocol::SessionWire;
    use tokio::sync::Notify;
    use tokio::time::timeout;

    use super::*;

    struct ReleaseTestTransport {
        close_calls: Arc<AtomicUsize>,
        close_finished: Arc<AtomicUsize>,
        close_gate: Option<Arc<Notify>>,
    }

    #[async_trait]
    impl TmuxTransport for ReleaseTestTransport {
        async fn run_tmux(
            &self,
            args: &[String],
            _deadline: Duration,
            _output_limit: usize,
        ) -> Result<TmuxCommandResult, TmuxTransportError> {
            let stdout = if args == ["-V"] {
                "tmux 3.4\n"
            } else if args.first().map(String::as_str) == Some("show-options")
                && args.last().map(String::as_str) == Some(TMEX_SERVER_EPOCH_OPTION)
            {
                "00000000000000000000000000000000\n"
            } else if args.first().map(String::as_str) == Some("display-message")
                && args.last().map(String::as_str) == Some("#{session_windows}")
            {
                "1\n"
            } else {
                ""
            };
            Ok(TmuxCommandResult {
                exit_code: 0,
                stdout: stdout.to_owned(),
                stderr: String::new(),
            })
        }

        async fn open_control(
            &self,
            _session_name: &str,
        ) -> Result<ControlClient, TmuxTransportError> {
            Err(TmuxTransportError::Closed)
        }

        fn home_dir(&self) -> Option<&str> {
            Some("/tmp")
        }

        fn tmux_bin(&self) -> &str {
            "unused"
        }

        async fn close(&self) -> Result<(), TmuxTransportError> {
            self.close_calls.fetch_add(1, Ordering::AcqRel);
            if let Some(gate) = &self.close_gate {
                gate.notified().await;
            }
            self.close_finished.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }

    struct ReleaseTestTransportFactory {
        transport: Arc<ReleaseTestTransport>,
    }

    #[async_trait]
    impl TmuxTransportFactory for ReleaseTestTransportFactory {
        async fn create(
            &self,
            _config: &DeviceSessionConfig,
        ) -> Result<Arc<dyn TmuxTransport>, DeviceSessionRuntimeError> {
            Ok(self.transport.clone())
        }
    }

    fn release_test_config(device_id: &str) -> DeviceSessionConfig {
        DeviceSessionConfig {
            device_id: device_id.to_owned(),
            device_name: None,
            session_name: "tmex-agent-terminal-release-test".to_owned(),
            default_working_dir: Some("/tmp".to_owned()),
            tmux_term_program: "off".to_owned(),
            tmux_window_style: String::new(),
            allow_passthrough: false,
            enable_control_mode: false,
            transport: TmuxTransportConfig::Local(LocalTmuxConfig {
                tmux_bin: "unused".to_owned(),
                socket_name: Some("tmex-agent-terminal-release-test".to_owned()),
                environment: BTreeMap::new(),
            }),
            spawn_policy: Arc::new(StandaloneSpawnPolicy),
        }
    }

    fn release_test_registry(
        device_id: &'static str,
        close_gate: Option<Arc<Notify>>,
    ) -> (
        Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let close_calls = Arc::new(AtomicUsize::new(0));
        let close_finished = Arc::new(AtomicUsize::new(0));
        let transport = Arc::new(ReleaseTestTransport {
            close_calls: close_calls.clone(),
            close_finished: close_finished.clone(),
            close_gate,
        });
        let factory: Arc<dyn TmuxRuntimeFactory<DeviceSessionRuntime>> = Arc::new(move |_| {
            let transport_factory: Arc<dyn TmuxTransportFactory> =
                Arc::new(ReleaseTestTransportFactory {
                    transport: transport.clone(),
                });
            async move {
                DeviceSessionRuntime::start(release_test_config(device_id), transport_factory)
                    .await
                    .map(Arc::new)
                    .map_err(|error| RuntimeRegistryError::new(error.to_string()))
            }
        });
        (
            Arc::new(TmuxRuntimeRegistry::new(factory)),
            close_calls,
            close_finished,
        )
    }

    async fn wait_for_close_calls(calls: &AtomicUsize, expected: usize) {
        timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::Acquire) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("runtime release timed out");
    }

    #[tokio::test]
    async fn lease_close_drop_and_cancel_release_each_registry_reference_once() {
        let (registry, close_calls, close_finished) = release_test_registry("close-device", None);
        let provider = TmuxAgentTerminalProvider::new(registry);
        let mut lease = provider.acquire("close-device", "%1").await.unwrap();
        lease.close().await;
        lease.close().await;
        drop(lease);
        assert_eq!(close_calls.load(Ordering::Acquire), 1);
        assert_eq!(close_finished.load(Ordering::Acquire), 1);

        let (registry, close_calls, close_finished) = release_test_registry("drop-device", None);
        let provider = TmuxAgentTerminalProvider::new(registry);
        let lease = provider.acquire("drop-device", "%1").await.unwrap();
        drop(lease);
        wait_for_close_calls(&close_calls, 1).await;
        wait_for_close_calls(&close_finished, 1).await;
        assert_eq!(close_calls.load(Ordering::Acquire), 1);

        let gate = Arc::new(Notify::new());
        let (registry, close_calls, close_finished) =
            release_test_registry("cancel-device", Some(gate.clone()));
        let provider = TmuxAgentTerminalProvider::new(registry);
        let mut lease = provider.acquire("cancel-device", "%1").await.unwrap();
        let closing = tokio::spawn(async move {
            lease.close().await;
        });
        wait_for_close_calls(&close_calls, 1).await;
        closing.abort();
        gate.notify_waiters();
        wait_for_close_calls(&close_finished, 1).await;
        assert_eq!(close_calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn pane_subscription_keeps_first_bytes_and_prompt_marker_fifo() {
        let (sender, _) = broadcast::channel(8);
        let mut receiver = sender.subscribe();
        let epoch = [7; 16];
        sender
            .send(TmuxRuntimeEvent::Terminal(PaneDataSegment {
                pane_id: "%other".to_owned(),
                pane_epoch: epoch,
                seq_start: 0,
                seq_end: 5,
                data: b"other".to_vec(),
            }))
            .unwrap();
        sender
            .send(TmuxRuntimeEvent::Terminal(PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 0,
                seq_end: 5,
                data: b"first".to_vec(),
            }))
            .unwrap();
        sender
            .send(TmuxRuntimeEvent::PromptMarker {
                pane_id: "%1".to_owned(),
                marker: PromptMarker {
                    kind: PromptMarkerKind::D,
                    exit_code: Some(17),
                    params: vec!["tmex=n1".to_owned()],
                },
            })
            .unwrap();
        sender
            .send(TmuxRuntimeEvent::Terminal(PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 5,
                seq_end: 6,
                data: b"!".to_vec(),
            }))
            .unwrap();

        let mut cursor = PaneEventCursor::default();
        let observed = collect_pane_events(&mut receiver, "%1", &mut cursor, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(
            observed.events,
            vec![
                ObservedPaneEvent::Bytes(b"first".to_vec()),
                ObservedPaneEvent::PromptMarker(CommandPromptMarker {
                    kind: 'D',
                    exit_code: Some(17),
                    params: vec!["tmex=n1".to_owned()],
                }),
                ObservedPaneEvent::Bytes(b"!".to_vec()),
            ]
        );
    }

    #[test]
    fn snapshot_with_session_but_without_bound_pane_fails_fast() {
        let info = crate::tmux::parse_pane_meta("80 24 0 0 0 bash");
        let snapshot = StateSnapshot {
            device_id: "device".to_owned(),
            session: Some(SessionWire {
                id: "$1".to_owned(),
                name: "session".to_owned(),
                windows: Vec::new(),
            }),
        };

        let error = merge_pane_snapshot(info, Some(&snapshot), "%missing").unwrap_err();
        assert_eq!(error.message(), "Bound pane no longer exists in snapshot.");
    }

    #[tokio::test]
    async fn command_boundary_discards_stale_output_and_fails_when_drain_stays_busy() {
        let (sender, _) = broadcast::channel(8);
        let mut receiver = sender.subscribe();
        let epoch = [9; 16];
        sender
            .send(TmuxRuntimeEvent::Terminal(PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 0,
                seq_end: 5,
                data: b"stale".to_vec(),
            }))
            .unwrap();
        sender
            .send(TmuxRuntimeEvent::PromptMarker {
                pane_id: "%1".to_owned(),
                marker: PromptMarker {
                    kind: PromptMarkerKind::D,
                    exit_code: Some(1),
                    params: vec!["tmex=old".to_owned()],
                },
            })
            .unwrap();
        drain_precommand_events(&mut receiver, RUNTIME_EVENT_QUEUE_CAPACITY).unwrap();

        sender
            .send(TmuxRuntimeEvent::Terminal(PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 100,
                seq_end: 103,
                data: b"new".to_vec(),
            }))
            .unwrap();
        let mut cursor = PaneEventCursor::default();
        let observed = collect_pane_events(&mut receiver, "%1", &mut cursor, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(
            observed.events,
            vec![ObservedPaneEvent::Bytes(b"new".to_vec())]
        );

        let (busy_sender, _) = broadcast::channel(2);
        let mut busy_receiver = busy_sender.subscribe();
        for message in ["one", "two"] {
            busy_sender
                .send(TmuxRuntimeEvent::Error {
                    device_id: "device".to_owned(),
                    message: message.to_owned(),
                })
                .unwrap();
        }
        let error = drain_precommand_events(&mut busy_receiver, 1).unwrap_err();
        assert_eq!(
            error.message(),
            "terminal command boundary remained busy; command was not sent"
        );
    }
}
