//! Incremental pane byte-stream filter for terminal bytes and structured side channels.

use std::borrow::Cow;
use std::mem;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;

use crate::keyboard_modes::{detect_keyboard_sequence, KbdSequence};
use crate::{PromptMarker, PromptMarkerKind};

const MAX_OSC_KIND_BYTES: usize = 16;
const MAX_OSC_PAYLOAD_BYTES: usize = 8 * 1024;
const MAX_TITLE_BYTES: usize = 8 * 1024;
const MAX_DCS_PASSTHROUGH_BYTES: usize = 64 * 1024;
const MAX_KITTY_PENDING_IDS: usize = 16;
const MAX_CSI_BYTES: usize = 64;
const TMUX_PASSTHROUGH_PREFIX: &[u8] = b"tmux;";
const CLIPBOARD_DEDUP_WINDOW: Duration = Duration::from_millis(500);
const THEME_UPDATES_MODE: &[u8] = b"2031";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneStreamNotificationSource {
    Osc9,
    Osc99,
    Osc777,
    Osc1337,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneStreamNotification {
    pub source: PaneStreamNotificationSource,
    pub title: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneStreamEvent {
    Title(String),
    CurrentPath(String),
    Bell,
    Notification(PaneStreamNotification),
    PromptMarker(PromptMarker),
    ClipboardWrite(String),
    ThemeSubscription(bool),
    KeyboardSequence(KbdSequence),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaneStreamOutput {
    pub terminal_bytes: Vec<u8>,
    pub events: Vec<PaneStreamEvent>,
    event_terminal_offsets: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneStreamFragment<'a> {
    Terminal(&'a [u8]),
    Event(&'a PaneStreamEvent),
}

impl PaneStreamOutput {
    pub fn append(&mut self, mut other: Self) {
        self.repair_event_offsets();
        other.repair_event_offsets();
        let terminal_offset = self.terminal_bytes.len();
        self.event_terminal_offsets.extend(
            other
                .event_terminal_offsets
                .into_iter()
                .map(|offset| terminal_offset.saturating_add(offset)),
        );
        self.terminal_bytes.append(&mut other.terminal_bytes);
        self.events.append(&mut other.events);
    }

    pub fn is_empty(&self) -> bool {
        self.terminal_bytes.is_empty() && self.events.is_empty()
    }

    pub fn ordered_fragments(&self) -> Vec<PaneStreamFragment<'_>> {
        if self.event_terminal_offsets.len() != self.events.len() {
            let mut fragments = Vec::with_capacity(
                usize::from(!self.terminal_bytes.is_empty()) + self.events.len(),
            );
            if !self.terminal_bytes.is_empty() {
                fragments.push(PaneStreamFragment::Terminal(&self.terminal_bytes));
            }
            fragments.extend(self.events.iter().map(PaneStreamFragment::Event));
            return fragments;
        }

        let mut fragments = Vec::with_capacity(self.events.len().saturating_mul(2) + 1);
        let mut terminal_start = 0;
        for (event, offset) in self.events.iter().zip(&self.event_terminal_offsets) {
            let offset = (*offset).clamp(terminal_start, self.terminal_bytes.len());
            if terminal_start < offset {
                fragments.push(PaneStreamFragment::Terminal(
                    &self.terminal_bytes[terminal_start..offset],
                ));
            }
            fragments.push(PaneStreamFragment::Event(event));
            terminal_start = offset;
        }
        if terminal_start < self.terminal_bytes.len() {
            fragments.push(PaneStreamFragment::Terminal(
                &self.terminal_bytes[terminal_start..],
            ));
        }
        fragments
    }

    fn push_event(&mut self, event: PaneStreamEvent) {
        self.event_terminal_offsets.push(self.terminal_bytes.len());
        self.events.push(event);
    }

    fn repair_event_offsets(&mut self) {
        if self.event_terminal_offsets.len() != self.events.len() {
            self.event_terminal_offsets = vec![self.terminal_bytes.len(); self.events.len()];
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Normal,
    Esc,
    Csi,
    OscParams,
    OscBody,
    OscBodyIgnore,
    OscSt,
    OscStIgnore,
    ScreenTitle,
    ScreenTitleSt,
    ScreenTitleIgnore,
    ScreenTitleStIgnore,
    DcsDetect,
    DcsTmux,
    DcsTmuxEsc,
    DcsTmuxIgnore,
    DcsTmuxIgnoreEsc,
}

#[derive(Clone, Debug)]
struct KittyPending {
    id: String,
    title: String,
    body: String,
}

#[derive(Default)]
pub struct PaneStreamParser {
    phase: Phase,
    osc_kind: Vec<u8>,
    osc_payload: Vec<u8>,
    title: Vec<u8>,
    dcs_prefix: Vec<u8>,
    dcs_bytes: Vec<u8>,
    csi_bytes: Vec<u8>,
    in_tmux_passthrough: bool,
    kitty_pending: Vec<KittyPending>,
    last_clipboard: Option<(String, Instant)>,
}

impl PaneStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &[u8]) -> PaneStreamOutput {
        let mut output = PaneStreamOutput::default();
        for &byte in data {
            self.process_byte(byte, &mut output);
        }
        output
    }

    pub fn flush(&mut self) -> PaneStreamOutput {
        let mut output = PaneStreamOutput::default();
        match self.phase {
            Phase::Esc => output.terminal_bytes.push(0x1b),
            Phase::Csi => {
                output.terminal_bytes.extend_from_slice(b"\x1b[");
                output.terminal_bytes.append(&mut self.csi_bytes);
            }
            Phase::DcsDetect => {
                output.terminal_bytes.extend_from_slice(b"\x1bP");
                output.terminal_bytes.append(&mut self.dcs_prefix);
            }
            _ => {}
        }
        self.reset();
        output
    }

    pub fn reset(&mut self) {
        self.phase = Phase::Normal;
        self.osc_kind.clear();
        self.osc_payload.clear();
        self.title.clear();
        self.dcs_prefix.clear();
        self.dcs_bytes.clear();
        self.csi_bytes.clear();
        self.in_tmux_passthrough = false;
        self.kitty_pending.clear();
        self.last_clipboard = None;
    }

    fn process_byte(&mut self, byte: u8, output: &mut PaneStreamOutput) {
        let phase = self.phase;
        match phase {
            Phase::Normal => match byte {
                0x1b => self.phase = Phase::Esc,
                0x07 => output.push_event(PaneStreamEvent::Bell),
                _ => output.terminal_bytes.push(byte),
            },
            Phase::Esc => match byte {
                b']' => {
                    self.reset_osc();
                    self.phase = Phase::OscParams;
                }
                b'k' => {
                    self.title.clear();
                    self.phase = Phase::ScreenTitle;
                }
                b'P' => {
                    self.dcs_prefix.clear();
                    self.phase = Phase::DcsDetect;
                }
                b'[' => {
                    self.csi_bytes.clear();
                    self.phase = Phase::Csi;
                }
                _ => {
                    output.terminal_bytes.extend_from_slice(&[0x1b, byte]);
                    self.phase = Phase::Normal;
                }
            },
            Phase::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    let theme_subscription = matches!(byte, b'h' | b'l')
                        && !self.in_tmux_passthrough
                        && self.csi_has_theme_mode();
                    let keyboard_sequence = detect_keyboard_sequence(&self.csi_bytes, byte);
                    output.terminal_bytes.extend_from_slice(b"\x1b[");
                    output.terminal_bytes.append(&mut self.csi_bytes);
                    output.terminal_bytes.push(byte);
                    if theme_subscription {
                        output.push_event(PaneStreamEvent::ThemeSubscription(byte == b'h'));
                    }
                    if let Some(seq) = keyboard_sequence {
                        output.push_event(PaneStreamEvent::KeyboardSequence(seq));
                    }
                    self.phase = Phase::Normal;
                } else if (0x20..=0x3f).contains(&byte) && self.csi_bytes.len() < MAX_CSI_BYTES {
                    self.csi_bytes.push(byte);
                } else {
                    output.terminal_bytes.extend_from_slice(b"\x1b[");
                    output.terminal_bytes.append(&mut self.csi_bytes);
                    self.phase = Phase::Normal;
                    self.process_byte(byte, output);
                }
            }
            Phase::DcsDetect => {
                let expected = TMUX_PASSTHROUGH_PREFIX.get(self.dcs_prefix.len()).copied();
                if expected == Some(byte) {
                    self.dcs_prefix.push(byte);
                    if self.dcs_prefix.len() == TMUX_PASSTHROUGH_PREFIX.len() {
                        self.dcs_bytes.clear();
                        self.phase = Phase::DcsTmux;
                    }
                } else {
                    output.terminal_bytes.extend_from_slice(b"\x1bP");
                    output.terminal_bytes.append(&mut self.dcs_prefix);
                    self.phase = Phase::Normal;
                    self.process_byte(byte, output);
                }
            }
            Phase::DcsTmux => {
                if byte == 0x1b {
                    self.phase = Phase::DcsTmuxEsc;
                } else {
                    self.append_dcs_byte(byte);
                }
            }
            Phase::DcsTmuxEsc => match byte {
                b'\\' => self.flush_tmux_passthrough(output),
                0x1b => {
                    self.phase = Phase::DcsTmux;
                    self.append_dcs_byte(0x1b);
                }
                _ => {
                    self.phase = Phase::DcsTmux;
                    if self.append_dcs_byte(0x1b) {
                        self.append_dcs_byte(byte);
                    }
                }
            },
            Phase::DcsTmuxIgnore => {
                if byte == 0x1b {
                    self.phase = Phase::DcsTmuxIgnoreEsc;
                }
            }
            Phase::DcsTmuxIgnoreEsc => {
                if byte == b'\\' {
                    self.dcs_bytes.clear();
                    self.dcs_prefix.clear();
                    self.phase = Phase::Normal;
                } else if byte != 0x1b {
                    self.phase = Phase::DcsTmuxIgnore;
                }
            }
            Phase::OscParams => match byte {
                b';' => {
                    self.phase = if is_supported_osc_kind(&self.osc_kind) {
                        Phase::OscBody
                    } else {
                        Phase::OscBodyIgnore
                    };
                }
                0x07 => {
                    self.emit_osc(output);
                    self.reset_osc();
                    self.phase = Phase::Normal;
                }
                0x1b => self.phase = Phase::OscSt,
                _ if self.osc_kind.len() >= MAX_OSC_KIND_BYTES => {
                    self.reset_osc();
                    self.phase = Phase::OscBodyIgnore;
                }
                _ => self.osc_kind.push(byte),
            },
            Phase::OscBody => match byte {
                0x07 => {
                    self.emit_osc(output);
                    self.reset_osc();
                    self.phase = Phase::Normal;
                }
                0x1b => self.phase = Phase::OscSt,
                _ => {
                    self.append_osc_payload(byte);
                }
            },
            Phase::OscBodyIgnore => match byte {
                0x07 => {
                    self.reset_osc();
                    self.phase = Phase::Normal;
                }
                0x1b => self.phase = Phase::OscStIgnore,
                _ => {}
            },
            Phase::OscSt => {
                if byte == b'\\' {
                    self.emit_osc(output);
                    self.reset_osc();
                    self.phase = Phase::Normal;
                } else {
                    self.phase = Phase::OscBody;
                    if self.append_osc_payload(0x1b) {
                        self.append_osc_payload(byte);
                    }
                }
            }
            Phase::OscStIgnore => {
                if byte == b'\\' {
                    self.reset_osc();
                    self.phase = Phase::Normal;
                } else {
                    self.phase = Phase::OscBodyIgnore;
                }
            }
            Phase::ScreenTitle => match byte {
                0x07 => {
                    self.emit_title(output);
                    self.title.clear();
                    self.phase = Phase::Normal;
                }
                0x1b => self.phase = Phase::ScreenTitleSt,
                _ if self.title.len() >= MAX_TITLE_BYTES => {
                    self.title.clear();
                    self.phase = Phase::ScreenTitleIgnore;
                }
                _ => self.title.push(byte),
            },
            Phase::ScreenTitleIgnore => match byte {
                0x07 => self.phase = Phase::Normal,
                0x1b => self.phase = Phase::ScreenTitleStIgnore,
                _ => {}
            },
            Phase::ScreenTitleStIgnore => {
                self.phase = if byte == b'\\' {
                    Phase::Normal
                } else {
                    Phase::ScreenTitleIgnore
                };
            }
            Phase::ScreenTitleSt => {
                if byte == b'\\' {
                    self.emit_title(output);
                    self.title.clear();
                    self.phase = Phase::Normal;
                } else if self.title.len() + 2 > MAX_TITLE_BYTES {
                    self.title.clear();
                    self.phase = Phase::ScreenTitleIgnore;
                } else {
                    self.title.extend_from_slice(&[0x1b, byte]);
                    self.phase = Phase::ScreenTitle;
                }
            }
        }
    }

    fn csi_has_theme_mode(&self) -> bool {
        self.csi_bytes.first() == Some(&b'?')
            && self.csi_bytes[1..]
                .split(|byte| *byte == b';')
                .any(|parameter| parameter == THEME_UPDATES_MODE)
    }

    fn append_osc_payload(&mut self, byte: u8) -> bool {
        if self.osc_payload.len() >= MAX_OSC_PAYLOAD_BYTES {
            self.osc_payload.clear();
            self.phase = Phase::OscBodyIgnore;
            return false;
        }
        self.osc_payload.push(byte);
        true
    }

    fn append_dcs_byte(&mut self, byte: u8) -> bool {
        if self.dcs_bytes.len() >= MAX_DCS_PASSTHROUGH_BYTES {
            self.dcs_bytes.clear();
            self.phase = Phase::DcsTmuxIgnore;
            return false;
        }
        self.dcs_bytes.push(byte);
        true
    }

    fn reset_osc(&mut self) {
        self.osc_kind.clear();
        self.osc_payload.clear();
    }

    fn flush_tmux_passthrough(&mut self, output: &mut PaneStreamOutput) {
        let content = mem::take(&mut self.dcs_bytes);
        self.dcs_prefix.clear();
        self.phase = Phase::Normal;
        let previous_passthrough = self.in_tmux_passthrough;
        self.in_tmux_passthrough = true;
        for byte in content {
            self.process_byte(byte, output);
        }
        self.in_tmux_passthrough = previous_passthrough;

        if self.phase == Phase::Csi {
            output.terminal_bytes.extend_from_slice(b"\x1b[");
            output.terminal_bytes.append(&mut self.csi_bytes);
            self.phase = Phase::Normal;
        }
    }

    fn emit_title(&self, output: &mut PaneStreamOutput) {
        let title = decode(&self.title);
        let title = title.trim();
        if !title.is_empty() {
            output.push_event(PaneStreamEvent::Title(title.to_owned()));
        }
    }

    fn emit_osc(&mut self, output: &mut PaneStreamOutput) {
        let kind = self.osc_kind.clone();
        let payload = decode(&self.osc_payload);
        match kind.as_slice() {
            b"0" | b"1" | b"2" => self.emit_title_from_osc(output),
            b"7" => {
                if let Some(path) = file_url_path(&payload) {
                    output.push_event(PaneStreamEvent::CurrentPath(path));
                }
            }
            b"9" => {
                if payload != "4" && !payload.starts_with("4;") {
                    output.push_event(PaneStreamEvent::Notification(PaneStreamNotification {
                        source: PaneStreamNotificationSource::Osc9,
                        title: None,
                        body: payload,
                    }));
                }
            }
            b"99" => self.emit_osc_99(&payload, output),
            b"777" => self.emit_osc_777(&payload, output),
            b"1337" => {
                if matches_ignore_ascii_case(
                    &payload,
                    &[
                        "RequestAttention=yes",
                        "RequestAttention=once",
                        "RequestAttention=fireworks",
                        "RequestAttention=true",
                    ],
                ) {
                    output.push_event(PaneStreamEvent::Notification(PaneStreamNotification {
                        source: PaneStreamNotificationSource::Osc1337,
                        title: None,
                        body: "RequestAttention".into(),
                    }));
                }
            }
            b"52" => self.emit_osc_52(&payload, output),
            b"133" => self.emit_osc_133(&payload, output),
            _ => {}
        }
    }

    fn emit_title_from_osc(&self, output: &mut PaneStreamOutput) {
        let title = decode(&self.osc_payload);
        let title = title.trim();
        if !title.is_empty() {
            output.push_event(PaneStreamEvent::Title(title.to_owned()));
        }
    }

    fn emit_osc_99(&mut self, payload: &str, output: &mut PaneStreamOutput) {
        let (metadata, content) = payload.split_once(';').unwrap_or((payload, ""));
        let mut id = "0";
        let mut done = true;
        let mut part = "body";
        for field in metadata.split(':') {
            let Some((key, value)) = field.split_once('=') else {
                continue;
            };
            if key.is_empty() {
                continue;
            }
            match key {
                "i" => id = value,
                "d" => done = value != "0",
                "p" => part = value,
                _ => {}
            }
        }

        let existing = self
            .kitty_pending
            .iter()
            .position(|pending| pending.id == id);
        let mut pending = existing
            .map(|index| self.kitty_pending.remove(index))
            .unwrap_or_else(|| KittyPending {
                id: id.into(),
                title: String::new(),
                body: String::new(),
            });
        match part {
            "title" => pending.title.push_str(content),
            "body" => pending.body.push_str(content),
            _ => {}
        }

        if !done {
            if existing.is_none() && self.kitty_pending.len() >= MAX_KITTY_PENDING_IDS {
                self.kitty_pending.remove(0);
            }
            if let Some(index) = existing {
                self.kitty_pending.insert(index, pending);
            } else {
                self.kitty_pending.push(pending);
            }
            return;
        }

        if !pending.title.is_empty() || !pending.body.is_empty() {
            output.push_event(PaneStreamEvent::Notification(PaneStreamNotification {
                source: PaneStreamNotificationSource::Osc99,
                title: (!pending.title.is_empty()).then_some(pending.title),
                body: pending.body,
            }));
        }
    }

    fn emit_osc_777(&self, payload: &str, output: &mut PaneStreamOutput) {
        let (verb, rest) = payload.split_once(';').unwrap_or((payload, ""));
        if verb != "notify" {
            return;
        }
        let (title, body) = rest.split_once(';').unwrap_or((rest, ""));
        output.push_event(PaneStreamEvent::Notification(PaneStreamNotification {
            source: PaneStreamNotificationSource::Osc777,
            title: (!title.is_empty()).then(|| title.to_owned()),
            body: body.into(),
        }));
    }

    fn emit_osc_52(&mut self, payload: &str, output: &mut PaneStreamOutput) {
        let Some((_, encoded)) = payload.split_once(';') else {
            return;
        };
        if encoded.is_empty() || encoded == "?" {
            return;
        }
        let Some(bytes) = decode_base64(encoded) else {
            return;
        };
        let text = decode(&bytes);
        if text.is_empty() {
            return;
        }

        let now = Instant::now();
        if let Some((previous, previous_at)) = self.last_clipboard.as_mut() {
            if *previous == text && now.duration_since(*previous_at) < CLIPBOARD_DEDUP_WINDOW {
                *previous_at = now;
                return;
            }
        }
        self.last_clipboard = Some((text.clone(), now));
        output.push_event(PaneStreamEvent::ClipboardWrite(text));
    }

    fn emit_osc_133(&self, payload: &str, output: &mut PaneStreamOutput) {
        let mut parts = payload.split(';');
        let kind = match parts.next() {
            Some("A") => PromptMarkerKind::A,
            Some("B") => PromptMarkerKind::B,
            Some("C") => PromptMarkerKind::C,
            Some("D") => PromptMarkerKind::D,
            _ => return,
        };
        let params: Vec<String> = parts.map(str::to_owned).collect();
        let exit_code = if kind == PromptMarkerKind::D {
            params.first().and_then(|value| parse_decimal_prefix(value))
        } else {
            None
        };
        output.push_event(PaneStreamEvent::PromptMarker(PromptMarker {
            kind,
            exit_code,
            params,
        }));
    }
}

fn is_supported_osc_kind(kind: &[u8]) -> bool {
    matches!(
        kind,
        b"0" | b"1" | b"2" | b"7" | b"9" | b"52" | b"99" | b"133" | b"777" | b"1337"
    )
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_base64(encoded: &str) -> Option<Vec<u8>> {
    let compact: Vec<u8> = encoded
        .bytes()
        .filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
        .collect();
    STANDARD
        .decode(&compact)
        .or_else(|_| STANDARD_NO_PAD.decode(&compact))
        .ok()
}

fn parse_decimal_prefix(value: &str) -> Option<i32> {
    let value = value.trim_start();
    let bytes = value.as_bytes();
    let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    if end == 0 || (end == 1 && matches!(bytes.first(), Some(b'+' | b'-'))) {
        return None;
    }
    value[..end].parse().ok()
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn file_url_path(value: &str) -> Option<String> {
    let prefix = value.get(..5)?;
    if !prefix.eq_ignore_ascii_case("file:") {
        return None;
    }
    let rest = &value[5..];
    let path = if let Some(authority) = rest.strip_prefix("//") {
        Cow::Borrowed(
            authority
                .find('/')
                .map(|index| &authority[index..])
                .unwrap_or("/"),
        )
    } else if rest.starts_with('/') {
        Cow::Borrowed(rest)
    } else if rest.is_empty() {
        Cow::Borrowed("/")
    } else {
        Cow::Owned(format!("/{rest}"))
    };
    let path_end = path.find(['?', '#']).unwrap_or(path.len());
    percent_decode(&path[..path_end])
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = hex_value(*bytes.get(index + 1)?)?;
        let low = hex_value(*bytes.get(index + 2)?)?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ST: &[u8] = b"\x1b\\";

    fn notification(
        source: PaneStreamNotificationSource,
        title: Option<&str>,
        body: &str,
    ) -> PaneStreamEvent {
        PaneStreamEvent::Notification(PaneStreamNotification {
            source,
            title: title.map(str::to_owned),
            body: body.into(),
        })
    }

    fn osc(kind: &str, payload: &str, terminator: &[u8]) -> Vec<u8> {
        let mut bytes = format!("\x1b]{kind};{payload}").into_bytes();
        bytes.extend_from_slice(terminator);
        bytes
    }

    fn tmux_wrap(content: &[u8]) -> Vec<u8> {
        let mut wrapped = Vec::from(&b"\x1bPtmux;"[..]);
        for &byte in content {
            if byte == 0x1b {
                wrapped.push(0x1b);
            }
            wrapped.push(byte);
        }
        wrapped.extend_from_slice(ST);
        wrapped
    }

    #[test]
    fn strips_side_channels_and_emits_structured_events_for_bel_and_st() {
        let mut input = Vec::from(&b"A\x07"[..]);
        input.extend(osc("2", " dev ", b"\x07"));
        input.extend_from_slice(b"\x1bk screen title \x07");
        input.extend(osc("7", "file://host/work/my%20repo", ST));
        input.extend(osc("9", "hello", b"\x07"));
        input.extend(osc("9", "4;1;42", b"\x07"));
        input.extend(osc("777", "notify;Build;All 42;passed", ST));
        input.extend(osc("1337", "RequestAttention=YES", b"\x07"));
        input.extend(osc("133", "D;137;tmex=abc123", ST));
        input.extend(osc("999", "secret", b"\x07"));
        input.extend_from_slice(b"Z");

        let output = PaneStreamParser::new().push(&input);
        assert_eq!(output.terminal_bytes, b"AZ");
        assert_eq!(
            output.events,
            vec![
                PaneStreamEvent::Bell,
                PaneStreamEvent::Title("dev".into()),
                PaneStreamEvent::Title("screen title".into()),
                PaneStreamEvent::CurrentPath("/work/my repo".into()),
                notification(PaneStreamNotificationSource::Osc9, None, "hello"),
                notification(
                    PaneStreamNotificationSource::Osc777,
                    Some("Build"),
                    "All 42;passed",
                ),
                notification(
                    PaneStreamNotificationSource::Osc1337,
                    None,
                    "RequestAttention",
                ),
                PaneStreamEvent::PromptMarker(PromptMarker {
                    kind: PromptMarkerKind::D,
                    exit_code: Some(137),
                    params: vec!["137".into(), "tmex=abc123".into()],
                }),
            ]
        );
    }

    #[test]
    fn keyboard_sequences_emitted_and_bytes_passed_through() {
        let input = b"A\x1b[>7u\x1b[>4;2m\x1b[?1hB\x1b[<1u";
        let output = PaneStreamParser::new().push(input);
        // 序列字节仍透传给终端，同时发出结构化事件
        assert_eq!(
            output.terminal_bytes,
            &b"A\x1b[>7u\x1b[>4;2m\x1b[?1hB\x1b[<1u"[..]
        );
        assert_eq!(
            output.events,
            vec![
                PaneStreamEvent::KeyboardSequence(KbdSequence::PushKittyFlags(7)),
                PaneStreamEvent::KeyboardSequence(KbdSequence::ModifyOtherKeys(2)),
                PaneStreamEvent::KeyboardSequence(KbdSequence::CursorKeys(true)),
                PaneStreamEvent::KeyboardSequence(KbdSequence::PopKittyFlags(1)),
            ]
        );

        // 任意切点跨 chunk：事件不丢不重
        for split in 1..input.len() {
            let mut parser = PaneStreamParser::new();
            let mut output = parser.push(&input[..split]);
            output.append(parser.push(&input[split..]));
            assert_eq!(output.events.len(), 4, "split at {split}");
            assert_eq!(output.terminal_bytes, &input[..], "split at {split}");
        }
    }

    #[test]
    fn arbitrary_chunks_preserve_osc_state_and_escaped_body_bytes() {
        let mut full = Vec::from(&b"X"[..]);
        full.extend(osc("9", "ab\x1bxcd", ST));
        full.extend_from_slice(b"Y");
        for split in 1..full.len() {
            let mut parser = PaneStreamParser::new();
            let mut output = parser.push(&full[..split]);
            output.append(parser.push(&full[split..]));
            assert_eq!(output.terminal_bytes, b"XY", "split at {split}");
            assert_eq!(
                output.events,
                vec![notification(
                    PaneStreamNotificationSource::Osc9,
                    None,
                    "ab\x1bxcd",
                )],
                "split at {split}"
            );
        }

        let wrapped = tmux_wrap(&osc("777", "notify;Claude;done", ST));
        for split in 1..wrapped.len() {
            let mut parser = PaneStreamParser::new();
            let mut output = parser.push(&wrapped[..split]);
            output.append(parser.push(&wrapped[split..]));
            assert!(output.terminal_bytes.is_empty(), "split at {split}");
            assert_eq!(
                output.events,
                vec![notification(
                    PaneStreamNotificationSource::Osc777,
                    Some("Claude"),
                    "done",
                )],
                "split at {split}"
            );
        }
    }

    #[test]
    fn prompt_markers_cover_all_kinds_and_tmux_passthrough() {
        let mut parser = PaneStreamParser::new();
        let mut input = Vec::new();
        for kind in ["A", "B", "C"] {
            input.extend(osc("133", kind, ST));
        }
        input.extend(tmux_wrap(&osc("133", "D;0", ST)));
        assert_eq!(
            parser.push(&input).events,
            vec![
                PaneStreamEvent::PromptMarker(PromptMarker {
                    kind: PromptMarkerKind::A,
                    exit_code: None,
                    params: vec![],
                }),
                PaneStreamEvent::PromptMarker(PromptMarker {
                    kind: PromptMarkerKind::B,
                    exit_code: None,
                    params: vec![],
                }),
                PaneStreamEvent::PromptMarker(PromptMarker {
                    kind: PromptMarkerKind::C,
                    exit_code: None,
                    params: vec![],
                }),
                PaneStreamEvent::PromptMarker(PromptMarker {
                    kind: PromptMarkerKind::D,
                    exit_code: Some(0),
                    params: vec!["0".into()],
                }),
            ]
        );
    }

    #[test]
    fn kitty_osc_99_aggregates_fragments_and_bounds_pending_ids() {
        let mut parser = PaneStreamParser::new();
        let mut output = PaneStreamOutput::default();
        output.append(parser.push(&osc("99", "i=42:d=0:p=title;Claude Code", ST)));
        output.append(parser.push(&osc("99", "i=42:p=body;Task finished", ST)));
        output.append(parser.push(&osc("99", "i=42:d=1:a=focus;", ST)));
        assert_eq!(
            output.events,
            vec![notification(
                PaneStreamNotificationSource::Osc99,
                Some("Claude Code"),
                "Task finished",
            )]
        );

        for id in 0..=MAX_KITTY_PENDING_IDS {
            parser.push(&osc("99", &format!("i={id}:d=0;p=body;x"), ST));
        }
        let evicted = parser.push(&osc("99", "i=0:d=1;", ST));
        assert!(evicted.events.is_empty());
    }

    #[test]
    fn osc_52_decodes_clipboard_and_deduplicates_passthrough_copy() {
        let mut parser = PaneStreamParser::new();
        let bare = osc("52", "c;aGVsbG8=", b"\x07");
        let first = parser.push(&bare);
        assert_eq!(
            first.events,
            vec![PaneStreamEvent::ClipboardWrite("hello".into())]
        );

        let duplicate = parser.push(&tmux_wrap(&bare));
        assert!(duplicate.is_empty());
        assert!(parser.push(&osc("52", "c;?", ST)).is_empty());
        assert!(parser.push(&osc("52", "c;%%%invalid", ST)).is_empty());
        assert_eq!(
            parser.push(&osc("52", "c;d29ybGQ", ST)).events,
            vec![PaneStreamEvent::ClipboardWrite("world".into())]
        );
    }

    #[test]
    fn nested_tmux_passthrough_unwraps_side_channels_but_preserves_regular_dcs() {
        let inner = osc("9", "nested", b"\x07");
        let nested = tmux_wrap(&tmux_wrap(&inner));
        let mut parser = PaneStreamParser::new();
        assert_eq!(
            parser.push(&nested).events,
            vec![notification(
                PaneStreamNotificationSource::Osc9,
                None,
                "nested",
            )]
        );

        let regular = b"A\x1bP+q544e\x1b\\B";
        assert_eq!(parser.push(regular).terminal_bytes, regular);
    }

    #[test]
    fn csi_is_passthrough_with_theme_events_only_outside_tmux_wrapper() {
        let mut parser = PaneStreamParser::new();
        let input = b"X\x1b[?1004;2031hY\x1b[?2031lZ";
        let output = parser.push(input);
        assert_eq!(output.terminal_bytes, input);
        assert_eq!(
            output.events,
            vec![
                PaneStreamEvent::ThemeSubscription(true),
                PaneStreamEvent::ThemeSubscription(false),
            ]
        );

        let wrapped = tmux_wrap(b"\x1b[?2031h");
        let output = parser.push(&wrapped);
        assert_eq!(output.terminal_bytes, b"\x1b[?2031h");
        assert!(output.events.is_empty());

        let mut oversized = Vec::from(&b"\x1b["[..]);
        oversized.extend(std::iter::repeat_n(b'9', 80));
        oversized.push(b'm');
        assert_eq!(parser.push(&oversized).terminal_bytes, oversized);

        let interrupted = b"\x1b[?20\x1b[?2031h";
        let output = parser.push(interrupted);
        assert_eq!(output.terminal_bytes, interrupted);
        assert_eq!(
            output.events,
            vec![PaneStreamEvent::ThemeSubscription(true)]
        );
    }

    #[test]
    fn bounded_osc_title_and_dcs_states_drop_payloads_and_resume() {
        let mut parser = PaneStreamParser::new();
        let mut oversized_osc = Vec::from(&b"\x1b]9;"[..]);
        oversized_osc.extend(std::iter::repeat_n(b'x', MAX_OSC_PAYLOAD_BYTES + 1));
        oversized_osc.extend_from_slice(b"\x07ok");
        let output = parser.push(&oversized_osc);
        assert_eq!(output.terminal_bytes, b"ok");
        assert!(output.events.is_empty());

        let mut oversized_kind = Vec::from(&b"\x1b]"[..]);
        oversized_kind.extend(std::iter::repeat_n(b'9', MAX_OSC_KIND_BYTES + 1));
        oversized_kind.extend_from_slice(b";ignored\x07kind-ok");
        let output = parser.push(&oversized_kind);
        assert_eq!(output.terminal_bytes, b"kind-ok");
        assert!(output.events.is_empty());

        let mut oversized_title = Vec::from(&b"\x1bk"[..]);
        oversized_title.extend(std::iter::repeat_n(b'x', MAX_TITLE_BYTES + 1));
        oversized_title.extend_from_slice(b"\x07title-ok");
        let output = parser.push(&oversized_title);
        assert_eq!(output.terminal_bytes, b"title-ok");
        assert!(output.events.is_empty());

        let mut oversized_dcs = Vec::from(&b"\x1bPtmux;"[..]);
        oversized_dcs.extend(std::iter::repeat_n(b'x', MAX_DCS_PASSTHROUGH_BYTES + 1));
        oversized_dcs.extend_from_slice(b"\x1b\\dcs-ok");
        let output = parser.push(&oversized_dcs);
        assert_eq!(output.terminal_bytes, b"dcs-ok");
        assert!(output.events.is_empty());
    }

    #[test]
    fn flush_and_reset_handle_truncated_sequences_without_leaking_side_channels() {
        let mut parser = PaneStreamParser::new();
        let first = parser.push(b"A\x1b[?20");
        assert_eq!(first.terminal_bytes, b"A");
        assert_eq!(parser.flush().terminal_bytes, b"\x1b[?20");

        assert!(parser.push(b"\x1b]9;partial").is_empty());
        assert!(parser.flush().is_empty());
        assert_eq!(parser.push(b"plain").terminal_bytes, b"plain");

        assert!(parser.push(b"\x1b]9;discard").is_empty());
        parser.reset();
        assert_eq!(parser.push(b"after-reset").terminal_bytes, b"after-reset");

        assert!(parser.push(b"\x1bPtmux;partial").is_empty());
        assert!(parser.flush().is_empty());
        assert!(parser.push(b"\x1bPt").is_empty());
        assert_eq!(parser.flush().terminal_bytes, b"\x1bPt");
    }
}
