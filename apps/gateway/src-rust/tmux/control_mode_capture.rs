use std::any::Any;
use std::collections::VecDeque;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use tmex_terminal::ControlModeBlock;
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::time::sleep;

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_STALLED_STREAM_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_HISTORY_LINES: usize = 4096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

type BoxedCommandValue = Box<dyn Any + Send>;
type CommandResult = Result<BoxedCommandValue, ControlModeQueueError>;
type CommandTransform = Box<dyn FnOnce(ControlModeBlock) -> CommandResult + Send>;
type PoisonHandler = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlModeQueueError {
    Closed(String),
    Write(String),
    TimedOut(String),
    Stalled(String),
    CommandFailed(String),
    Transform(String),
    TransformPanicked(String),
    TimerRuntimeUnavailable,
    ResponseChannelClosed,
    ResponseTypeMismatch,
}

impl fmt::Display for ControlModeQueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed(reason) | Self::Write(reason) | Self::CommandFailed(reason) => {
                formatter.write_str(reason)
            }
            Self::TimedOut(command) => {
                write!(formatter, "tmux control command timed out: {command}")
            }
            Self::Stalled(command) => {
                write!(formatter, "tmux control stream stalled: {command}")
            }
            Self::Transform(message) => formatter.write_str(message),
            Self::TransformPanicked(message) => {
                write!(
                    formatter,
                    "tmux control command transform panicked: {message}"
                )
            }
            Self::TimerRuntimeUnavailable => {
                formatter.write_str("tmux control command queue requires a Tokio runtime")
            }
            Self::ResponseChannelClosed => {
                formatter.write_str("tmux control command response channel closed")
            }
            Self::ResponseTypeMismatch => {
                formatter.write_str("tmux control command response type mismatch")
            }
        }
    }
}

impl Error for ControlModeQueueError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlCommandOptions {
    pub literal: bool,
    pub timeout: Duration,
}

impl Default for ControlCommandOptions {
    fn default() -> Self {
        Self {
            literal: false,
            timeout: DEFAULT_COMMAND_TIMEOUT,
        }
    }
}

#[must_use = "control command completion must be awaited or explicitly dropped"]
pub struct ControlCommand<T> {
    receiver: oneshot::Receiver<CommandResult>,
    marker: PhantomData<fn() -> T>,
}

impl<T> Unpin for ControlCommand<T> {}

impl<T> Future for ControlCommand<T>
where
    T: Send + 'static,
{
    type Output = Result<T, ControlModeQueueError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.receiver).poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => Poll::Ready(Err(ControlModeQueueError::ResponseChannelClosed)),
            Poll::Ready(Ok(Err(error))) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(Ok(value))) => Poll::Ready(
                value
                    .downcast::<T>()
                    .map(|value| *value)
                    .map_err(|_| ControlModeQueueError::ResponseTypeMismatch),
            ),
        }
    }
}

struct PendingCommand {
    id: u64,
    command: String,
    literal: bool,
    timeout: Duration,
    transform: Option<CommandTransform>,
    completion: Option<oneshot::Sender<CommandResult>>,
    timer_cancel: Option<oneshot::Sender<()>>,
    settled: bool,
}

struct QueueState {
    pending: VecDeque<PendingCommand>,
    poisoned: bool,
    next_id: u64,
    stalled_timeout: Duration,
    on_poison: Option<PoisonHandler>,
}

impl QueueState {
    fn new(stalled_timeout: Duration, on_poison: Option<PoisonHandler>) -> Self {
        Self {
            pending: VecDeque::new(),
            poisoned: false,
            next_id: 0,
            stalled_timeout,
            on_poison,
        }
    }
}

#[derive(Clone)]
pub struct ControlModeCommandQueue {
    shared: Arc<Mutex<QueueState>>,
}

impl Default for ControlModeCommandQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlModeCommandQueue {
    pub fn new() -> Self {
        Self::with_stalled_timeout(DEFAULT_STALLED_STREAM_TIMEOUT)
    }

    pub fn with_stalled_timeout(stalled_timeout: Duration) -> Self {
        Self {
            shared: Arc::new(Mutex::new(QueueState::new(stalled_timeout, None))),
        }
    }

    pub fn with_poison_handler<F>(stalled_timeout: Duration, on_poison: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        Self {
            shared: Arc::new(Mutex::new(QueueState::new(
                stalled_timeout,
                Some(Arc::new(on_poison)),
            ))),
        }
    }

    pub fn guard(&self) -> ControlModeQueueGuard {
        ControlModeQueueGuard {
            shared: Arc::downgrade(&self.shared),
        }
    }

    pub fn execute<T, W, WriteError, Transform>(
        &self,
        write: &mut W,
        command: impl Into<String>,
        options: ControlCommandOptions,
        transform: Transform,
    ) -> ControlCommand<T>
    where
        T: Send + 'static,
        W: FnMut(&str) -> Result<(), WriteError>,
        WriteError: fmt::Display,
        Transform: FnOnce(ControlModeBlock) -> Result<T, ControlModeQueueError> + Send + 'static,
    {
        let command = command.into();
        let (sender, receiver) = oneshot::channel();
        let mut sender = Some(sender);
        let mut enqueued = false;
        {
            let mut state = lock(&self.shared);
            if state.poisoned {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Err(ControlModeQueueError::Closed(
                        "tmux control command queue is closed".to_owned(),
                    )));
                }
            } else {
                let id = state.next_id;
                state.next_id = state.next_id.wrapping_add(1);
                state.pending.push_back(PendingCommand {
                    id,
                    command: command.clone(),
                    literal: options.literal,
                    timeout: options.timeout,
                    transform: Some(Box::new(move |block| {
                        transform(block).map(|value| Box::new(value) as BoxedCommandValue)
                    })),
                    completion: sender.take(),
                    timer_cancel: None,
                    settled: false,
                });
                enqueued = true;
            }
        }

        if enqueued {
            if let Err(error) = arm_head_timeout(&self.shared) {
                poison(&self.shared, error, true);
            } else {
                let wire_command = if command.ends_with('\n') {
                    command.clone()
                } else {
                    format!("{command}\n")
                };
                if let Err(error) = write(&wire_command) {
                    poison(
                        &self.shared,
                        ControlModeQueueError::Write(error.to_string()),
                        true,
                    );
                }
            }
        }

        ControlCommand {
            receiver,
            marker: PhantomData,
        }
    }

    pub fn next_block_is_literal(&self) -> bool {
        lock(&self.shared)
            .pending
            .front()
            .is_some_and(|pending| pending.literal)
    }

    pub fn handle_block(&self, block: &ControlModeBlock) -> bool {
        handle_block(&self.shared, block)
    }

    pub fn dispose(&self, reason: impl Into<String>) {
        let error = ControlModeQueueError::Closed(reason.into());
        poison(&self.shared, error, false);
    }

    pub fn is_poisoned(&self) -> bool {
        lock(&self.shared).poisoned
    }
}

#[derive(Clone)]
pub struct ControlModeQueueGuard {
    shared: Weak<Mutex<QueueState>>,
}

impl ControlModeQueueGuard {
    pub fn next_block_is_literal(&self) -> bool {
        self.shared.upgrade().is_some_and(|shared| {
            lock(&shared)
                .pending
                .front()
                .is_some_and(|pending| pending.literal)
        })
    }

    pub fn handle_block(&self, block: &ControlModeBlock) -> bool {
        self.shared
            .upgrade()
            .is_some_and(|shared| handle_block(&shared, block))
    }
}

struct PreparedTimer {
    id: u64,
    duration: Duration,
    cancellation: oneshot::Receiver<()>,
    kind: TimerKind,
}

#[derive(Clone, Copy)]
enum TimerKind {
    Command,
    Stall,
}

fn arm_head_timeout(shared: &Arc<Mutex<QueueState>>) -> Result<(), ControlModeQueueError> {
    let prepared = {
        let mut state = lock(shared);
        if state.poisoned {
            return Ok(());
        }
        let Some(head) = state.pending.front_mut() else {
            return Ok(());
        };
        if head.timer_cancel.is_some() {
            return Ok(());
        }
        let (cancel, cancellation) = oneshot::channel();
        head.timer_cancel = Some(cancel);
        PreparedTimer {
            id: head.id,
            duration: head.timeout,
            cancellation,
            kind: TimerKind::Command,
        }
    };
    spawn_timer(shared, prepared)
}

fn spawn_timer(
    shared: &Arc<Mutex<QueueState>>,
    prepared: PreparedTimer,
) -> Result<(), ControlModeQueueError> {
    let handle =
        Handle::try_current().map_err(|_| ControlModeQueueError::TimerRuntimeUnavailable)?;
    let weak = Arc::downgrade(shared);
    handle.spawn(async move {
        tokio::select! {
            biased;
            _ = prepared.cancellation => {}
            _ = sleep(prepared.duration) => {
                let Some(shared) = weak.upgrade() else {
                    return;
                };
                match prepared.kind {
                    TimerKind::Command => command_timed_out(&shared, prepared.id),
                    TimerKind::Stall => stream_stalled(&shared, prepared.id),
                }
            }
        }
    });
    Ok(())
}

fn command_timed_out(shared: &Arc<Mutex<QueueState>>, id: u64) {
    let (completion, error, stall_timer) = {
        let mut state = lock(shared);
        if state.poisoned {
            return;
        }
        let stalled_timeout = state.stalled_timeout;
        let Some(head) = state.pending.front_mut() else {
            return;
        };
        if head.id != id || head.settled {
            return;
        }
        head.timer_cancel = None;
        head.settled = true;
        let error = ControlModeQueueError::TimedOut(command_preview(&head.command));
        let completion = head.completion.take();
        let (cancel, cancellation) = oneshot::channel();
        head.timer_cancel = Some(cancel);
        let timer = PreparedTimer {
            id,
            duration: stalled_timeout,
            cancellation,
            kind: TimerKind::Stall,
        };
        (completion, error, timer)
    };

    if let Some(completion) = completion {
        let _ = completion.send(Err(error));
    }
    if let Err(error) = spawn_timer(shared, stall_timer) {
        poison(shared, error, true);
    }
}

fn stream_stalled(shared: &Arc<Mutex<QueueState>>, id: u64) {
    let command = {
        let state = lock(shared);
        let Some(head) = state.pending.front() else {
            return;
        };
        if state.poisoned || head.id != id || !head.settled {
            return;
        }
        command_preview(&head.command)
    };
    poison(shared, ControlModeQueueError::Stalled(command), true);
}

fn handle_block(shared: &Arc<Mutex<QueueState>>, block: &ControlModeBlock) -> bool {
    let Some(mut pending) = ({
        let mut state = lock(shared);
        state.pending.pop_front()
    }) else {
        return false;
    };
    cancel_timer(&mut pending);
    if let Err(error) = arm_head_timeout(shared) {
        poison(shared, error, true);
    }

    if pending.settled {
        return true;
    }
    let Some(completion) = pending.completion.take() else {
        return true;
    };
    if block.is_error {
        let message = block.lines.join("\n");
        let message = if message.is_empty() {
            "tmux control command failed".to_owned()
        } else {
            message
        };
        let _ = completion.send(Err(ControlModeQueueError::CommandFailed(message)));
        return true;
    }

    let Some(transform) = pending.transform.take() else {
        let _ = completion.send(Err(ControlModeQueueError::ResponseTypeMismatch));
        return true;
    };
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| transform(block.clone())))
            .unwrap_or_else(|panic| {
                Err(ControlModeQueueError::TransformPanicked(panic_message(
                    panic,
                )))
            });
    let _ = completion.send(result);
    true
}

fn poison(shared: &Arc<Mutex<QueueState>>, error: ControlModeQueueError, notify: bool) {
    let (mut pending, handler) = {
        let mut state = lock(shared);
        if state.poisoned {
            return;
        }
        state.poisoned = true;
        (
            state.pending.drain(..).collect::<Vec<_>>(),
            notify.then(|| state.on_poison.clone()).flatten(),
        )
    };

    for pending in &mut pending {
        cancel_timer(pending);
        if let Some(completion) = pending.completion.take() {
            let _ = completion.send(Err(error.clone()));
        }
    }
    if let Some(handler) = handler {
        handler();
    }
}

fn cancel_timer(pending: &mut PendingCommand) {
    if let Some(cancel) = pending.timer_cancel.take() {
        let _ = cancel.send(());
    }
}

fn lock(shared: &Arc<Mutex<QueueState>>) -> MutexGuard<'_, QueueState> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn command_preview(command: &str) -> String {
    command.chars().take(80).collect()
}

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_owned()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaneModeFlags {
    pub mouse_standard: bool,
    pub mouse_button: bool,
    pub mouse_all: bool,
    pub mouse_sgr: bool,
    pub mouse_utf8: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AtomicPaneCapture {
    pub text: String,
    pub history_text: Option<String>,
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: Option<usize>,
    pub cursor_y: Option<usize>,
    pub alternate_screen: bool,
    pub history_size: usize,
    pub modes: Option<PaneModeFlags>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AtomicPaneCaptureError {
    InvalidPaneId(String),
    Queue(ControlModeQueueError),
}

impl fmt::Display for AtomicPaneCaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPaneId(pane_id) => write!(formatter, "invalid tmux pane id: {pane_id}"),
            Self::Queue(error) => error.fmt(formatter),
        }
    }
}

impl Error for AtomicPaneCaptureError {}

impl From<ControlModeQueueError> for AtomicPaneCaptureError {
    fn from(error: ControlModeQueueError) -> Self {
        Self::Queue(error)
    }
}

struct PaneFrameInfo {
    cols: usize,
    rows: usize,
    cursor_x: Option<usize>,
    cursor_y: Option<usize>,
    alternate_screen: bool,
    history_size: usize,
    modes: PaneModeFlags,
}

pub async fn capture_pane_frame_at_control_barrier<W, WriteError, Barrier>(
    queue: &ControlModeCommandQueue,
    mut write: W,
    pane_id: &str,
    history_lines: usize,
    on_barrier: Barrier,
    timeout: Duration,
) -> Result<AtomicPaneCapture, AtomicPaneCaptureError>
where
    W: FnMut(&str) -> Result<(), WriteError>,
    WriteError: fmt::Display,
    Barrier: FnOnce() + Send + 'static,
{
    if !is_tmux_pane_id(pane_id) {
        return Err(AtomicPaneCaptureError::InvalidPaneId(pane_id.to_owned()));
    }
    let bounded_history_lines = history_lines.min(MAX_HISTORY_LINES);
    let options = ControlCommandOptions {
        timeout,
        ..ControlCommandOptions::default()
    };
    let info_command = queue.execute(
        &mut write,
        format!(
            "display-message -p -t {pane_id} \"#{{pane_width}}|#{{pane_height}}|#{{alternate_on}}|#{{cursor_x}}|#{{cursor_y}}|#{{history_size}}|#{{mouse_standard_flag}}|#{{mouse_button_flag}}|#{{mouse_all_flag}}|#{{mouse_sgr_flag}}|#{{mouse_utf8_flag}}\""
        ),
        options,
        parse_pane_frame_info,
    );
    let visible_command = format!("capture-pane -p -e -J -N -t {pane_id}");
    let text_command = queue.execute(
        &mut write,
        visible_command.clone(),
        ControlCommandOptions {
            literal: true,
            timeout,
        },
        move |block| {
            on_barrier();
            Ok(block.lines.join("\n"))
        },
    );

    let info_and_history = async move {
        let info = info_command.await?;
        let history_text =
            if bounded_history_lines == 0 || info.alternate_screen || info.history_size == 0 {
                None
            } else {
                let history_command = queue.execute(
                    &mut write,
                    format!("{visible_command} -S -{bounded_history_lines} -E -1"),
                    ControlCommandOptions {
                        literal: true,
                        timeout,
                    },
                    |block| Ok(block.lines.join("\n")),
                );
                Some(history_command.await?)
            };
        Ok::<_, ControlModeQueueError>((info, history_text))
    };

    let ((info, history_text), text) = tokio::try_join!(info_and_history, text_command)?;
    Ok(AtomicPaneCapture {
        text,
        history_text,
        cols: info.cols,
        rows: info.rows,
        cursor_x: info.cursor_x,
        cursor_y: info.cursor_y,
        alternate_screen: info.alternate_screen,
        history_size: info.history_size,
        modes: Some(info.modes),
    })
}

fn parse_pane_frame_info(block: ControlModeBlock) -> Result<PaneFrameInfo, ControlModeQueueError> {
    let fields = block
        .lines
        .first()
        .map(|line| line.split('|').collect::<Vec<_>>())
        .unwrap_or_default();
    let cols = fields
        .first()
        .and_then(|value| parse_nonnegative_integer(value));
    let rows = fields
        .get(1)
        .and_then(|value| parse_nonnegative_integer(value));
    let (Some(cols), Some(rows)) = (cols, rows) else {
        return Err(ControlModeQueueError::Transform(
            "invalid tmux pane frame info".to_owned(),
        ));
    };
    if cols == 0 || rows == 0 {
        return Err(ControlModeQueueError::Transform(
            "invalid tmux pane frame info".to_owned(),
        ));
    }

    Ok(PaneFrameInfo {
        cols,
        rows,
        alternate_screen: fields.get(2) == Some(&"1"),
        cursor_x: fields
            .get(3)
            .and_then(|value| parse_nonnegative_integer(value)),
        cursor_y: fields
            .get(4)
            .and_then(|value| parse_nonnegative_integer(value)),
        history_size: fields
            .get(5)
            .and_then(|value| parse_nonnegative_integer(value))
            .unwrap_or(0),
        modes: PaneModeFlags {
            mouse_standard: fields.get(6) == Some(&"1"),
            mouse_button: fields.get(7) == Some(&"1"),
            mouse_all: fields.get(8) == Some(&"1"),
            mouse_sgr: fields.get(9) == Some(&"1"),
            mouse_utf8: fields.get(10) == Some(&"1"),
        },
    })
}

fn parse_nonnegative_integer(value: &str) -> Option<usize> {
    if value.is_empty() {
        return None;
    }
    let value = value.trim_start();
    let (negative, digits) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    let digit_count = digits
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_count == 0 {
        return None;
    }
    let parsed = digits[..digit_count].parse::<u64>().ok()?;
    if parsed > MAX_SAFE_INTEGER || (negative && parsed != 0) {
        return None;
    }
    usize::try_from(parsed).ok()
}

fn is_tmux_pane_id(value: &str) -> bool {
    value.strip_prefix('%').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::tmux::ControlModeSubscription;

    fn block(lines: &[&str], is_error: bool) -> ControlModeBlock {
        ControlModeBlock {
            args: "1 1 0".to_owned(),
            is_error,
            lines: lines.iter().map(|line| (*line).to_owned()).collect(),
        }
    }

    #[tokio::test]
    async fn only_the_fifo_head_spends_its_timeout_budget() {
        let queue = ControlModeCommandQueue::new();
        let mut write = |_command: &str| Ok::<_, String>(());
        let first = queue.execute(
            &mut write,
            "first",
            ControlCommandOptions {
                timeout: Duration::from_millis(200),
                ..ControlCommandOptions::default()
            },
            |response| Ok(response.lines[0].clone()),
        );
        let second = queue.execute(
            &mut write,
            "second",
            ControlCommandOptions {
                timeout: Duration::from_millis(20),
                ..ControlCommandOptions::default()
            },
            |response| Ok(response.lines[0].clone()),
        );

        sleep(Duration::from_millis(50)).await;
        assert!(queue.handle_block(&block(&["first-response"], false)));
        assert!(queue.handle_block(&block(&["second-response"], false)));
        assert_eq!(first.await.unwrap(), "first-response");
        assert_eq!(second.await.unwrap(), "second-response");
        queue.dispose("test complete");
    }

    #[tokio::test]
    async fn command_error_rejects_only_its_fifo_slot() {
        let queue = ControlModeCommandQueue::new();
        let mut write = |_command: &str| Ok::<_, String>(());
        let first = queue.execute(
            &mut write,
            "first",
            ControlCommandOptions::default(),
            |_| Ok(()),
        );
        let second = queue.execute(
            &mut write,
            "second",
            ControlCommandOptions::default(),
            |response| Ok(response.lines[0].clone()),
        );

        assert!(queue.handle_block(&block(&["first failed"], true)));
        assert!(queue.handle_block(&block(&["second-response"], false)));
        assert_eq!(
            first.await.unwrap_err(),
            ControlModeQueueError::CommandFailed("first failed".to_owned())
        );
        assert_eq!(second.await.unwrap(), "second-response");
        assert!(!queue.is_poisoned());
        queue.dispose("test complete");
    }

    #[tokio::test]
    async fn a_late_block_preserves_alignment_but_a_stalled_stream_poison_is_bounded() {
        let poison_count = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&poison_count);
        let queue =
            ControlModeCommandQueue::with_poison_handler(Duration::from_millis(80), move || {
                observed.fetch_add(1, Ordering::SeqCst);
            });
        let mut write = |_command: &str| Ok::<_, String>(());
        let first = queue.execute(
            &mut write,
            "slow",
            ControlCommandOptions {
                timeout: Duration::from_millis(10),
                ..ControlCommandOptions::default()
            },
            |_| Ok(()),
        );
        let second = queue.execute(
            &mut write,
            "next",
            ControlCommandOptions {
                timeout: Duration::from_secs(1),
                ..ControlCommandOptions::default()
            },
            |response| Ok(response.lines[0].clone()),
        );

        sleep(Duration::from_millis(25)).await;
        assert_eq!(
            first.await.unwrap_err(),
            ControlModeQueueError::TimedOut("slow".to_owned())
        );
        assert_eq!(poison_count.load(Ordering::SeqCst), 0);
        assert!(queue.handle_block(&block(&["late"], false)));
        assert!(queue.handle_block(&block(&["next-response"], false)));
        assert_eq!(second.await.unwrap(), "next-response");

        let stalled =
            ControlModeCommandQueue::with_poison_handler(Duration::from_millis(20), move || {
                poison_count.fetch_add(1, Ordering::SeqCst);
            });
        let command = stalled.execute(
            &mut write,
            "stalled",
            ControlCommandOptions {
                timeout: Duration::from_millis(10),
                ..ControlCommandOptions::default()
            },
            |_| Ok(()),
        );
        sleep(Duration::from_millis(60)).await;
        assert_eq!(
            command.await.unwrap_err(),
            ControlModeQueueError::TimedOut("stalled".to_owned())
        );
        assert!(stalled.is_poisoned());
    }

    #[tokio::test]
    async fn atomic_capture_keeps_literal_rows_and_places_the_barrier_before_later_output() {
        let queue = ControlModeCommandQueue::new();
        let writes = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured_writes = Arc::clone(&writes);
        let barrier_count = Arc::new(AtomicUsize::new(0));
        let observed_barrier = Arc::clone(&barrier_count);
        let capture_queue = queue.clone();
        let capture = tokio::spawn(async move {
            capture_pane_frame_at_control_barrier(
                &capture_queue,
                move |command| {
                    captured_writes.lock().unwrap().push(command.to_owned());
                    Ok::<_, String>(())
                },
                "%1",
                50,
                move || {
                    observed_barrier.fetch_add(1, Ordering::SeqCst);
                },
                Duration::from_secs(1),
            )
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(writes.lock().unwrap().len(), 2);

        let mut subscription = ControlModeSubscription::with_command_queue(queue.guard());
        let events = subscription.push(
            b"%begin 1 2 0\n80|24|0|3|4|200|1|0|0|1|0\n%end 1 2 0\n%begin 1 3 0\n%output literal\n\n%window-add literal\n%end 1 3 0\n%output %1 live\n",
            0,
        );
        assert_eq!(barrier_count.load(Ordering::SeqCst), 1);
        tokio::task::yield_now().await;
        assert_eq!(writes.lock().unwrap().len(), 3);
        subscription.push(b"%begin 1 4 0\nold history\n%end 1 4 0\n", 1);

        let capture = capture.await.unwrap().unwrap();
        assert_eq!(capture.text, "%output literal\n\n%window-add literal");
        assert_eq!(capture.history_text.as_deref(), Some("old history"));
        assert_eq!((capture.cols, capture.rows), (80, 24));
        assert!(events.iter().any(|event| matches!(
            event,
            crate::tmux::ControlModeSubscriptionEvent::TerminalOutput { pane_id, data }
                if pane_id == "%1" && data == b"live"
        )));
        assert_eq!(
            writes.lock().unwrap()[2],
            "capture-pane -p -e -J -N -t %1 -S -50 -E -1\n"
        );
        queue.dispose("test complete");
    }
}
