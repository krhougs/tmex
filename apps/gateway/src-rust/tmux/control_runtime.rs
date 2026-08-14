use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use super::{
    capture_pane_frame_at_control_barrier, AtomicPaneCapture, AtomicPaneCaptureError,
    ControlCommandOptions, ControlModeCommandQueue, ControlModeQueueError, ControlModeSubscription,
    ControlModeSubscriptionEvent, TmuxTransport, TmuxTransportError, CONTROL_ATTACH_READY_TIMEOUT,
    CONTROL_CHUNK_QUEUE_CAPACITY, CONTROL_STDERR_TAIL_LIMIT, HEARTBEAT_TIMEOUT,
    SOURCE_METADATA_SUBSCRIPTION_COMMANDS,
};

const CONTROL_COMMAND_CAPACITY: usize = 256;

#[derive(Debug)]
pub enum ControlRuntimeError {
    Transport(TmuxTransportError),
    Queue(ControlModeQueueError),
    Capture(AtomicPaneCaptureError),
    AttachTimedOut,
    Closed,
    Backpressure,
    TaskPanicked(&'static str),
}

impl fmt::Display for ControlRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(formatter),
            Self::Queue(error) => error.fmt(formatter),
            Self::Capture(error) => error.fmt(formatter),
            Self::AttachTimedOut => formatter.write_str("tmux control attach did not become ready"),
            Self::Closed => formatter.write_str("tmux control runtime is closed"),
            Self::Backpressure => formatter.write_str("tmux control command queue is full"),
            Self::TaskPanicked(task) => write!(formatter, "tmux control {task} task panicked"),
        }
    }
}

impl std::error::Error for ControlRuntimeError {}

impl From<TmuxTransportError> for ControlRuntimeError {
    fn from(value: TmuxTransportError) -> Self {
        Self::Transport(value)
    }
}

impl From<ControlModeQueueError> for ControlRuntimeError {
    fn from(value: ControlModeQueueError) -> Self {
        Self::Queue(value)
    }
}

impl From<AtomicPaneCaptureError> for ControlRuntimeError {
    fn from(value: AtomicPaneCaptureError) -> Self {
        Self::Capture(value)
    }
}

enum ControlRequest {
    Capture {
        pane_id: String,
        history_lines: usize,
        on_barrier: Box<dyn FnOnce() + Send>,
        response: oneshot::Sender<Result<AtomicPaneCapture, ControlRuntimeError>>,
    },
    Heartbeat,
    Execute {
        command: String,
        timeout: Duration,
        response: oneshot::Sender<Result<(), ControlRuntimeError>>,
    },
    Raw(String),
    Stop {
        response: oneshot::Sender<()>,
    },
}

enum ProcessEvent {
    Chunk(Vec<u8>),
    Exited { exit_code: i32, stderr_tail: String },
}

#[derive(Clone)]
pub struct ControlRuntimeHandle {
    requests: mpsc::Sender<ControlRequest>,
}

impl ControlRuntimeHandle {
    pub async fn capture_pane_frame_at_barrier<Barrier>(
        &self,
        pane_id: impl Into<String>,
        history_lines: usize,
        on_barrier: Barrier,
    ) -> Result<AtomicPaneCapture, ControlRuntimeError>
    where
        Barrier: FnOnce() + Send + 'static,
    {
        let (response, receiver) = oneshot::channel();
        self.requests
            .send(ControlRequest::Capture {
                pane_id: pane_id.into(),
                history_lines,
                on_barrier: Box::new(on_barrier),
                response,
            })
            .await
            .map_err(|_| ControlRuntimeError::Closed)?;
        receiver.await.map_err(|_| ControlRuntimeError::Closed)?
    }

    pub fn heartbeat(&self) -> Result<(), ControlRuntimeError> {
        self.requests
            .try_send(ControlRequest::Heartbeat)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ControlRuntimeError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => ControlRuntimeError::Closed,
            })
    }

    pub async fn execute(
        &self,
        command: impl Into<String>,
        command_timeout: Duration,
    ) -> Result<(), ControlRuntimeError> {
        let (response, receiver) = oneshot::channel();
        self.requests
            .send(ControlRequest::Execute {
                command: command.into(),
                timeout: command_timeout,
                response,
            })
            .await
            .map_err(|_| ControlRuntimeError::Closed)?;
        receiver.await.map_err(|_| ControlRuntimeError::Closed)?
    }

    pub fn write_raw(&self, command: impl Into<String>) -> Result<(), ControlRuntimeError> {
        self.requests
            .try_send(ControlRequest::Raw(command.into()))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ControlRuntimeError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => ControlRuntimeError::Closed,
            })
    }

    pub async fn stop(&self) {
        let (response, receiver) = oneshot::channel();
        if self
            .requests
            .send(ControlRequest::Stop { response })
            .await
            .is_ok()
        {
            let _ = receiver.await;
        }
    }
}

pub async fn start_control_runtime(
    transport: Arc<dyn TmuxTransport>,
    session_name: &str,
    events: mpsc::Sender<ControlModeSubscriptionEvent>,
) -> Result<ControlRuntimeHandle, ControlRuntimeError> {
    let control = transport.open_control(session_name).await?;
    let (wire_tx, wire_rx) = mpsc::channel::<String>(CONTROL_COMMAND_CAPACITY);
    let (process_tx, process_rx) = mpsc::channel(CONTROL_CHUNK_QUEUE_CAPACITY);
    let (stop_tx, stop_rx) = oneshot::channel();
    let process_failure_tx = process_tx.clone();
    tokio::spawn(async move {
        if AssertUnwindSafe(drive_control_process(control, wire_rx, process_tx, stop_rx))
            .catch_unwind()
            .await
            .is_err()
        {
            let _ = process_failure_tx
                .send(ProcessEvent::Exited {
                    exit_code: -1,
                    stderr_tail: "tmux control process task panicked".to_owned(),
                })
                .await;
        }
    });

    let queue = ControlModeCommandQueue::new();
    let subscription = ControlModeSubscription::with_command_queue(queue.guard());
    let (request_tx, request_rx) = mpsc::channel(CONTROL_COMMAND_CAPACITY);
    let (ready_tx, ready_rx) = oneshot::channel();
    let runtime_failure_events = events.clone();
    tokio::spawn(async move {
        if AssertUnwindSafe(run_control_runtime(
            subscription,
            queue,
            wire_tx,
            process_rx,
            request_rx,
            events,
            stop_tx,
            ready_tx,
        ))
        .catch_unwind()
        .await
        .is_err()
        {
            let _ = runtime_failure_events
                .send(ControlModeSubscriptionEvent::Exit {
                    reason: Some("tmux control runtime task panicked".to_owned()),
                })
                .await;
        }
    });
    let handle = ControlRuntimeHandle {
        requests: request_tx,
    };
    let attach = timeout(CONTROL_ATTACH_READY_TIMEOUT, ready_rx).await;
    match attach {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            handle.stop().await;
            return Err(ControlRuntimeError::Closed);
        }
        Err(_) => {
            handle.stop().await;
            return Err(ControlRuntimeError::AttachTimedOut);
        }
    }
    for command in SOURCE_METADATA_SUBSCRIPTION_COMMANDS {
        handle.write_raw(command.to_owned())?;
    }
    Ok(handle)
}

#[allow(clippy::too_many_arguments)]
async fn run_control_runtime(
    mut subscription: ControlModeSubscription,
    queue: ControlModeCommandQueue,
    wire: mpsc::Sender<String>,
    mut process: mpsc::Receiver<ProcessEvent>,
    mut requests: mpsc::Receiver<ControlRequest>,
    events: mpsc::Sender<ControlModeSubscriptionEvent>,
    process_stop: oneshot::Sender<()>,
    ready: oneshot::Sender<()>,
) {
    let mut ready = Some(ready);
    let mut process_stop = Some(process_stop);
    let mut exit_reason = None;
    loop {
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { break; };
                match request {
                    ControlRequest::Capture { pane_id, history_lines, on_barrier, response } => {
                        let queue = queue.clone();
                        let wire = wire.clone();
                        tokio::spawn(async move {
                            let result = AssertUnwindSafe(capture_pane_frame_at_control_barrier(
                                &queue,
                                move |command| wire.try_send(command.to_owned()),
                                &pane_id,
                                history_lines,
                                on_barrier,
                                Duration::from_secs(30),
                            )).catch_unwind().await;
                            let result = match result {
                                Ok(result) => result.map_err(ControlRuntimeError::from),
                                Err(_) => Err(ControlRuntimeError::TaskPanicked("capture")),
                            };
                            let _ = response.send(result);
                        });
                    }
                    ControlRequest::Heartbeat => {
                        let queue = queue.clone();
                        let wire = wire.clone();
                        let command = queue.execute(
                            &mut |command| wire.try_send(command.to_owned()),
                            "display-message -p \"tmex-hb\"",
                            ControlCommandOptions { timeout: HEARTBEAT_TIMEOUT, literal: false },
                            |_| Ok(()),
                        );
                        tokio::spawn(async move {
                            let _ = AssertUnwindSafe(command).catch_unwind().await;
                        });
                    }
                    ControlRequest::Execute { command, timeout, response } => {
                        let queue = queue.clone();
                        let wire = wire.clone();
                        let pending = queue.execute(
                            &mut |command| wire.try_send(command.to_owned()),
                            command,
                            ControlCommandOptions { timeout, literal: false },
                            |_| Ok(()),
                        );
                        tokio::spawn(async move {
                            let result = match AssertUnwindSafe(pending).catch_unwind().await {
                                Ok(result) => result.map_err(ControlRuntimeError::from),
                                Err(_) => Err(ControlRuntimeError::TaskPanicked("command")),
                            };
                            let _ = response.send(result);
                        });
                    }
                    ControlRequest::Raw(command) => {
                        if wire.send(ensure_newline(command)).await.is_err() { break; }
                    }
                    ControlRequest::Stop { response } => {
                        queue.dispose("tmux control runtime stopped");
                        subscription.dispose();
                        if let Some(stop) = process_stop.take() { let _ = stop.send(()); }
                        let _ = response.send(());
                        return;
                    }
                }
            }
            process_event = process.recv() => {
                let Some(process_event) = process_event else { break; };
                match process_event {
                    ProcessEvent::Chunk(chunk) => {
                        let projected = subscription.push(&chunk, system_time_ms());
                        if !projected.is_empty() {
                            if let Some(ready) = ready.take() { let _ = ready.send(()); }
                        }
                        for event in projected {
                            if let ControlModeSubscriptionEvent::Exit { reason } = &event {
                                exit_reason = reason.clone();
                                continue;
                            }
                            if let ControlModeSubscriptionEvent::Pause { pane_id } = &event {
                                let _ = wire.try_send(format!("continue {pane_id}\n"));
                            }
                            if events.send(event).await.is_err() { return; }
                        }
                    }
                    ProcessEvent::Exited { exit_code, stderr_tail } => {
                        queue.dispose(format!("tmux control client exited with {exit_code}"));
                        for event in subscription.end(system_time_ms()) {
                            if let ControlModeSubscriptionEvent::Exit { reason } = &event {
                                exit_reason = reason.clone();
                                continue;
                            }
                            if events.send(event).await.is_err() { return; }
                        }
                        let reason = exit_reason.or_else(|| {
                            (!stderr_tail.trim().is_empty()).then_some(stderr_tail)
                        });
                        let _ = events.send(ControlModeSubscriptionEvent::Exit { reason }).await;
                        return;
                    }
                }
            }
        }
    }
    queue.dispose("tmux control runtime closed");
    subscription.dispose();
    if let Some(stop) = process_stop.take() {
        let _ = stop.send(());
    }
}

async fn drive_control_process(
    control: super::ControlClient,
    mut writes: mpsc::Receiver<String>,
    process_events: mpsc::Sender<ProcessEvent>,
    mut stop: oneshot::Receiver<()>,
) {
    let parts = control.into_parts();
    let mut child = parts.child;
    let mut stdin = parts.stdin;
    let mut stdout = parts.stdout;
    let mut stderr = parts.stderr;
    let mut stdout_chunk = vec![0_u8; 64 * 1024];
    let mut stderr_chunk = vec![0_u8; 1024];
    let mut stderr_tail = Vec::new();
    let mut stderr_open = true;
    let mut exit_poll = tokio::time::interval(Duration::from_millis(50));
    let exit_code = loop {
        tokio::select! {
            biased;
            _ = &mut stop => {
                stdin.shutdown().await.ok();
                child.kill().await.ok();
                break child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
            }
            write = writes.recv() => {
                let Some(write) = write else {
                    stdin.shutdown().await.ok();
                    child.kill().await.ok();
                    break child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
                };
                if stdin.write_all(write.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    child.kill().await.ok();
                    break child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
                }
            }
            read = stdout.read(&mut stdout_chunk) => {
                match read {
                    Ok(0) | Err(_) => {
                        child.kill().await.ok();
                        break child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
                    }
                    Ok(read) => {
                        if process_events.send(ProcessEvent::Chunk(stdout_chunk[..read].to_vec())).await.is_err() {
                            child.kill().await.ok();
                            break child.wait().await.ok().and_then(|status| status.code()).unwrap_or(-1);
                        }
                    }
                }
            }
            read = stderr.read(&mut stderr_chunk), if stderr_open => {
                match read {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(read) => {
                        stderr_tail.extend_from_slice(&stderr_chunk[..read]);
                        let overflow = stderr_tail.len().saturating_sub(CONTROL_STDERR_TAIL_LIMIT);
                        if overflow > 0 { stderr_tail.drain(..overflow); }
                    }
                }
            }
            _ = exit_poll.tick() => {
                match child.try_wait() {
                    Ok(Some(status)) => break status.code().unwrap_or(-1),
                    Ok(None) => {}
                    Err(_) => break -1,
                }
            }
        }
    };
    let _ = process_events
        .send(ProcessEvent::Exited {
            exit_code,
            stderr_tail: String::from_utf8_lossy(&stderr_tail).into_owned(),
        })
        .await;
}

fn ensure_newline(mut command: String) -> String {
    if !command.ends_with('\n') {
        command.push('\n');
    }
    command
}

fn system_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_control_commands_are_line_delimited_once() {
        assert_eq!(ensure_newline("list-panes".to_owned()), "list-panes\n");
        assert_eq!(ensure_newline("list-panes\n".to_owned()), "list-panes\n");
    }
}
