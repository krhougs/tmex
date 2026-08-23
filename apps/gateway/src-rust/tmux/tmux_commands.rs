use std::collections::BTreeMap;

use tmex_protocol::{PaneWire, SessionWire, StateSnapshot, WindowWire};

use super::{
    encode_bytes_to_hex_chunks, parse_pane_snapshot_row, parse_window_snapshot_row,
    resolve_tmux_window_style, MovePanePosition, PaneSnapshotRow, SplitDirection,
    WindowSnapshotRow, PANE_HISTORY_CAPTURE_INFO_FORMAT, PANE_META_FORMAT, PANE_SCREEN_INFO_FORMAT,
    PANE_SNAPSHOT_FORMAT, WINDOW_SNAPSHOT_FORMAT,
};

pub const SESSION_SNAPSHOT_FORMAT: &str = "#{session_id}|#{session_name}";

pub fn session_configuration_commands(
    session_name: &str,
    allow_passthrough: bool,
    term_program: &str,
    ghostty_terminfo_available: bool,
    default_working_dir: &str,
) -> Vec<Vec<String>> {
    let mut commands = vec![
        strings([
            "set-option",
            "-t",
            session_name,
            "-s",
            "allow-passthrough",
            if allow_passthrough { "on" } else { "off" },
        ]),
        strings([
            "set-option",
            "-t",
            session_name,
            "-g",
            "extended-keys",
            "on",
        ]),
        strings([
            "set-option",
            "-t",
            session_name,
            "-s",
            "extended-keys-format",
            "csi-u",
        ]),
        strings([
            "set-option",
            "-t",
            session_name,
            "-g",
            "focus-events",
            "off",
        ]),
        strings([
            "set-option",
            "-t",
            session_name,
            "destroy-unattached",
            "off",
        ]),
    ];
    let term_program = term_program.trim();
    if !term_program.is_empty() && !term_program.eq_ignore_ascii_case("off") {
        commands.push(strings([
            "set-environment",
            "-t",
            session_name,
            "TERM_PROGRAM",
            term_program,
        ]));
        if term_program == "ghostty" && ghostty_terminfo_available {
            commands.push(strings([
                "set-option",
                "-t",
                session_name,
                "default-terminal",
                "xterm-ghostty",
            ]));
        }
    }
    commands.push(strings([
        "set-environment",
        "-t",
        session_name,
        "COLORTERM",
        "truecolor",
    ]));
    commands.push(strings([
        "set-option",
        "-t",
        session_name,
        "default-path",
        default_working_dir,
    ]));
    commands
}

pub fn configure_window_style_commands(
    session_name: &str,
    window_ids: &[String],
    style: &str,
) -> Option<Vec<Vec<String>>> {
    let style = resolve_tmux_window_style(style)?;
    let mut commands = vec![vec![
        "set-hook".to_owned(),
        "-t".to_owned(),
        session_name.to_owned(),
        "after-new-window".to_owned(),
        format!("set-option -w window-style '{style}'"),
    ]];
    commands.extend(window_ids.iter().map(|window_id| {
        vec![
            "set-option".to_owned(),
            "-w".to_owned(),
            "-t".to_owned(),
            window_id.clone(),
            "window-style".to_owned(),
            style.clone(),
        ]
    }));
    Some(commands)
}

pub fn ensure_session_commands(session_name: &str, cwd: &str) -> [Vec<String>; 2] {
    [
        strings(["has-session", "-t", session_name]),
        strings(["new-session", "-d", "-c", cwd, "-s", session_name]),
    ]
}

pub fn create_window_command(session_name: &str, cwd: &str, name: Option<&str>) -> Vec<String> {
    let mut command = strings([
        "new-window",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        session_name,
        "-c",
        cwd,
    ]);
    if let Some(name) = name {
        command.extend(["-n".to_owned(), name.to_owned()]);
    }
    command
}

pub fn split_pane_command(pane_id: &str, direction: SplitDirection, cwd: &str) -> Vec<String> {
    strings([
        "split-window",
        match direction {
            SplitDirection::Horizontal => "-h",
            SplitDirection::Vertical => "-v",
        },
        "-t",
        pane_id,
        "-c",
        cwd,
        "-P",
        "-F",
        "#{window_id}|#{pane_id}",
    ])
}

pub fn move_pane_command(
    source_pane_id: &str,
    target_pane_id: &str,
    position: MovePanePosition,
) -> Vec<String> {
    let orientation = match position {
        MovePanePosition::Left | MovePanePosition::Right => "-h",
        MovePanePosition::Top | MovePanePosition::Bottom => "-v",
    };
    let mut command = strings(["move-pane", orientation]);
    if matches!(position, MovePanePosition::Left | MovePanePosition::Top) {
        command.push("-b".to_owned());
    }
    command.extend(strings(["-s", source_pane_id, "-t", target_pane_id]));
    command
}

pub fn send_input_commands(pane_id: &str, data: &[u8]) -> Vec<Vec<String>> {
    encode_bytes_to_hex_chunks(data)
        .into_iter()
        .map(|chunk| {
            let mut command = strings(["send-keys", "-H", "-t", pane_id]);
            command.extend(chunk);
            command
        })
        .collect()
}

pub fn resize_window_command(window_id: &str, cols: u16, rows: u16) -> Vec<String> {
    strings([
        "resize-window",
        "-t",
        window_id,
        "-x",
        &cols.max(2).to_string(),
        "-y",
        &rows.max(2).to_string(),
    ])
}

pub fn resize_pane_command(pane_id: &str, cols: Option<u16>, rows: Option<u16>) -> Vec<String> {
    let mut command = strings(["resize-pane", "-t", pane_id]);
    if let Some(cols) = cols {
        command.extend(["-x".to_owned(), cols.max(2).to_string()]);
    }
    if let Some(rows) = rows {
        command.extend(["-y".to_owned(), rows.max(2).to_string()]);
    }
    command
}

pub fn capture_pane_text_command(pane_id: &str, history_lines: Option<usize>) -> Vec<String> {
    let mut command = strings(["capture-pane", "-t", pane_id, "-p", "-e", "-J", "-N"]);
    if let Some(lines) = history_lines.filter(|lines| *lines > 0) {
        command.extend(["-S".to_owned(), format!("-{lines}")]);
    }
    command
}

pub fn capture_pane_screen_command(pane_id: &str, history_lines: Option<usize>) -> Vec<String> {
    // `-J` removes padded physical cells even together with `-N`; checkpoints need those cells.
    let mut command = strings(["capture-pane", "-t", pane_id, "-p", "-e", "-N"]);
    if let Some(lines) = history_lines.filter(|lines| *lines > 0) {
        command.extend(["-S".to_owned(), format!("-{lines}")]);
    }
    command
}

pub fn pane_info_command(pane_id: &str) -> Vec<String> {
    strings(["display-message", "-p", "-t", pane_id, PANE_META_FORMAT])
}

pub fn pane_screen_info_command(pane_id: &str) -> Vec<String> {
    strings([
        "display-message",
        "-p",
        "-t",
        pane_id,
        PANE_SCREEN_INFO_FORMAT,
    ])
}

pub fn pane_history_info_command(pane_id: &str) -> Vec<String> {
    strings([
        "display-message",
        "-p",
        "-t",
        pane_id,
        PANE_HISTORY_CAPTURE_INFO_FORMAT,
    ])
}

pub fn capture_history_range_command(pane_id: &str, start_line: i64, end_line: i64) -> Vec<String> {
    strings([
        "capture-pane",
        "-t",
        pane_id,
        "-p",
        "-e",
        "-N",
        "-S",
        &start_line.to_string(),
        "-E",
        &end_line.to_string(),
    ])
}

pub fn snapshot_commands(session_name: &str) -> [Vec<String>; 3] {
    [
        strings([
            "display-message",
            "-p",
            "-t",
            session_name,
            SESSION_SNAPSHOT_FORMAT,
        ]),
        strings([
            "list-windows",
            "-t",
            session_name,
            "-F",
            WINDOW_SNAPSHOT_FORMAT,
        ]),
        strings([
            "list-panes",
            "-s",
            "-t",
            session_name,
            "-F",
            PANE_SNAPSHOT_FORMAT,
        ]),
    ]
}

pub fn parse_state_snapshot(
    device_id: &str,
    session_output: &str,
    windows_output: &str,
    panes_output: &str,
) -> StateSnapshot {
    let session = parse_session(session_output).and_then(|(session_id, session_name)| {
        let windows = windows_output
            .lines()
            .filter_map(parse_window_snapshot_row)
            .collect::<Vec<_>>();
        if windows.is_empty() {
            return None;
        }
        let panes = panes_output
            .lines()
            .filter_map(parse_pane_snapshot_row)
            .collect::<Vec<_>>();
        Some(build_session(session_id, session_name, windows, panes))
    });
    StateSnapshot {
        device_id: device_id.to_owned(),
        session,
    }
}

fn parse_session(output: &str) -> Option<(String, String)> {
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let (id, name) = line.split_once('|')?;
    super::is_tmux_session_id(id).then(|| (id.to_owned(), name.to_owned()))
}

fn build_session(
    id: String,
    name: String,
    mut windows: Vec<WindowSnapshotRow>,
    panes: Vec<PaneSnapshotRow>,
) -> SessionWire {
    windows.sort_by_key(|window| window.index);
    let mut panes_by_window = BTreeMap::<String, Vec<PaneSnapshotRow>>::new();
    for pane in panes {
        panes_by_window
            .entry(pane.window_id.clone())
            .or_default()
            .push(pane);
    }
    SessionWire {
        id,
        name,
        windows: windows
            .into_iter()
            .filter_map(|window| {
                let index = u16::try_from(window.index).ok()?;
                let mut panes = panes_by_window.remove(&window.id).unwrap_or_default();
                panes.sort_by_key(|pane| pane.index);
                Some(WindowWire {
                    id: window.id.clone(),
                    name: window.name,
                    custom_name: None,
                    index,
                    active: window.active,
                    layout: window.layout,
                    panes: panes
                        .into_iter()
                        .filter_map(|pane| pane_wire(pane, &window.id))
                        .collect(),
                })
            })
            .collect(),
    }
}

fn pane_wire(pane: PaneSnapshotRow, window_id: &str) -> Option<PaneWire> {
    (pane.window_id == window_id).then_some(())?;
    Some(PaneWire {
        id: pane.id,
        window_id: pane.window_id,
        index: u16::try_from(pane.index).ok()?,
        title: pane.title,
        custom_name: None,
        active: pane.active,
        width: u16::try_from(pane.width).ok()?,
        height: u16::try_from(pane.height).ok()?,
        current_path: pane.current_path,
        current_command: pane.current_command,
        left: pane.left.and_then(|value| u16::try_from(value).ok()),
        top: pane.top.and_then(|value| u16::try_from(value).ok()),
    })
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_parser_drops_invalid_rows_and_orders_tmux_indices() {
        let snapshot = parse_state_snapshot(
            "device",
            "$1|safe-session\n",
            "@2|2|0|abcd,80x24,0,0,2|second\nBAD_@1|0|1|abcd,80x24,0,0,1|bad\n@1|0|1|abcd,80x24,0,0,1|first\n",
            "%2|@2|0|1|80|24|0|0|0|two|bash|/tmp\n%1|@1|0|1|80|24|0|0|1|one|zsh|/home\n",
        );
        let session = snapshot.session.unwrap();

        assert_eq!(
            session
                .windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            ["@1", "@2"]
        );
        assert_eq!(session.windows[0].panes[0].id, "%1");
    }

    #[test]
    fn input_and_layout_commands_preserve_atomic_ordering() {
        assert_eq!(
            send_input_commands("%1", &[0x00, 0xff]),
            vec![vec!["send-keys", "-H", "-t", "%1", "00", "ff"]]
        );
        assert_eq!(
            move_pane_command("%1", "%2", MovePanePosition::Left),
            ["move-pane", "-h", "-b", "-s", "%1", "-t", "%2"]
        );
    }

    #[test]
    fn screen_capture_preserves_physical_rows_while_text_capture_joins_them() {
        assert_eq!(
            capture_pane_screen_command("%1", Some(50)),
            ["capture-pane", "-t", "%1", "-p", "-e", "-N", "-S", "-50"]
        );
        assert_eq!(
            capture_pane_text_command("%1", Some(50)),
            [
                "capture-pane",
                "-t",
                "%1",
                "-p",
                "-e",
                "-J",
                "-N",
                "-S",
                "-50"
            ]
        );
    }

    #[test]
    fn ghostty_default_terminal_is_set_only_after_terminfo_is_available() {
        let unavailable = session_configuration_commands("tmex", false, "ghostty", false, "/tmp");
        assert!(!unavailable
            .iter()
            .any(|command| command.iter().any(|value| value == "xterm-ghostty")));

        let available = session_configuration_commands("tmex", false, "ghostty", true, "/tmp");
        assert!(available.contains(&strings([
            "set-option",
            "-t",
            "tmex",
            "default-terminal",
            "xterm-ghostty",
        ])));
    }
}
