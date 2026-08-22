//! Listener-free terminal emulation used by the Gateway pane runtime.
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

mod control_mode;
mod keyboard_modes;
mod pane_stream;

pub use control_mode::{
    unescape_control_mode_data, unescape_control_mode_data_with_status, ControlModeBlock,
    ControlModeEvent, ControlModeNotification, ControlModeParser, UnescapedControlModeData,
};
pub use keyboard_modes::{
    apply_sequence, detect_keyboard_sequence, encode_pane_option_value, parse_pane_option_value,
    KbdSequence, KeyboardModeState, KittySetMode, KITTY_STACK_DEPTH,
};
pub use pane_stream::{
    PaneStreamEvent, PaneStreamFragment, PaneStreamNotification, PaneStreamNotificationSource,
    PaneStreamOutput, PaneStreamParser,
};

use std::collections::BTreeMap;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color, NamedColor};

pub const DEFAULT_COLS: usize = 80;
pub const DEFAULT_ROWS: usize = 24;
pub const DEFAULT_SCROLLBACK_LINES: usize = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: usize,
    pub rows: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSgrState {
    bytes: Vec<u8>,
}

impl TerminalSgrState {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalContinuationState {
    sgr: TerminalSgrState,
    pub insert: bool,
    pub wrap: bool,
    pub cursor_visible: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub origin: bool,
}

impl TerminalContinuationState {
    pub fn sgr(&self) -> &TerminalSgrState {
        &self.sgr
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadlessTerminalOptions {
    pub cols: usize,
    pub rows: usize,
    pub scrollback_lines: usize,
}

impl Default for HeadlessTerminalOptions {
    fn default() -> Self {
        Self {
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            scrollback_lines: DEFAULT_SCROLLBACK_LINES,
        }
    }
}

impl HeadlessTerminalOptions {
    fn normalized(self) -> Self {
        Self {
            cols: self.cols.max(1),
            rows: self.rows.max(1),
            ..self
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptMarkerKind {
    A,
    B,
    C,
    D,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptMarker {
    pub kind: PromptMarkerKind,
    pub exit_code: Option<i32>,
    pub params: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalTap<'a> {
    Bytes(&'a [u8]),
    PromptMarker(&'a PromptMarker),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TerminalTapId(u64);

type TapListener = Box<dyn for<'a> FnMut(TerminalTap<'a>) + Send + 'static>;

#[derive(Clone, Copy)]
struct TerminalDimensions {
    cols: usize,
    rows: usize,
}

impl Dimensions for TerminalDimensions {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct HeadlessTerminal {
    term: Term<VoidListener>,
    processor: ansi::Processor,
    alt_screen_normalizer: AltScreenNormalizer,
    options: HeadlessTerminalOptions,
    taps: BTreeMap<TerminalTapId, TapListener>,
    next_tap_id: u64,
}

impl HeadlessTerminal {
    pub fn new(options: HeadlessTerminalOptions) -> Self {
        let options = options.normalized();
        let (term, processor) = build_terminal(options);
        Self {
            term,
            processor,
            alt_screen_normalizer: AltScreenNormalizer::default(),
            options,
            taps: BTreeMap::new(),
            next_tap_id: 0,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let normalized = self.alt_screen_normalizer.normalize(bytes);
        self.processor.advance(&mut self.term, &normalized);
        self.publish(TerminalTap::Bytes(bytes));
    }

    pub fn viewport_text(&self) -> String {
        let mut lines = Vec::with_capacity(self.term.screen_lines());
        let mut line = String::with_capacity(self.term.columns());
        let mut current_line = None;

        for indexed in self.term.renderable_content().display_iter {
            if current_line != Some(indexed.point.line) {
                if current_line.is_some() {
                    lines.push(trim_line(line));
                    line = String::with_capacity(self.term.columns());
                }
                current_line = Some(indexed.point.line);
            }

            let cell = indexed.cell;
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            line.push(if cell.c == '\t' { ' ' } else { cell.c });
            if let Some(zerowidth) = cell.zerowidth() {
                line.extend(zerowidth);
            }
        }

        if current_line.is_some() {
            lines.push(trim_line(line));
        }
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        lines.join("\n")
    }

    pub fn is_alternate_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    pub fn size(&self) -> TerminalSize {
        TerminalSize {
            cols: self.term.columns(),
            rows: self.term.screen_lines(),
        }
    }

    pub fn sgr_state(&self) -> TerminalSgrState {
        let template = &self.term.grid().cursor.template;
        let mut parameters = vec!["0".to_owned()];
        for (flag, code) in [
            (Flags::BOLD, "1"),
            (Flags::DIM, "2"),
            (Flags::ITALIC, "3"),
            (Flags::UNDERLINE, "4"),
            (Flags::DOUBLE_UNDERLINE, "21"),
            (Flags::UNDERCURL, "4:3"),
            (Flags::DOTTED_UNDERLINE, "4:4"),
            (Flags::DASHED_UNDERLINE, "4:5"),
            (Flags::INVERSE, "7"),
            (Flags::HIDDEN, "8"),
            (Flags::STRIKEOUT, "9"),
        ] {
            if template.flags.contains(flag) {
                parameters.push(code.to_owned());
            }
        }
        push_color(&mut parameters, template.fg, ColorTarget::Foreground);
        push_color(&mut parameters, template.bg, ColorTarget::Background);
        if let Some(color) = template.underline_color() {
            push_color(&mut parameters, color, ColorTarget::Underline);
        }
        TerminalSgrState {
            bytes: format!("\x1b[{}m", parameters.join(";")).into_bytes(),
        }
    }

    pub fn continuation_state(&self) -> TerminalContinuationState {
        let mode = self.term.mode();
        TerminalContinuationState {
            sgr: self.sgr_state(),
            insert: mode.contains(TermMode::INSERT),
            wrap: mode.contains(TermMode::LINE_WRAP),
            cursor_visible: mode.contains(TermMode::SHOW_CURSOR),
            application_cursor: mode.contains(TermMode::APP_CURSOR),
            application_keypad: mode.contains(TermMode::APP_KEYPAD),
            origin: mode.contains(TermMode::ORIGIN),
        }
    }

    pub fn scrollback_limit(&self) -> usize {
        self.options.scrollback_lines
    }

    pub fn history_lines(&self) -> usize {
        self.term.history_size()
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        // Alacritty grows rows before reflowing columns in a combined resize. Ghostty reflows
        // first, so stage the width change to keep the same visible rows when both axes change.
        if cols != self.term.columns() && rows != self.term.screen_lines() {
            self.term.resize(TerminalDimensions {
                cols,
                rows: self.term.screen_lines(),
            });
        }
        self.term.resize(TerminalDimensions { cols, rows });
        self.options.cols = cols;
        self.options.rows = rows;
    }

    pub fn reset(&mut self) {
        self.rebuild(self.options);
    }

    pub fn rebuild(&mut self, options: HeadlessTerminalOptions) {
        let options = options.normalized();
        let (term, processor) = build_terminal(options);
        self.term = term;
        self.processor = processor;
        self.alt_screen_normalizer = AltScreenNormalizer::default();
        self.options = options;
    }

    #[must_use]
    pub fn tap<F>(&mut self, listener: F) -> TerminalTapId
    where
        F: for<'a> FnMut(TerminalTap<'a>) + Send + 'static,
    {
        let id = TerminalTapId(self.next_tap_id);
        self.next_tap_id = self.next_tap_id.wrapping_add(1);
        self.taps.insert(id, Box::new(listener));
        id
    }

    pub fn untap(&mut self, id: TerminalTapId) -> bool {
        self.taps.remove(&id).is_some()
    }

    pub fn clear_taps(&mut self) {
        self.taps.clear();
    }

    pub fn publish_prompt_marker(&mut self, marker: &PromptMarker) {
        self.publish(TerminalTap::PromptMarker(marker));
    }

    fn publish(&mut self, event: TerminalTap<'_>) {
        for listener in self.taps.values_mut() {
            listener(event);
        }
    }
}

#[derive(Clone, Copy)]
enum ColorTarget {
    Foreground,
    Background,
    Underline,
}

fn push_color(parameters: &mut Vec<String>, color: Color, target: ColorTarget) {
    match color {
        Color::Spec(color) => parameters.push(format!(
            "{};2;{};{};{}",
            match target {
                ColorTarget::Foreground => 38,
                ColorTarget::Background => 48,
                ColorTarget::Underline => 58,
            },
            color.r,
            color.g,
            color.b
        )),
        Color::Indexed(index) => parameters.push(format!(
            "{};5;{index}",
            match target {
                ColorTarget::Foreground => 38,
                ColorTarget::Background => 48,
                ColorTarget::Underline => 58,
            }
        )),
        Color::Named(color) => push_named_color(parameters, color, target),
    }
}

fn push_named_color(parameters: &mut Vec<String>, color: NamedColor, target: ColorTarget) {
    let index = color as usize;
    let code = match target {
        ColorTarget::Foreground if index < 8 => Some(30 + index),
        ColorTarget::Foreground if index < 16 => Some(90 + index - 8),
        ColorTarget::Background if index < 8 => Some(40 + index),
        ColorTarget::Background if index < 16 => Some(100 + index - 8),
        ColorTarget::Underline if index < 16 => {
            parameters.push(format!("58;5;{index}"));
            return;
        }
        _ => None,
    };
    if let Some(code) = code {
        parameters.push(code.to_string());
    }
}

impl Default for HeadlessTerminal {
    fn default() -> Self {
        Self::new(HeadlessTerminalOptions::default())
    }
}

fn build_terminal(options: HeadlessTerminalOptions) -> (Term<VoidListener>, ansi::Processor) {
    let dimensions = TerminalDimensions {
        cols: options.cols,
        rows: options.rows,
    };
    let config = Config {
        scrolling_history: options.scrollback_lines,
        ..Default::default()
    };
    (
        Term::new(config, &dimensions, VoidListener),
        ansi::Processor::new(),
    )
}

fn trim_line(mut line: String) -> String {
    line.truncate(line.trim_end_matches(' ').len());
    line
}

// vte 0.15 recognizes alternate-screen mode 1049 but not the legacy 47/1047 aliases accepted by
// Ghostty. Normalize only those private CSI parameters; tap listeners still receive source bytes.
#[derive(Default)]
enum AltScreenNormalizer {
    #[default]
    Ground,
    Escape,
    Csi(Vec<u8>),
}

impl AltScreenNormalizer {
    fn normalize(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            self.advance(byte, &mut output);
        }
        output
    }

    fn advance(&mut self, byte: u8, output: &mut Vec<u8>) {
        match self {
            Self::Ground if byte == 0x1b => *self = Self::Escape,
            Self::Ground => output.push(byte),
            Self::Escape if byte == b'[' => *self = Self::Csi(Vec::new()),
            Self::Escape => {
                output.push(0x1b);
                *self = Self::Ground;
                self.advance(byte, output);
            }
            Self::Csi(sequence) if (0x40..=0x7e).contains(&byte) => {
                sequence.push(byte);
                write_normalized_csi(sequence, output);
                *self = Self::Ground;
            }
            Self::Csi(sequence) if (0x20..=0x3f).contains(&byte) && sequence.len() < 128 => {
                sequence.push(byte);
            }
            Self::Csi(sequence) => {
                output.extend_from_slice(b"\x1b[");
                output.append(sequence);
                *self = Self::Ground;
                self.advance(byte, output);
            }
        }
    }
}

fn write_normalized_csi(sequence: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(b"\x1b[");
    let Some((&final_byte, parameters)) = sequence.split_last() else {
        return;
    };
    if !matches!(final_byte, b'h' | b'l') || !parameters.starts_with(b"?") {
        output.extend_from_slice(sequence);
        return;
    }

    let private_parameters = &parameters[1..];
    if !private_parameters
        .iter()
        .all(|byte| byte.is_ascii_digit() || *byte == b';')
    {
        output.extend_from_slice(sequence);
        return;
    }

    output.push(b'?');
    for (index, parameter) in private_parameters.split(|byte| *byte == b';').enumerate() {
        if index != 0 {
            output.push(b';');
        }
        match parameter {
            b"47" | b"1047" => output.extend_from_slice(b"1049"),
            _ => output.extend_from_slice(parameter),
        }
    }
    output.push(final_byte);
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn terminal(cols: usize, rows: usize, scrollback_lines: usize) -> HeadlessTerminal {
        HeadlessTerminal::new(HeadlessTerminalOptions {
            cols,
            rows,
            scrollback_lines,
        })
    }

    #[test]
    fn viewport_is_trimmed_plain_text_with_physical_wraps() {
        let mut term = terminal(5, 5, 2);
        term.feed(b"\x1b[31mabcde\x1b[0mf\r\nA\tB\r\n\x1b[8mCD\x1b[0m  ");

        assert_eq!(term.viewport_text(), "abcde\nf\nA   B\nCD");

        term.reset();
        term.feed(b"AAAAA\rBB");
        assert_eq!(term.viewport_text(), "BBAAA");

        term.reset();
        term.feed("\x1b[3;1H\u{4e2d}e\u{301}".as_bytes());
        assert_eq!(term.viewport_text(), "\n\n\u{4e2d}e\u{301}");
    }

    #[test]
    fn resize_reflows_without_unwrapping_viewport_rows() {
        let mut term = terminal(5, 3, 2);
        term.feed(b"abcdefghij");
        assert_eq!(term.viewport_text(), "abcde\nfghij");

        term.resize(4, 4);
        assert_eq!(term.size(), TerminalSize { cols: 4, rows: 4 });
        assert_eq!(term.viewport_text(), "abcd\nefgh\nij");

        let mut alternate = terminal(5, 3, 2);
        alternate.feed(b"\x1b[?1049habcdefghij");
        alternate.resize(4, 4);
        assert_eq!(alternate.viewport_text(), "abcd\nfghi");
    }

    #[test]
    fn alternate_screen_modes_switch_buffers() {
        for mode in [47, 1047, 1049] {
            let mut term = terminal(6, 3, 2);
            term.feed(b"main");
            let enter = format!("\x1b[?{mode}hALT");
            term.feed(&enter.as_bytes()[..5]);
            term.feed(&enter.as_bytes()[5..]);
            assert!(term.is_alternate_screen());
            assert_eq!(term.viewport_text(), "    AL\nT");

            term.feed(format!("\x1b[?{mode}l").as_bytes());
            assert!(!term.is_alternate_screen());
            assert_eq!(term.viewport_text(), "main");
        }
    }

    #[test]
    fn scrollback_is_bounded() {
        let mut term = terminal(5, 3, 2);
        term.feed(b"1\r\n2\r\n3\r\n4\r\n5\r\n6");

        assert_eq!(term.viewport_text(), "4\n5\n6");
        assert_eq!(term.history_lines(), 2);
        assert_eq!(term.scrollback_limit(), 2);
    }

    #[test]
    fn reset_and_rebuild_drop_grid_history_and_partial_parser_state() {
        let mut term = terminal(5, 3, 2);
        term.feed(b"old\r\ncontent\x1b[?1049hALT\x1b[");
        assert!(term.is_alternate_screen());

        term.reset();
        term.feed(b"fresh");
        assert_eq!(term.viewport_text(), "fresh");
        assert!(!term.is_alternate_screen());
        assert_eq!(term.history_lines(), 0);

        term.rebuild(HeadlessTerminalOptions {
            cols: 0,
            rows: 0,
            scrollback_lines: 1,
        });
        assert_eq!(term.size(), TerminalSize { cols: 1, rows: 1 });
        assert_eq!(term.viewport_text(), "");
        assert_eq!(term.scrollback_limit(), 1);
        term.feed(b"x");
        assert_eq!(term.viewport_text(), "x");
    }

    #[test]
    fn sgr_state_round_trips_current_character_attributes() {
        let mut source = terminal(10, 3, 0);
        source.feed(b"\x1b[1;3;4;7;38;2;1;2;3;48;5;16;58;5;12m");
        let state = source.sgr_state();

        let mut restored = terminal(10, 3, 0);
        restored.feed(state.as_bytes());

        assert_eq!(restored.sgr_state(), state);
        assert!(state.as_bytes().starts_with(b"\x1b[0;"));
    }

    #[test]
    fn default_sgr_state_clears_a_previous_background() {
        let source = terminal(10, 3, 0);
        let mut restored = terminal(10, 3, 0);
        restored.feed(b"\x1b[48;5;16m");
        restored.feed(source.sgr_state().as_bytes());

        assert_eq!(restored.sgr_state(), source.sgr_state());
    }

    #[test]
    fn continuation_state_tracks_modes_and_character_attributes_together() {
        let mut term = terminal(10, 3, 0);
        term.feed(b"\x1b[4h\x1b[?7l\x1b[?25l\x1b[?1h\x1b=\x1b[?6h\x1b[48;5;16m");

        let state = term.continuation_state();
        assert!(state.insert);
        assert!(!state.wrap);
        assert!(!state.cursor_visible);
        assert!(state.application_cursor);
        assert!(state.application_keypad);
        assert!(state.origin);
        assert!(state.sgr().as_bytes().starts_with(b"\x1b[0;"));
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum OwnedTap {
        Bytes(Vec<u8>),
        PromptMarker(PromptMarker),
    }

    #[test]
    fn tap_keeps_bytes_and_prompt_markers_as_separate_events() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let mut term = terminal(10, 3, 2);
        let tap_id = term.tap(move |event| {
            let event = match event {
                TerminalTap::Bytes(bytes) => OwnedTap::Bytes(bytes.to_vec()),
                TerminalTap::PromptMarker(marker) => OwnedTap::PromptMarker(marker.clone()),
            };
            captured.lock().unwrap().push(event);
        });
        let marker = PromptMarker {
            kind: PromptMarkerKind::D,
            exit_code: Some(137),
            params: vec!["137".into(), "tmex=abc123".into()],
        };

        term.feed(b"out");
        term.publish_prompt_marker(&marker);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                OwnedTap::Bytes(b"out".to_vec()),
                OwnedTap::PromptMarker(marker.clone()),
            ]
        );

        assert!(term.untap(tap_id));
        term.feed(b"after");
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    fn control_and_pane_parsers_keep_side_channels_out_of_terminal_bytes() {
        let mut control = ControlModeParser::new();
        let control_events = control.push(b"%output %1 hello\\033]133;D;0\\007world\n");
        let ControlModeEvent::Output { pane_id, data } = &control_events[0] else {
            panic!("expected pane output");
        };
        assert_eq!(pane_id, "%1");

        let mut pane = PaneStreamParser::new();
        let parsed = pane.push(data);
        assert_eq!(parsed.terminal_bytes, b"helloworld");
        assert_eq!(
            parsed.events,
            vec![PaneStreamEvent::PromptMarker(PromptMarker {
                kind: PromptMarkerKind::D,
                exit_code: Some(0),
                params: vec!["0".into()],
            })]
        );

        let mut terminal = terminal(20, 3, 2);
        terminal.feed(&parsed.terminal_bytes);
        for event in &parsed.events {
            if let PaneStreamEvent::PromptMarker(marker) = event {
                terminal.publish_prompt_marker(marker);
            }
        }
        assert_eq!(terminal.viewport_text(), "helloworld");
    }
}
