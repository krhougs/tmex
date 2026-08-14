use std::collections::{BTreeMap, HashSet};

use tmex_protocol::{PaneWire, WindowWire};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SnapshotClosures {
    pub closed_windows: Vec<WindowWire>,
    pub closed_panes: Vec<ClosedPane>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedPane {
    pub pane: PaneWire,
    pub window: WindowWire,
}

pub fn diff_snapshot_closures(
    previous: &BTreeMap<String, WindowWire>,
    next: &BTreeMap<String, WindowWire>,
) -> SnapshotClosures {
    let next_pane_ids = next
        .values()
        .flat_map(|window| window.panes.iter().map(|pane| pane.id.as_str()))
        .collect::<HashSet<_>>();
    let mut result = SnapshotClosures::default();
    for (window_id, previous_window) in previous {
        if !next.contains_key(window_id) {
            result.closed_windows.push(previous_window.clone());
            continue;
        }
        for pane in &previous_window.panes {
            if !next_pane_ids.contains(pane.id.as_str()) {
                result.closed_panes.push(ClosedPane {
                    pane: pane.clone(),
                    window: previous_window.clone(),
                });
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, window_id: &str) -> PaneWire {
        PaneWire {
            id: id.to_owned(),
            window_id: window_id.to_owned(),
            index: 0,
            title: Some(format!("title-{id}")),
            custom_name: None,
            active: true,
            width: 80,
            height: 24,
            current_path: None,
            current_command: None,
            left: Some(0),
            top: Some(0),
        }
    }

    fn window(id: &str, panes: Vec<PaneWire>) -> WindowWire {
        WindowWire {
            id: id.to_owned(),
            name: format!("window-{id}"),
            custom_name: None,
            index: 0,
            active: true,
            layout: None,
            panes,
        }
    }

    #[test]
    fn window_close_suppresses_child_closes_and_moved_panes_survive() {
        let previous = BTreeMap::from([
            (
                "@1".to_owned(),
                window("@1", vec![pane("%1", "@1"), pane("%2", "@1")]),
            ),
            ("@2".to_owned(), window("@2", vec![pane("%3", "@2")])),
        ]);
        let next = BTreeMap::from([
            ("@2".to_owned(), window("@2", vec![])),
            ("@9".to_owned(), window("@9", vec![pane("%3", "@9")])),
        ]);
        let result = diff_snapshot_closures(&previous, &next);
        assert_eq!(result.closed_windows[0].id, "@1");
        assert!(result.closed_panes.is_empty());
    }
}
