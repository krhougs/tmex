//! Incremental parser for tmux control-mode lines and command-response blocks.

use std::mem;

const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLOCK_BODY_LINES: usize = 4096;

const BYTE_LF: u8 = b'\n';
const BYTE_SPACE: u8 = b' ';
const BYTE_PERCENT: u8 = b'%';
const BYTE_BACKSLASH: u8 = b'\\';

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlModeNotification {
    pub r#type: String,
    pub args: String,
    pub raw: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlModeBlock {
    pub args: String,
    pub is_error: bool,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlModeEvent {
    Output { pane_id: String, data: Vec<u8> },
    Notification(ControlModeNotification),
    Exit(Option<String>),
    Block(ControlModeBlock),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnescapedControlModeData {
    pub data: Vec<u8>,
    pub had_invalid_escape: bool,
}

pub fn unescape_control_mode_data(line: &[u8], start: usize) -> Vec<u8> {
    unescape_control_mode_data_with_status(line, start).data
}

pub fn unescape_control_mode_data_with_status(
    line: &[u8],
    start: usize,
) -> UnescapedControlModeData {
    let had_invalid_start = start > line.len();
    let start = start.min(line.len());
    let mut data = Vec::with_capacity(line.len() - start);
    let mut index = start;
    let mut had_invalid_escape = had_invalid_start;

    while index < line.len() {
        let byte = line[index];
        if byte != BYTE_BACKSLASH {
            data.push(byte);
            index += 1;
            continue;
        }

        let digits = line.get(index + 1..index + 4);
        if let Some([d1, d2, d3]) = digits {
            if d1.is_ascii_digit()
                && *d1 < b'8'
                && d2.is_ascii_digit()
                && *d2 < b'8'
                && d3.is_ascii_digit()
                && *d3 < b'8'
            {
                let value = (u16::from(*d1 - b'0') << 6)
                    | (u16::from(*d2 - b'0') << 3)
                    | u16::from(*d3 - b'0');
                data.push(value as u8);
                index += 4;
                continue;
            }
        }

        had_invalid_escape = true;
        data.push(byte);
        index += 1;
    }

    UnescapedControlModeData {
        data,
        had_invalid_escape,
    }
}

pub struct ControlModeParser {
    pending: Vec<u8>,
    discarding_oversized_line: bool,
    current_block: Option<ControlModeBlock>,
    literal_block: bool,
    literal_block_selector: Box<dyn FnMut(&str) -> bool + Send + 'static>,
}

impl Default for ControlModeParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlModeParser {
    pub fn new() -> Self {
        Self::with_literal_block_selector(|_| false)
    }

    pub fn with_literal_block_selector<F>(selector: F) -> Self
    where
        F: FnMut(&str) -> bool + Send + 'static,
    {
        Self {
            pending: Vec::new(),
            discarding_oversized_line: false,
            current_block: None,
            literal_block: false,
            literal_block_selector: Box::new(selector),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<ControlModeEvent> {
        let mut events = Vec::new();
        let mut start = 0;

        while let Some(relative_newline) = chunk[start..].iter().position(|byte| *byte == BYTE_LF) {
            let newline = start + relative_newline;
            self.push_line_part(&chunk[start..newline], true, &mut events);
            start = newline + 1;
        }
        if start < chunk.len() {
            self.push_line_part(&chunk[start..], false, &mut events);
        }

        events
    }

    pub fn finish(&mut self) -> Vec<ControlModeEvent> {
        if self.discarding_oversized_line || self.pending.is_empty() {
            self.discarding_oversized_line = false;
            self.pending.clear();
            return Vec::new();
        }

        let line = mem::take(&mut self.pending);
        let mut events = Vec::new();
        self.handle_line(&line, &mut events);
        events
    }

    pub fn end(&mut self) -> Vec<ControlModeEvent> {
        self.finish()
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.discarding_oversized_line = false;
        self.current_block = None;
        self.literal_block = false;
    }

    fn push_line_part(&mut self, part: &[u8], complete: bool, events: &mut Vec<ControlModeEvent>) {
        if self.discarding_oversized_line {
            if complete {
                self.discarding_oversized_line = false;
            }
            return;
        }

        if self.pending.len().saturating_add(part.len()) > MAX_LINE_BYTES {
            self.pending.clear();
            self.discarding_oversized_line = !complete;
            return;
        }

        self.pending.extend_from_slice(part);
        if complete {
            let line = mem::take(&mut self.pending);
            self.handle_line(&line, events);
        }
    }

    fn handle_line(&mut self, line: &[u8], events: &mut Vec<ControlModeEvent>) {
        if line.is_empty() {
            if self.literal_block {
                self.push_block_line(String::new());
            }
            return;
        }

        if line[0] != BYTE_PERCENT {
            if self.current_block.is_some() {
                self.push_block_line(decode(line));
            }
            return;
        }

        let type_end = find_byte(line, BYTE_SPACE, 0);
        let (event_type, args_start) = match type_end {
            Some(end) => (decode(&line[1..end]), end + 1),
            None => (decode(&line[1..]), line.len()),
        };

        if self.current_block.is_some()
            && self.literal_block
            && !matches!(event_type.as_str(), "end" | "error")
        {
            self.push_block_line(decode(line));
            return;
        }

        match event_type.as_str() {
            "output" => self.handle_output_line(line, args_start, events),
            "extended-output" => self.handle_extended_output_line(line, args_start, events),
            "begin" => {
                if let Some(block) = self.current_block.take() {
                    events.push(ControlModeEvent::Block(block));
                }
                let args = decode(&line[args_start..]);
                self.literal_block = (self.literal_block_selector)(&args);
                self.current_block = Some(ControlModeBlock {
                    args,
                    is_error: false,
                    lines: Vec::new(),
                });
            }
            "end" | "error" => {
                let Some(mut block) = self.current_block.take() else {
                    return;
                };
                block.is_error = event_type == "error";
                self.literal_block = false;
                events.push(ControlModeEvent::Block(block));
            }
            "exit" => {
                let reason = (args_start < line.len()).then(|| decode(&line[args_start..]));
                events.push(ControlModeEvent::Exit(reason));
            }
            _ => {
                if self.current_block.is_some() && !is_known_notification(&event_type) {
                    self.push_block_line(decode(line));
                    return;
                }
                events.push(ControlModeEvent::Notification(ControlModeNotification {
                    r#type: event_type,
                    args: decode(&line[args_start..]),
                    raw: decode(line),
                }));
            }
        }
    }

    fn handle_output_line(
        &self,
        line: &[u8],
        payload_start: usize,
        events: &mut Vec<ControlModeEvent>,
    ) {
        let Some(pane_end) = find_byte(line, BYTE_SPACE, payload_start) else {
            return;
        };
        events.push(ControlModeEvent::Output {
            pane_id: decode(&line[payload_start..pane_end]),
            data: unescape_control_mode_data(line, pane_end + 1),
        });
    }

    fn handle_extended_output_line(
        &self,
        line: &[u8],
        payload_start: usize,
        events: &mut Vec<ControlModeEvent>,
    ) {
        let Some(pane_end) = find_byte(line, BYTE_SPACE, payload_start) else {
            return;
        };
        let Some(separator) = line[pane_end..]
            .windows(3)
            .position(|window| window == b" : ")
            .map(|offset| pane_end + offset)
        else {
            return;
        };
        events.push(ControlModeEvent::Output {
            pane_id: decode(&line[payload_start..pane_end]),
            data: unescape_control_mode_data(line, separator + 3),
        });
    }

    fn push_block_line(&mut self, line: String) {
        let Some(block) = self.current_block.as_mut() else {
            return;
        };
        if block.lines.len() < MAX_BLOCK_BODY_LINES {
            block.lines.push(line);
        }
    }
}

fn find_byte(line: &[u8], byte: u8, from: usize) -> Option<usize> {
    line.get(from..)?
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|offset| from + offset)
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn is_known_notification(event_type: &str) -> bool {
    matches!(
        event_type,
        "client-detached"
            | "client-session-changed"
            | "config-error"
            | "continue"
            | "layout-change"
            | "message"
            | "pane-mode-changed"
            | "paste-buffer-changed"
            | "paste-buffer-deleted"
            | "pause"
            | "session-changed"
            | "session-renamed"
            | "session-window-changed"
            | "sessions-changed"
            | "subscription-changed"
            | "unlinked-window-add"
            | "unlinked-window-close"
            | "unlinked-window-renamed"
            | "window-add"
            | "window-close"
            | "window-pane-changed"
            | "window-renamed"
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn output(pane_id: &str, data: &[u8]) -> ControlModeEvent {
        ControlModeEvent::Output {
            pane_id: pane_id.into(),
            data: data.into(),
        }
    }

    #[test]
    fn octal_unescape_preserves_utf8_and_reports_invalid_sequences() {
        let input = b"skip:A\\011B\\134\\134C\xe4\xb8\xad\\015\\012";
        let decoded = unescape_control_mode_data_with_status(input, 5);
        assert_eq!(decoded.data, b"A\tB\\\\C\xe4\xb8\xad\r\n");
        assert!(!decoded.had_invalid_escape);

        let invalid = unescape_control_mode_data_with_status(b"A\\12|\\189|\\", 0);
        assert_eq!(invalid.data, b"A\\12|\\189|\\");
        assert!(invalid.had_invalid_escape);

        let invalid_start = unescape_control_mode_data_with_status(b"short", usize::MAX);
        assert!(invalid_start.data.is_empty());
        assert!(invalid_start.had_invalid_escape);
    }

    #[test]
    fn parses_output_notifications_blocks_and_exit() {
        let mut parser = ControlModeParser::new();
        let events = parser.push(
            b"%begin 100 3 0\nbody line\n%window-add @9\n%output %1 hi\\007\n\
              %unknown-inside x\n%end 100 3 0\n%extended-output %5 12 : tail : data\n\
              %exit reason here\n",
        );

        assert_eq!(
            events,
            vec![
                ControlModeEvent::Notification(ControlModeNotification {
                    r#type: "window-add".into(),
                    args: "@9".into(),
                    raw: "%window-add @9".into(),
                }),
                output("%1", b"hi\x07"),
                ControlModeEvent::Block(ControlModeBlock {
                    args: "100 3 0".into(),
                    is_error: false,
                    lines: vec!["body line".into(), "%unknown-inside x".into()],
                }),
                output("%5", b"tail : data"),
                ControlModeEvent::Exit(Some("reason here".into())),
            ]
        );
    }

    #[test]
    fn arbitrary_chunk_boundaries_preserve_lines_and_escapes() {
        let full = b"%output %12 X\\033[1mY\n%window-add @2\n";
        for split in 1..full.len() - 1 {
            let mut parser = ControlModeParser::new();
            let mut events = parser.push(&full[..split]);
            events.extend(parser.push(&full[split..]));
            assert_eq!(
                events,
                vec![
                    output("%12", b"X\x1b[1mY"),
                    ControlModeEvent::Notification(ControlModeNotification {
                        r#type: "window-add".into(),
                        args: "@2".into(),
                        raw: "%window-add @2".into(),
                    }),
                ],
                "split at {split}"
            );
        }

        let mut parser = ControlModeParser::new();
        let mut bytewise = Vec::new();
        for byte in b"%output %1 \\134ok\n%exit reason here\n" {
            bytewise.extend(parser.push(&[*byte]));
        }
        assert_eq!(
            bytewise,
            vec![
                output("%1", b"\\ok"),
                ControlModeEvent::Exit(Some("reason here".into())),
            ]
        );
    }

    #[test]
    fn literal_blocks_keep_notification_looking_and_blank_lines() {
        let literal = Arc::new(Mutex::new(true));
        let decision = Arc::clone(&literal);
        let mut parser = ControlModeParser::with_literal_block_selector(move |_| {
            let mut next = decision.lock().unwrap();
            mem::take(&mut *next)
        });
        let events = parser.push(
            b"%begin 1 2 0\nfirst\n\n%output terminal text\n%window-add terminal text\n\
              %end 1 2 0\n",
        );
        assert_eq!(
            events,
            vec![ControlModeEvent::Block(ControlModeBlock {
                args: "1 2 0".into(),
                is_error: false,
                lines: vec![
                    "first".into(),
                    "".into(),
                    "%output terminal text".into(),
                    "%window-add terminal text".into(),
                ],
            })]
        );
    }

    #[test]
    fn new_begin_closes_previous_block_and_error_closes_on_guard_mismatch() {
        let mut parser = ControlModeParser::new();
        let events =
            parser.push(b"%begin 1 1 0\nfirst\n%begin 2 2 0\nfailed\n%error different guard\n");
        assert_eq!(
            events,
            vec![
                ControlModeEvent::Block(ControlModeBlock {
                    args: "1 1 0".into(),
                    is_error: false,
                    lines: vec!["first".into()],
                }),
                ControlModeEvent::Block(ControlModeBlock {
                    args: "2 2 0".into(),
                    is_error: true,
                    lines: vec!["failed".into()],
                }),
            ]
        );
    }

    #[test]
    fn finish_flushes_final_line_and_reset_discards_partial_state() {
        let mut parser = ControlModeParser::new();
        assert!(parser.push(b"%exit").is_empty());
        assert_eq!(parser.end(), vec![ControlModeEvent::Exit(None)]);

        parser.push(b"%begin 1 1 0\npartial");
        parser.reset();
        assert_eq!(
            parser.push(b"%window-add @7\n"),
            vec![ControlModeEvent::Notification(ControlModeNotification {
                r#type: "window-add".into(),
                args: "@7".into(),
                raw: "%window-add @7".into(),
            })]
        );
    }

    #[test]
    fn oversized_lines_and_block_bodies_are_bounded_and_parser_recovers() {
        let mut parser = ControlModeParser::new();
        assert!(parser.push(b"%output %1 ").is_empty());
        assert!(parser.push(&vec![b'a'; MAX_LINE_BYTES + 1]).is_empty());
        assert_eq!(
            parser.push(b"tail\n%window-add @7\n"),
            vec![ControlModeEvent::Notification(ControlModeNotification {
                r#type: "window-add".into(),
                args: "@7".into(),
                raw: "%window-add @7".into(),
            })]
        );

        let mut body = Vec::from(&b"%begin 1 2 0\n"[..]);
        for _ in 0..MAX_BLOCK_BODY_LINES + 2 {
            body.extend_from_slice(b"line\n");
        }
        body.extend_from_slice(b"%end 1 2 0\n");
        let events = parser.push(&body);
        let ControlModeEvent::Block(block) = &events[0] else {
            panic!("expected block");
        };
        assert_eq!(block.lines.len(), MAX_BLOCK_BODY_LINES);
    }
}
