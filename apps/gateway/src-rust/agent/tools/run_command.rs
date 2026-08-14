use std::time::Duration;

use async_trait::async_trait;
use regress::Regex;
use tokio::time::Instant;

use crate::agent::AgentPortError;

pub const RUN_COMMAND_DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
pub const RUN_COMMAND_OUTPUT_MAX_BYTES: usize = 256 * 1024;
pub const RUN_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RunCommandMode {
    #[default]
    Auto,
    Posix,
    Cli,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunCommandShell {
    Bash,
    Zsh,
    Sh,
    Fish,
    PowerShell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunCommandStatus {
    Completed,
    Timeout,
    EnteredTui,
    ExpectMatched,
    PausedPager,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunCommandResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub status: RunCommandStatus,
    pub likely_error: bool,
    pub error_line: Option<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunCommandParams {
    pub command: String,
    pub mode: RunCommandMode,
    pub shell: Option<RunCommandShell>,
    pub prompt: Option<String>,
    pub expect: Option<String>,
    pub timeout: Duration,
    pub disable_paging_command: Option<String>,
}

impl RunCommandParams {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            mode: RunCommandMode::Auto,
            shell: None,
            prompt: None,
            expect: None,
            timeout: RUN_COMMAND_DEFAULT_TIMEOUT,
            disable_paging_command: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandPromptMarker {
    pub kind: char,
    pub exit_code: Option<i32>,
    pub params: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandStreamUpdate {
    pub bytes: Vec<u8>,
    pub markers: Vec<CommandPromptMarker>,
    pub alternate_screen: bool,
}

#[async_trait]
pub trait TerminalCommandStream: Send {
    fn initial_screen(&self) -> &str;
    fn initial_alternate_screen(&self) -> bool;
    async fn send_input(&mut self, data: &str) -> Result<(), AgentPortError>;
    async fn poll(&mut self, wait: Duration) -> Result<CommandStreamUpdate, AgentPortError>;
    async fn close(&mut self);
}

async fn discard_stream_updates_for(
    stream: &mut dyn TerminalCommandStream,
    duration: Duration,
) -> Result<(), AgentPortError> {
    let deadline = Instant::now() + duration;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(());
        }
        let _ = stream.poll(deadline.saturating_duration_since(now)).await?;
    }
}

fn exit_code_expression(shell: Option<RunCommandShell>) -> Option<&'static str> {
    match shell {
        Some(RunCommandShell::Fish) => Some("$status"),
        Some(RunCommandShell::PowerShell) => None,
        _ => Some("$?"),
    }
}

pub fn clean_terminal_text(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut clean = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            if bytes[index] == 0x08 {
                clean.pop();
            } else {
                clean.push(bytes[index]);
            }
            index += 1;
            continue;
        }

        index += 1;
        let Some(next) = bytes.get(index).copied() else {
            break;
        };
        match next {
            b']' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            b'[' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b'(' | b')' => index = (index + 2).min(bytes.len()),
            _ => index += 1,
        }
    }

    String::from_utf8_lossy(&clean)
        .split('\n')
        .map(|line| {
            line.rsplit('\r')
                .find(|segment| !segment.is_empty())
                .unwrap_or_default()
                .trim_end()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn last_non_empty_line(text: &str) -> &str {
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
}

fn prompt_pattern(prompt_line: &str) -> Option<Regex> {
    let trimmed = prompt_line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let escaped = trimmed
        .chars()
        .flat_map(|character| {
            if ".*+?^${}()|[]\\".contains(character) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect::<String>();
    Regex::new(&format!(r"{escaped}\s*$")).ok()
}

fn extract_output(raw: &[u8], overflowed: bool) -> (String, bool) {
    let cleaned = clean_terminal_text(&String::from_utf8_lossy(raw));
    let body = cleaned
        .split_once('\n')
        .map_or("", |(_, body)| body)
        .trim_end_matches('\n')
        .to_owned();
    (
        body,
        overflowed || raw.len() >= RUN_COMMAND_OUTPUT_MAX_BYTES,
    )
}

fn error_heuristic(text: &str) -> (bool, Option<String>) {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        let cli_error = lower.match_indices('%').any(|(index, _)| {
            let suffix = lower[index + 1..].trim_start();
            ["invalid input", "ambiguous command", "incomplete command"]
                .iter()
                .any(|prefix| suffix.starts_with(prefix))
        });
        if cli_error
            || lower.contains("syntax error")
            || lower.contains("unknown command")
            || line.trim() == "^"
        {
            return (true, Some(line.trim().to_owned()));
        }
    }
    (false, None)
}

fn finish_result(
    raw: &[u8],
    overflowed: bool,
    status: RunCommandStatus,
    exit_code: Option<i32>,
) -> RunCommandResult {
    let (output, truncated) = extract_output(raw, overflowed);
    let (likely_error, error_line) = error_heuristic(&output);
    RunCommandResult {
        output,
        exit_code,
        status,
        likely_error,
        error_line,
        truncated,
    }
}

pub async fn execute_run_command(
    params: &RunCommandParams,
    stream: &mut dyn TerminalCommandStream,
    nonce: &str,
) -> Result<RunCommandResult, AgentPortError> {
    if stream.initial_alternate_screen() {
        return Ok(finish_result(
            &[],
            false,
            RunCommandStatus::EnteredTui,
            None,
        ));
    }

    let use_posix = params.mode == RunCommandMode::Posix
        || (params.mode == RunCommandMode::Auto && exit_code_expression(params.shell).is_some());
    if params.mode == RunCommandMode::Cli {
        if let Some(command) = params.disable_paging_command.as_deref() {
            stream.send_input(&format!("{command}\r")).await?;
            discard_stream_updates_for(stream, Duration::from_millis(200)).await?;
        }
    }

    let prompt = match params.prompt.as_deref() {
        Some(pattern) => Some(
            Regex::new(pattern)
                .map_err(|error| AgentPortError::new(format!("invalid prompt regex: {error}")))?,
        ),
        None if params.mode == RunCommandMode::Cli => {
            prompt_pattern(last_non_empty_line(stream.initial_screen()))
        }
        None => None,
    };
    let expect = params
        .expect
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(|error| AgentPortError::new(format!("invalid expect regex: {error}")))?;

    if use_posix {
        let expression = exit_code_expression(params.shell).unwrap_or("$?");
        let marker = format!("printf '\\033]133;D;%s;tmex={nonce}\\033\\\\' \"{expression}\"");
        stream
            .send_input(&format!("{}; {marker}\r", params.command))
            .await?;
    } else {
        stream.send_input(&format!("{}\r", params.command)).await?;
    }

    let mut raw = Vec::new();
    let mut overflowed = false;
    let deadline = Instant::now() + params.timeout;
    let mut quiet_since = None;
    let mut previous_len = 0;

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let wait = RUN_COMMAND_POLL_INTERVAL.min(deadline.saturating_duration_since(now));
        let update = stream.poll(wait).await?;
        let now = Instant::now();
        if update.alternate_screen {
            return Ok(finish_result(
                &raw,
                overflowed,
                RunCommandStatus::EnteredTui,
                None,
            ));
        }
        let remaining = RUN_COMMAND_OUTPUT_MAX_BYTES.saturating_sub(raw.len());
        if update.bytes.len() > remaining {
            overflowed = true;
        }
        raw.extend_from_slice(&update.bytes[..update.bytes.len().min(remaining)]);
        let cleaned = clean_terminal_text(&String::from_utf8_lossy(&raw));

        if expect
            .as_ref()
            .is_some_and(|pattern| pattern.find(&cleaned).is_some())
        {
            return Ok(finish_result(
                &raw,
                overflowed,
                RunCommandStatus::ExpectMatched,
                None,
            ));
        }
        if use_posix {
            if let Some(marker) = update.markers.iter().find(|marker| {
                marker.kind == 'D'
                    && marker
                        .params
                        .iter()
                        .any(|parameter| parameter == &format!("tmex={nonce}"))
            }) {
                return Ok(finish_result(
                    &raw,
                    overflowed,
                    RunCommandStatus::Completed,
                    marker.exit_code,
                ));
            }
        }

        let mut tail_start = cleaned.len().saturating_sub(200);
        while !cleaned.is_char_boundary(tail_start) {
            tail_start += 1;
        }
        let tail = &cleaned[tail_start..];
        if ["--More--", "<--- More --->", "More: <space>"]
            .iter()
            .any(|marker| tail.contains(marker))
            || tail.to_ascii_lowercase().contains("---(more")
        {
            stream.send_input(" ").await?;
            quiet_since = None;
            previous_len = raw.len();
            continue;
        }

        if let Some(prompt) = &prompt {
            let last_line = last_non_empty_line(&cleaned);
            let (output, _) = extract_output(&raw, overflowed);
            if !output.is_empty() && prompt.find(last_line).is_some() {
                return Ok(finish_result(
                    &raw,
                    overflowed,
                    RunCommandStatus::Completed,
                    None,
                ));
            }
        }

        if raw.len() == previous_len {
            let quiet_for = now.saturating_duration_since(*quiet_since.get_or_insert(now));
            let (output, _) = extract_output(&raw, overflowed);
            if quiet_for >= Duration::from_millis(600)
                && (!output.is_empty() || quiet_for >= Duration::from_millis(1500))
            {
                return Ok(finish_result(
                    &raw,
                    overflowed,
                    RunCommandStatus::Completed,
                    None,
                ));
            }
        } else {
            quiet_since = None;
            previous_len = raw.len();
        }
    }

    Ok(finish_result(
        &raw,
        overflowed,
        RunCommandStatus::Timeout,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ImmediateStream {
        sent_at: Vec<Instant>,
        settle_polls: usize,
        command_polls: usize,
    }

    #[async_trait]
    impl TerminalCommandStream for ImmediateStream {
        fn initial_screen(&self) -> &str {
            "$ "
        }

        fn initial_alternate_screen(&self) -> bool {
            false
        }

        async fn send_input(&mut self, _data: &str) -> Result<(), AgentPortError> {
            self.sent_at.push(Instant::now());
            Ok(())
        }

        async fn poll(&mut self, wait: Duration) -> Result<CommandStreamUpdate, AgentPortError> {
            if self.sent_at.len() == 1 {
                self.settle_polls += 1;
                if self.settle_polls > 3 {
                    tokio::time::sleep(wait).await;
                }
                return Ok(CommandStreamUpdate::default());
            }

            self.command_polls += 1;
            Ok(if self.command_polls == 40 {
                CommandStreamUpdate {
                    bytes: b"show\r\nok\r\n$ ".to_vec(),
                    ..CommandStreamUpdate::default()
                }
            } else {
                CommandStreamUpdate::default()
            })
        }

        async fn close(&mut self) {}
    }

    #[tokio::test]
    async fn immediately_ready_polls_do_not_consume_real_deadlines() {
        let mut stream = ImmediateStream {
            sent_at: Vec::new(),
            settle_polls: 0,
            command_polls: 0,
        };
        let mut params = RunCommandParams::new("show");
        params.mode = RunCommandMode::Cli;
        params.prompt = Some(r"\$\s*$".to_owned());
        params.disable_paging_command = Some("terminal length 0".to_owned());
        let result = execute_run_command(&params, &mut stream, "test-nonce")
            .await
            .expect("run command");

        assert_eq!(result.status, RunCommandStatus::Completed);
        assert!(result.output.contains("ok"));
        assert_eq!(stream.command_polls, 40);
        assert!(stream.sent_at[1].duration_since(stream.sent_at[0]) >= Duration::from_millis(200));
    }
}
