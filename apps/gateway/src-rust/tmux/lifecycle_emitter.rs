use std::collections::BTreeMap;

use tmex_protocol::WindowWire;

use super::metadata_projection::ProjectionEntityKind;
use super::snapshot_diff::diff_snapshot_closures;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleEventKind {
    SessionCreated,
    SessionClosed,
    TmuxWindowClose,
    TmuxPaneClose,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LifecycleTmuxContext {
    pub session_name: Option<String>,
    pub window_id: Option<String>,
    pub window_index: Option<u16>,
    pub pane_id: Option<String>,
    pub pane_index: Option<u16>,
    pub pane_title: Option<String>,
    pub pane_current_command: Option<String>,
    pub pane_current_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleEvent {
    pub kind: LifecycleEventKind,
    pub tmux: LifecycleTmuxContext,
    pub payload: BTreeMap<String, String>,
}

pub trait TmuxLifecycleSink: Send + Sync + 'static {
    fn publish(&self, device_id: String, event: LifecycleEvent);
}

impl<Publish> TmuxLifecycleSink for Publish
where
    Publish: Fn(String, LifecycleEvent) + Send + Sync + 'static,
{
    fn publish(&self, device_id: String, event: LifecycleEvent) {
        self(device_id, event);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConnectionLifecycleEmitter {
    session_closed_emitted: bool,
}

impl ConnectionLifecycleEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.session_closed_emitted = false;
    }

    pub fn session_closed_emitted(&self) -> bool {
        self.session_closed_emitted
    }

    pub fn notify_session_closed(
        &mut self,
        session_name: impl Into<String>,
        message: &str,
    ) -> Option<LifecycleEvent> {
        if self.session_closed_emitted {
            return None;
        }
        self.session_closed_emitted = true;
        let first_line = message.lines().next().unwrap_or_default().trim().to_owned();
        Some(LifecycleEvent {
            kind: LifecycleEventKind::SessionClosed,
            tmux: LifecycleTmuxContext {
                session_name: Some(session_name.into()),
                ..LifecycleTmuxContext::default()
            },
            payload: BTreeMap::from([("message".to_owned(), first_line)]),
        })
    }

    pub fn notify_session_created(session_name: impl Into<String>) -> LifecycleEvent {
        LifecycleEvent {
            kind: LifecycleEventKind::SessionCreated,
            tmux: LifecycleTmuxContext {
                session_name: Some(session_name.into()),
                ..LifecycleTmuxContext::default()
            },
            payload: BTreeMap::new(),
        }
    }

    pub fn snapshot_closures<ResolveName>(
        &self,
        previous: &BTreeMap<String, WindowWire>,
        next: &BTreeMap<String, WindowWire>,
        emittable: bool,
        session_name: &str,
        mut resolve_custom_name: ResolveName,
    ) -> Vec<LifecycleEvent>
    where
        ResolveName: FnMut(ProjectionEntityKind, &str) -> Option<String>,
    {
        if previous.is_empty() || next.is_empty() || !emittable {
            return Vec::new();
        }
        let closures = diff_snapshot_closures(previous, next);
        let mut events =
            Vec::with_capacity(closures.closed_windows.len() + closures.closed_panes.len());
        for window in closures.closed_windows {
            let window_name = resolve_custom_name(ProjectionEntityKind::Window, &window.id)
                .unwrap_or_else(|| window.name.clone());
            events.push(LifecycleEvent {
                kind: LifecycleEventKind::TmuxWindowClose,
                tmux: LifecycleTmuxContext {
                    session_name: Some(session_name.to_owned()),
                    window_id: Some(window.id),
                    window_index: Some(window.index),
                    ..LifecycleTmuxContext::default()
                },
                payload: BTreeMap::from([("windowName".to_owned(), window_name)]),
            });
        }
        for closed in closures.closed_panes {
            let pane_title = resolve_custom_name(ProjectionEntityKind::Pane, &closed.pane.id)
                .or(closed.pane.title.clone());
            let window_name = resolve_custom_name(ProjectionEntityKind::Window, &closed.window.id)
                .unwrap_or_else(|| closed.window.name.clone());
            events.push(LifecycleEvent {
                kind: LifecycleEventKind::TmuxPaneClose,
                tmux: LifecycleTmuxContext {
                    session_name: Some(session_name.to_owned()),
                    window_id: Some(closed.window.id),
                    window_index: Some(closed.window.index),
                    pane_id: Some(closed.pane.id),
                    pane_index: Some(closed.pane.index),
                    pane_title,
                    pane_current_command: closed.pane.current_command,
                    pane_current_path: closed.pane.current_path,
                },
                payload: BTreeMap::from([("windowName".to_owned(), window_name)]),
            });
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_close_is_once_per_connection_and_reset_rearms_it() {
        let mut emitter = ConnectionLifecycleEmitter::new();
        let first = emitter.notify_session_closed("work", "line one\nline two");
        assert_eq!(
            first.unwrap().payload.get("message").map(String::as_str),
            Some("line one")
        );
        assert!(emitter.notify_session_closed("work", "again").is_none());
        emitter.reset();
        assert!(emitter.notify_session_closed("work", "after").is_some());
    }
}
