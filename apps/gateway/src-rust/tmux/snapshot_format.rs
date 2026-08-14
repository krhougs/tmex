pub const SNAPSHOT_FIELD_SEPARATOR: char = '|';
pub const WINDOW_SNAPSHOT_FORMAT: &str =
    "#{window_id}|#{window_index}|#{window_active}|#{window_layout}|#{window_name}";
pub const PANE_SNAPSHOT_FORMAT: &str = concat!(
    "#{pane_id}|#{window_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|",
    "#{pane_left}|#{pane_top}|#{window_active}|#{pane_title}|#{pane_current_command}|",
    "#{pane_current_path}"
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowSnapshotRow {
    pub id: String,
    pub index: u32,
    pub active: bool,
    pub layout: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneSnapshotRow {
    pub id: String,
    pub window_id: String,
    pub index: u32,
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub left: Option<u32>,
    pub top: Option<u32>,
    pub window_active: bool,
    pub title: Option<String>,
    pub current_command: Option<String>,
    pub current_path: Option<String>,
}

pub fn is_tmux_session_id(value: &str) -> bool {
    is_tmux_numeric_id(value, '$')
}

pub fn is_tmux_window_id(value: &str) -> bool {
    is_tmux_numeric_id(value, '@')
}

pub fn is_tmux_pane_id(value: &str) -> bool {
    is_tmux_numeric_id(value, '%')
}

fn is_tmux_numeric_id(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix).is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub fn parse_snapshot_integer(value: &str) -> Option<u32> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

pub fn format_snapshot_row_for_log(line: &str) -> String {
    format_snapshot_row_for_log_with_limit(line, 160)
}

pub fn format_snapshot_row_for_log_with_limit(line: &str, limit: usize) -> String {
    let length = line.chars().count();
    if length <= limit {
        return line.to_owned();
    }
    let keep = limit.saturating_sub(3);
    let mut result = line.chars().take(keep).collect::<String>();
    result.push_str("...");
    result
}

pub fn parse_window_snapshot_row(line: &str) -> Option<WindowSnapshotRow> {
    let parts = line.split(SNAPSHOT_FIELD_SEPARATOR).collect::<Vec<_>>();
    if parts.len() < 5 {
        return None;
    }
    let id = *parts.first()?;
    let index = parse_snapshot_integer(parts.get(1)?);
    let active = parse_snapshot_flag(parts.get(2)?);
    let layout = parts
        .get(3)
        .filter(|value| is_window_layout(value))
        .map(|value| (*value).to_owned());
    if !is_tmux_window_id(id) {
        return None;
    }
    Some(WindowSnapshotRow {
        id: id.to_owned(),
        index: index?,
        active: active?,
        layout,
        name: parts[4..].join("|"),
    })
}

pub fn parse_pane_snapshot_row(line: &str) -> Option<PaneSnapshotRow> {
    let parts = line.split(SNAPSHOT_FIELD_SEPARATOR).collect::<Vec<_>>();
    if parts.len() < 12 {
        return None;
    }
    let id = *parts.first()?;
    let window_id = *parts.get(1)?;
    if !is_tmux_pane_id(id) || !is_tmux_window_id(window_id) {
        return None;
    }
    let rest = &parts[9..];
    let title = rest[..rest.len() - 2].join("|");
    let current_command = rest[rest.len() - 2];
    let current_path = rest[rest.len() - 1];
    Some(PaneSnapshotRow {
        id: id.to_owned(),
        window_id: window_id.to_owned(),
        index: parse_snapshot_integer(parts.get(2)?)?,
        active: parse_snapshot_flag(parts.get(3)?)?,
        width: parse_snapshot_integer(parts.get(4)?)?,
        height: parse_snapshot_integer(parts.get(5)?)?,
        left: parse_snapshot_integer(parts.get(6)?),
        top: parse_snapshot_integer(parts.get(7)?),
        window_active: parse_snapshot_flag(parts.get(8)?)?,
        title: (!title.trim().is_empty()).then_some(title),
        current_command: nonempty_trimmed(current_command),
        current_path: nonempty_trimmed(current_path),
    })
}

pub fn split_snapshot_fields(line: &str, field_count: usize) -> Vec<String> {
    let parts = line.split(SNAPSHOT_FIELD_SEPARATOR).collect::<Vec<_>>();
    if parts.len() <= field_count {
        return parts.into_iter().map(str::to_owned).collect();
    }
    match field_count {
        2 => vec![parts[0].to_owned(), parts[1..].join("|")],
        4 => vec![
            parts[0].to_owned(),
            parts[1].to_owned(),
            parts[2..parts.len() - 1].join("|"),
            parts[parts.len() - 1].to_owned(),
        ],
        8 => split_flexible_middle(&parts, 3, 4),
        9 => split_flexible_middle(&parts, 3, 5),
        _ => parts.into_iter().map(str::to_owned).collect(),
    }
}

fn split_flexible_middle(parts: &[&str], prefix: usize, suffix: usize) -> Vec<String> {
    let mut result = parts[..prefix]
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    result.push(parts[prefix..parts.len() - suffix].join("|"));
    result.extend(
        parts[parts.len() - suffix..]
            .iter()
            .map(|value| (*value).to_owned()),
    );
    result
}

fn parse_snapshot_flag(value: &str) -> Option<bool> {
    match value {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

fn nonempty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn is_window_layout(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 6
        && bytes[..4].iter().all(u8::is_ascii_hexdigit)
        && bytes[4] == b','
        && bytes[5..].iter().all(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'x' | b',' | b'{' | b'}' | b'[' | b']')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flexible_fields_preserve_pipe_characters_and_reject_malformed_rows() {
        assert_eq!(
            parse_window_snapshot_row(
                "@3|2|1|7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}|name|pipe"
            )
            .unwrap()
            .name,
            "name|pipe"
        );
        let pane =
            parse_pane_snapshot_row("%5|@2|1|1|104|62|0|0|1|title|with|pipe|node|/tmp").unwrap();
        assert_eq!(pane.title.as_deref(), Some("title|with|pipe"));
        assert_eq!(pane.current_command.as_deref(), Some("node"));
        assert!(parse_pane_snapshot_row("bogus|@2|1|1|104|62|0|0|1|t|c|/p").is_none());
    }

    #[test]
    fn identifiers_and_numbers_are_strict() {
        assert!(is_tmux_session_id("$1"));
        assert!(!is_tmux_pane_id("%1_bad"));
        assert_eq!(parse_snapshot_integer("80"), Some(80));
        assert_eq!(parse_snapshot_integer("80x"), None);
    }
}
