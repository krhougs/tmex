use std::fmt;

use super::PaneModeFlags;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const PANE_SCREEN_INFO_FORMAT: &str = concat!(
    "#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{history_size}",
    "|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}",
    "|#{mouse_sgr_flag}|#{mouse_utf8_flag}",
    "|#{scroll_region_upper}|#{scroll_region_lower}|#{origin_flag}|#{insert_flag}",
    "|#{wrap_flag}|#{cursor_flag}|#{keypad_cursor_flag}|#{keypad_flag}"
);
pub const PANE_META_FORMAT: &str =
    "#{pane_width} #{pane_height} #{alternate_on} #{cursor_x} #{cursor_y} #{pane_current_command}";
pub const PANE_HISTORY_CAPTURE_INFO_FORMAT: &str = "#{history_size}|#{pane_width}";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneScreenInfo {
    pub cols: usize,
    pub rows: usize,
    pub alternate_screen: bool,
    pub cursor_x: Option<usize>,
    pub cursor_y: Option<usize>,
    pub history_size: usize,
    pub modes: PaneModeFlags,
    pub continuation: PaneContinuationModes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneContinuationModes {
    pub scroll_region_upper: usize,
    pub scroll_region_lower: usize,
    pub origin: bool,
    pub insert: bool,
    pub wrap: bool,
    pub cursor_visible: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneInfo {
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: Option<usize>,
    pub cursor_y: Option<usize>,
    pub alternate_screen: bool,
    pub current_command: Option<String>,
    pub title: Option<String>,
    pub current_path: Option<String>,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub window_id: Option<String>,
    pub window_name: Option<String>,
    pub split_pane_count: Option<usize>,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub locale: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaneHistoryCaptureInfo {
    pub history_size: usize,
    pub cols: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsePaneHistoryCaptureInfoError;

impl fmt::Display for ParsePaneHistoryCaptureInfoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid tmux pane history info")
    }
}

impl std::error::Error for ParsePaneHistoryCaptureInfoError {}

pub fn parse_pane_screen_info(stdout: &str) -> PaneScreenInfo {
    let parts = stdout
        .trim_end_matches(['\r', '\n'])
        .split('|')
        .collect::<Vec<_>>();
    let cols = parts
        .first()
        .and_then(|value| parse_nonnegative_prefix(value))
        .unwrap_or(0);
    let rows = parts
        .get(1)
        .and_then(|value| parse_nonnegative_prefix(value))
        .unwrap_or(0);
    let default_lower = rows.saturating_sub(1);
    let upper = parts
        .get(11)
        .and_then(|value| parse_nonnegative_prefix(value))
        .unwrap_or(0);
    let lower = parts
        .get(12)
        .and_then(|value| parse_nonnegative_prefix(value))
        .unwrap_or(default_lower);
    let (scroll_region_upper, scroll_region_lower) = if rows > 0 && upper <= lower && lower < rows {
        (upper, lower)
    } else {
        (0, default_lower)
    };
    PaneScreenInfo {
        cols,
        rows,
        alternate_screen: parts.get(2) == Some(&"1"),
        cursor_x: parts
            .get(3)
            .and_then(|value| parse_nonnegative_prefix(value)),
        cursor_y: parts
            .get(4)
            .and_then(|value| parse_nonnegative_prefix(value)),
        history_size: parts
            .get(5)
            .and_then(|value| parse_nonnegative_prefix(value))
            .unwrap_or(0),
        modes: PaneModeFlags {
            mouse_standard: parts.get(6) == Some(&"1"),
            mouse_button: parts.get(7) == Some(&"1"),
            mouse_all: parts.get(8) == Some(&"1"),
            mouse_sgr: parts.get(9) == Some(&"1"),
            mouse_utf8: parts.get(10) == Some(&"1"),
        },
        continuation: PaneContinuationModes {
            scroll_region_upper,
            scroll_region_lower,
            origin: parts.get(13) == Some(&"1"),
            insert: parts.get(14) == Some(&"1"),
            wrap: parts.get(15).is_none_or(|value| *value == "1"),
            cursor_visible: parts.get(16).is_none_or(|value| *value == "1"),
            application_cursor: parts.get(17) == Some(&"1"),
            application_keypad: parts.get(18) == Some(&"1"),
        },
    }
}

pub fn parse_pane_history_capture_info(
    stdout: &str,
) -> Result<PaneHistoryCaptureInfo, ParsePaneHistoryCaptureInfoError> {
    let mut parts = stdout.trim().split('|');
    let history_size = parts
        .next()
        .and_then(parse_nonnegative_prefix)
        .ok_or(ParsePaneHistoryCaptureInfoError)?;
    let cols = parts
        .next()
        .and_then(parse_nonnegative_prefix)
        .filter(|cols| *cols > 0)
        .ok_or(ParsePaneHistoryCaptureInfoError)?;
    Ok(PaneHistoryCaptureInfo { history_size, cols })
}

pub fn parse_pane_meta(stdout: &str) -> PaneInfo {
    let parts = stdout.split_whitespace().collect::<Vec<_>>();
    let command = parts.get(5).filter(|value| !value.is_empty());
    PaneInfo {
        cols: parts
            .first()
            .and_then(|value| parse_nonnegative_prefix(value))
            .unwrap_or(0),
        rows: parts
            .get(1)
            .and_then(|value| parse_nonnegative_prefix(value))
            .unwrap_or(0),
        alternate_screen: parts.get(2) == Some(&"1"),
        cursor_x: parts
            .get(3)
            .and_then(|value| parse_nonnegative_prefix(value)),
        cursor_y: parts
            .get(4)
            .and_then(|value| parse_nonnegative_prefix(value)),
        current_command: command.map(|value| (*value).to_owned()),
        title: None,
        current_path: None,
        session_id: None,
        session_name: None,
        window_id: None,
        window_name: None,
        split_pane_count: None,
        term: None,
        term_program: None,
        locale: None,
        encoding: None,
    }
}

pub fn append_cursor_restore(history: &str, info: &PaneScreenInfo) -> String {
    let (Some(cursor_x), Some(cursor_y)) = (info.cursor_x, info.cursor_y) else {
        return history.to_owned();
    };
    let pane_height = info.rows;
    if pane_height == 0 {
        return history.to_owned();
    }

    let trimmed = history.strip_suffix('\n').unwrap_or(history);
    if info.alternate_screen {
        return format!("{trimmed}\x1b[{};{}H", cursor_y + 1, cursor_x + 1);
    }

    let up = pane_height
        .saturating_sub(1)
        .saturating_sub(cursor_y)
        .min(pane_height - 1);
    if up == 0 {
        format!("{trimmed}\x1b[{}G", cursor_x + 1)
    } else {
        format!("{trimmed}\x1b[{up}A\x1b[{}G", cursor_x + 1)
    }
}

fn parse_nonnegative_prefix(value: &str) -> Option<usize> {
    let value = value.trim_start();
    let (negative, digits) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let parsed = digits[..end].parse::<u64>().ok()?;
    if parsed > MAX_SAFE_INTEGER || (negative && parsed != 0) {
        return None;
    }
    usize::try_from(parsed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_screen_modes_and_restores_main_or_alternate_cursor() {
        let alternate = parse_pane_screen_info("80|40|1|8|3|0|0|1|0|1|0|2|37|1|1|0|0|1|1\n");
        assert!(alternate.alternate_screen);
        assert!(alternate.modes.mouse_button);
        assert!(alternate.modes.mouse_sgr);
        assert_eq!(alternate.continuation.scroll_region_upper, 2);
        assert_eq!(alternate.continuation.scroll_region_lower, 37);
        assert_eq!(
            append_cursor_restore("TUI SCREEN\n", &alternate),
            "TUI SCREEN\x1b[4;9H"
        );

        let main = parse_pane_screen_info("80|3|0|4|1|0|0|0|0|0|0|0|2|0|0|1|1|0|0\n");
        assert_eq!(
            append_cursor_restore("line1\nline2\nline3\n", &main),
            "line1\nline2\nline3\x1b[1A\x1b[5G"
        );
    }

    #[test]
    fn missing_cursor_preserves_capture_verbatim() {
        let info = parse_pane_screen_info("0|0|0|||||||||||||||||\n");
        assert_eq!(append_cursor_restore("line\n", &info), "line\n");
    }

    #[test]
    fn invalid_region_falls_back_without_emitting_out_of_bounds_state() {
        let info = parse_pane_screen_info("10|4|0|0|0|0|0|0|0|0|0|3|9|0|0|1|1|0|0\n");
        assert_eq!(
            (
                info.continuation.scroll_region_upper,
                info.continuation.scroll_region_lower
            ),
            (0, 3)
        );
    }
}
