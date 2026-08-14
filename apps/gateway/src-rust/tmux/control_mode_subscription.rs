use std::collections::{HashMap, HashSet};

use tmex_terminal::{
    ControlModeBlock, ControlModeEvent, ControlModeNotification, ControlModeParser,
    PaneStreamEvent, PaneStreamFragment, PaneStreamNotification, PaneStreamParser, PromptMarker,
};

use super::control_mode_capture::ControlModeQueueGuard;
use super::control_stream_metrics::{
    ControlStreamMetrics, ControlStreamMetricsError, ControlStreamMetricsSnapshot,
};

pub const STRUCTURE_RECONCILE_MS: u64 = 50;

pub const SOURCE_METADATA_SUBSCRIPTION_COMMANDS: [&str; 2] = [
    "refresh-client -B \"tmex-cwd:%*:#{pane_current_path}\"\n",
    "refresh-client -B \"tmex-command:%*:#{pane_current_command}\"\n",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceMetadataEvent {
    PaneCurrentPath {
        pane_id: String,
        current_path: String,
    },
    PaneCurrentCommand {
        pane_id: String,
        current_command: String,
    },
    SessionRenamed {
        session_id: String,
        name: String,
    },
    SessionWindowChanged {
        session_id: String,
        window_id: String,
    },
    WindowRenamed {
        window_id: String,
        name: String,
    },
    WindowPaneChanged {
        window_id: String,
        pane_id: String,
    },
    LayoutChanged {
        window_id: String,
        layout: String,
    },
    WindowClosed {
        window_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlModeSubscriptionEvent {
    TerminalOutput {
        pane_id: String,
        data: Vec<u8>,
    },
    Title {
        pane_id: String,
        title: String,
    },
    Bell {
        pane_id: String,
    },
    Notification {
        pane_id: String,
        notification: PaneStreamNotification,
    },
    PromptMarker {
        pane_id: String,
        marker: PromptMarker,
    },
    ClipboardWrite {
        pane_id: String,
        text: String,
    },
    ThemeSubscription {
        pane_id: String,
        subscribed: bool,
    },
    SourceMetadata(SourceMetadataEvent),
    Pause {
        pane_id: String,
    },
    Continue {
        pane_id: String,
    },
    StructureChanged,
    Exit {
        reason: Option<String>,
    },
    UnhandledBlock(ControlModeBlock),
    Metrics(ControlStreamMetricsSnapshot),
}

pub struct ControlModeSubscription {
    parser: ControlModeParser,
    pane_parsers: HashMap<String, PaneStreamParser>,
    command_queue: Option<ControlModeQueueGuard>,
    metrics: Option<ControlStreamMetrics>,
    structure_due_at_ms: Option<u64>,
    disposed: bool,
}

impl Default for ControlModeSubscription {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlModeSubscription {
    pub fn new() -> Self {
        Self::from_command_queue(None)
    }

    pub fn with_command_queue(command_queue: ControlModeQueueGuard) -> Self {
        Self::from_command_queue(Some(command_queue))
    }

    fn from_command_queue(command_queue: Option<ControlModeQueueGuard>) -> Self {
        let literal_queue = command_queue.clone();
        Self {
            parser: ControlModeParser::with_literal_block_selector(move |_| {
                literal_queue
                    .as_ref()
                    .is_some_and(ControlModeQueueGuard::next_block_is_literal)
            }),
            pane_parsers: HashMap::new(),
            command_queue,
            metrics: None,
            structure_due_at_ms: None,
            disposed: false,
        }
    }

    pub fn enable_metrics(
        &mut self,
        interval_ms: u64,
        window_started_at_ms: u64,
    ) -> Result<(), ControlStreamMetricsError> {
        self.metrics = Some(ControlStreamMetrics::new(
            interval_ms,
            window_started_at_ms,
        )?);
        Ok(())
    }

    pub fn push(&mut self, chunk: &[u8], now_ms: u64) -> Vec<ControlModeSubscriptionEvent> {
        if self.disposed {
            return Vec::new();
        }
        let mut projected = self.advance(now_ms);
        if let Some(metrics) = &mut self.metrics {
            metrics.record_raw_chunk(chunk.len());
        }

        let mut start = 0;
        while let Some(relative_newline) = chunk[start..].iter().position(|byte| *byte == b'\n') {
            let end = start + relative_newline + 1;
            let events = self.parser.push(&chunk[start..end]);
            self.project_control_events(events, now_ms, &mut projected);
            start = end;
        }
        if start < chunk.len() {
            let events = self.parser.push(&chunk[start..]);
            self.project_control_events(events, now_ms, &mut projected);
        }

        if let Some(snapshot) = self
            .metrics
            .as_mut()
            .and_then(|metrics| metrics.take_if_due(now_ms))
        {
            projected.push(ControlModeSubscriptionEvent::Metrics(snapshot));
        }
        projected
    }

    pub fn end(&mut self, now_ms: u64) -> Vec<ControlModeSubscriptionEvent> {
        if self.disposed {
            return Vec::new();
        }
        let mut projected = self.advance(now_ms);
        let events = self.parser.end();
        self.project_control_events(events, now_ms, &mut projected);
        projected
    }

    pub fn advance(&mut self, now_ms: u64) -> Vec<ControlModeSubscriptionEvent> {
        if self.disposed || self.structure_due_at_ms.is_none_or(|due| now_ms < due) {
            return Vec::new();
        }
        self.structure_due_at_ms = None;
        if let Some(metrics) = &mut self.metrics {
            metrics.record_structure_change();
        }
        vec![ControlModeSubscriptionEvent::StructureChanged]
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        (!self.disposed)
            .then_some(self.structure_due_at_ms)
            .flatten()
    }

    pub fn prune_panes(&mut self, valid_pane_ids: &HashSet<String>) {
        self.pane_parsers
            .retain(|pane_id, _| valid_pane_ids.contains(pane_id));
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.structure_due_at_ms = None;
        self.pane_parsers.clear();
    }

    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    fn project_control_events(
        &mut self,
        events: Vec<ControlModeEvent>,
        now_ms: u64,
        projected: &mut Vec<ControlModeSubscriptionEvent>,
    ) {
        for event in events {
            match event {
                ControlModeEvent::Output { pane_id, data } => {
                    if let Some(metrics) = &mut self.metrics {
                        metrics.record_control_output(data.len());
                    }
                    let pane_output = self
                        .pane_parsers
                        .entry(pane_id.clone())
                        .or_default()
                        .push(&data);
                    for fragment in pane_output.ordered_fragments() {
                        match fragment {
                            PaneStreamFragment::Terminal(data) => {
                                if let Some(metrics) = &mut self.metrics {
                                    metrics.record_terminal_output(data.len());
                                }
                                projected.push(ControlModeSubscriptionEvent::TerminalOutput {
                                    pane_id: pane_id.clone(),
                                    data: data.to_vec(),
                                });
                            }
                            PaneStreamFragment::Event(event) => {
                                self.project_pane_event(&pane_id, event.clone(), projected);
                            }
                        }
                    }
                }
                ControlModeEvent::Notification(notification) => {
                    if let Some(metadata) = structured_metadata(&notification) {
                        projected.push(ControlModeSubscriptionEvent::SourceMetadata(metadata));
                    }
                    if matches!(
                        notification.r#type.as_str(),
                        "sessions-changed" | "window-add"
                    ) {
                        self.structure_due_at_ms
                            .get_or_insert(now_ms.saturating_add(STRUCTURE_RECONCILE_MS));
                    }
                    match notification.r#type.as_str() {
                        "pause" => projected.push(ControlModeSubscriptionEvent::Pause {
                            pane_id: notification.args.trim().to_owned(),
                        }),
                        "continue" => projected.push(ControlModeSubscriptionEvent::Continue {
                            pane_id: notification.args.trim().to_owned(),
                        }),
                        _ => {}
                    }
                }
                ControlModeEvent::Exit(reason) => {
                    projected.push(ControlModeSubscriptionEvent::Exit { reason });
                }
                ControlModeEvent::Block(block) => {
                    if let Some(metrics) = &mut self.metrics {
                        metrics.record_block();
                    }
                    let handled = self
                        .command_queue
                        .as_ref()
                        .is_some_and(|queue| queue.handle_block(&block));
                    if !handled {
                        projected.push(ControlModeSubscriptionEvent::UnhandledBlock(block));
                    }
                }
            }
        }
    }

    fn project_pane_event(
        &mut self,
        pane_id: &str,
        event: PaneStreamEvent,
        projected: &mut Vec<ControlModeSubscriptionEvent>,
    ) {
        let pane_id = pane_id.to_owned();
        match event {
            PaneStreamEvent::Title(title) => {
                if let Some(metrics) = &mut self.metrics {
                    metrics.record_title();
                }
                projected.push(ControlModeSubscriptionEvent::Title { pane_id, title });
            }
            PaneStreamEvent::CurrentPath(current_path) => {
                projected.push(ControlModeSubscriptionEvent::SourceMetadata(
                    SourceMetadataEvent::PaneCurrentPath {
                        pane_id,
                        current_path,
                    },
                ));
            }
            PaneStreamEvent::Bell => {
                if let Some(metrics) = &mut self.metrics {
                    metrics.record_bell();
                }
                projected.push(ControlModeSubscriptionEvent::Bell { pane_id });
            }
            PaneStreamEvent::Notification(notification) => {
                if let Some(metrics) = &mut self.metrics {
                    metrics.record_notification();
                }
                projected.push(ControlModeSubscriptionEvent::Notification {
                    pane_id,
                    notification,
                });
            }
            PaneStreamEvent::PromptMarker(marker) => {
                projected.push(ControlModeSubscriptionEvent::PromptMarker { pane_id, marker });
            }
            PaneStreamEvent::ClipboardWrite(text) => {
                projected.push(ControlModeSubscriptionEvent::ClipboardWrite { pane_id, text });
            }
            PaneStreamEvent::ThemeSubscription(subscribed) => {
                projected.push(ControlModeSubscriptionEvent::ThemeSubscription {
                    pane_id,
                    subscribed,
                });
            }
        }
    }
}

fn structured_metadata(notification: &ControlModeNotification) -> Option<SourceMetadataEvent> {
    let trimmed = notification.args.trim();
    let (first, rest) = split_first(trimmed);
    match notification.r#type.as_str() {
        "session-renamed" if !first.is_empty() && !rest.is_empty() => {
            Some(SourceMetadataEvent::SessionRenamed {
                session_id: first.to_owned(),
                name: rest.to_owned(),
            })
        }
        "session-window-changed" => {
            let (window_id, _) = split_first(rest);
            (!first.is_empty() && !window_id.is_empty()).then(|| {
                SourceMetadataEvent::SessionWindowChanged {
                    session_id: first.to_owned(),
                    window_id: window_id.to_owned(),
                }
            })
        }
        "window-renamed" if !first.is_empty() && !rest.is_empty() => {
            Some(SourceMetadataEvent::WindowRenamed {
                window_id: first.to_owned(),
                name: rest.to_owned(),
            })
        }
        "window-pane-changed" => {
            let (pane_id, _) = split_first(rest);
            (!first.is_empty() && !pane_id.is_empty()).then(|| {
                SourceMetadataEvent::WindowPaneChanged {
                    window_id: first.to_owned(),
                    pane_id: pane_id.to_owned(),
                }
            })
        }
        "layout-change" => {
            let (layout, _) = split_first(rest);
            (!first.is_empty() && !layout.is_empty()).then(|| SourceMetadataEvent::LayoutChanged {
                window_id: first.to_owned(),
                layout: layout.to_owned(),
            })
        }
        "window-close" | "unlinked-window-close" if !first.is_empty() => {
            Some(SourceMetadataEvent::WindowClosed {
                window_id: first.to_owned(),
            })
        }
        "subscription-changed" => subscription_metadata(&notification.args),
        _ => None,
    }
}

fn subscription_metadata(args: &str) -> Option<SourceMetadataEvent> {
    let separator = args.find(" : ")?;
    let header = args[..separator].split_whitespace().collect::<Vec<_>>();
    let name = *header.first()?;
    let pane_id = header.iter().copied().find(|part| is_tmux_pane_id(part))?;
    let value = args[separator + 3..].to_owned();
    match name {
        "tmex-cwd" => Some(SourceMetadataEvent::PaneCurrentPath {
            pane_id: pane_id.to_owned(),
            current_path: value,
        }),
        "tmex-command" => Some(SourceMetadataEvent::PaneCurrentCommand {
            pane_id: pane_id.to_owned(),
            current_command: value,
        }),
        _ => None,
    }
}

fn split_first(value: &str) -> (&str, &str) {
    value
        .find(' ')
        .map_or((value, ""), |index| (&value[..index], &value[index + 1..]))
}

fn is_tmux_pane_id(value: &str) -> bool {
    value.strip_prefix('%').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use tmex_terminal::{PaneStreamNotificationSource, PromptMarkerKind};

    use super::*;

    #[test]
    fn routes_interleaved_panes_in_original_terminal_and_side_channel_order() {
        let mut subscription = ControlModeSubscription::new();
        let first = subscription.push(b"%output %1 \\033]9;part\n%output %2 A\\007B\n", 0);
        assert_eq!(
            first,
            vec![
                ControlModeSubscriptionEvent::TerminalOutput {
                    pane_id: "%2".to_owned(),
                    data: b"A".to_vec(),
                },
                ControlModeSubscriptionEvent::Bell {
                    pane_id: "%2".to_owned(),
                },
                ControlModeSubscriptionEvent::TerminalOutput {
                    pane_id: "%2".to_owned(),
                    data: b"B".to_vec(),
                },
            ]
        );
        let second = subscription.push(
            b"%output %1 ial\\007\n%output %1 tail\\033]133;D;7\\007after\n",
            1,
        );
        assert_eq!(
            second,
            vec![
                ControlModeSubscriptionEvent::Notification {
                    pane_id: "%1".to_owned(),
                    notification: PaneStreamNotification {
                        source: PaneStreamNotificationSource::Osc9,
                        title: None,
                        body: "partial".to_owned(),
                    },
                },
                ControlModeSubscriptionEvent::TerminalOutput {
                    pane_id: "%1".to_owned(),
                    data: b"tail".to_vec(),
                },
                ControlModeSubscriptionEvent::PromptMarker {
                    pane_id: "%1".to_owned(),
                    marker: PromptMarker {
                        kind: PromptMarkerKind::D,
                        exit_code: Some(7),
                        params: vec!["7".to_owned()],
                    },
                },
                ControlModeSubscriptionEvent::TerminalOutput {
                    pane_id: "%1".to_owned(),
                    data: b"after".to_vec(),
                },
            ]
        );
    }

    #[test]
    fn projects_metadata_and_coalesces_structure_reconcile_on_an_explicit_deadline() {
        let mut subscription = ControlModeSubscription::new();
        let events = subscription.push(
            b"%window-add @1\n%layout-change @1 x y !\n%window-renamed @1 zsh\n%subscription-changed tmex-cwd $1 @1 0 %7 : /work/tree with spaces\n",
            100,
        );
        assert_eq!(
            events,
            vec![
                ControlModeSubscriptionEvent::SourceMetadata(SourceMetadataEvent::LayoutChanged {
                    window_id: "@1".to_owned(),
                    layout: "x".to_owned(),
                }),
                ControlModeSubscriptionEvent::SourceMetadata(SourceMetadataEvent::WindowRenamed {
                    window_id: "@1".to_owned(),
                    name: "zsh".to_owned(),
                }),
                ControlModeSubscriptionEvent::SourceMetadata(
                    SourceMetadataEvent::PaneCurrentPath {
                        pane_id: "%7".to_owned(),
                        current_path: "/work/tree with spaces".to_owned(),
                    }
                ),
            ]
        );
        assert_eq!(subscription.next_deadline_ms(), Some(150));
        assert!(subscription.advance(149).is_empty());
        assert_eq!(
            subscription.advance(150),
            vec![ControlModeSubscriptionEvent::StructureChanged]
        );
        assert!(subscription.advance(200).is_empty());
    }

    #[test]
    fn metrics_count_raw_parsed_and_swallowed_traffic_in_the_same_window() {
        let mut subscription = ControlModeSubscription::new();
        subscription.enable_metrics(10, 0).unwrap();
        let first = b"%output %1 hello\n";
        let second = b"%output %1 \\033]2;title\\007\n";
        assert!(subscription
            .push(first, 0)
            .iter()
            .all(|event| !matches!(event, ControlModeSubscriptionEvent::Metrics(_))));
        let events = subscription.push(second, 10);
        let snapshot = events
            .iter()
            .find_map(|event| match event {
                ControlModeSubscriptionEvent::Metrics(snapshot) => Some(snapshot),
                _ => None,
            })
            .unwrap();
        assert_eq!(snapshot.raw_chunks, 2);
        assert_eq!(snapshot.raw_bytes, (first.len() + second.len()) as u64);
        assert_eq!(snapshot.control_outputs, 2);
        assert_eq!(snapshot.terminal_outputs, 1);
        assert_eq!(snapshot.terminal_output_bytes, 5);
        assert_eq!(snapshot.titles, 1);
    }
}
