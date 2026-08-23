use std::fmt;

use tmex_protocol::WireToken;
use tmex_terminal::{
    HeadlessTerminal, HeadlessTerminalOptions, PromptMarker, TerminalContinuationState,
    TerminalSize, TerminalTap, TerminalTapId,
};

use super::{PaneDataSegment, PaneReplayPlan, PaneScreenCheckpoint};

fn normalize_checkpoint_line_endings(data: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(data.len());
    let mut previous_was_cr = false;
    for &byte in data {
        if byte == b'\n' && !previous_was_cr {
            normalized.push(b'\r');
        }
        normalized.push(byte);
        previous_was_cr = byte == b'\r';
    }
    normalized
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneEmulatorError {
    PaneMismatch { expected: String, actual: String },
    EpochMismatch,
    ReplayGap,
    ReplayNeedsScreen,
    SequenceGap { expected: u64, actual: u64 },
    InvalidSequenceRange,
}

impl fmt::Display for PaneEmulatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PaneMismatch { expected, actual } => {
                write!(formatter, "pane emulator expected {expected}, got {actual}")
            }
            Self::EpochMismatch => formatter.write_str("pane emulator epoch changed"),
            Self::ReplayGap => formatter.write_str("pane replay contains an explicit gap"),
            Self::ReplayNeedsScreen => {
                formatter.write_str("pane replay requires a newer screen checkpoint")
            }
            Self::SequenceGap { expected, actual } => write!(
                formatter,
                "pane emulator sequence gap: expected {expected}, got {actual}"
            ),
            Self::InvalidSequenceRange => {
                formatter.write_str("pane segment sequence range does not match its bytes")
            }
        }
    }
}

impl std::error::Error for PaneEmulatorError {}

pub struct PaneEmulator {
    pane_id: String,
    terminal: HeadlessTerminal,
    pane_epoch: Option<WireToken>,
    terminal_seq: u64,
}

impl PaneEmulator {
    pub fn new(pane_id: impl Into<String>, options: HeadlessTerminalOptions) -> Self {
        Self {
            pane_id: pane_id.into(),
            terminal: HeadlessTerminal::new(options),
            pane_epoch: None,
            terminal_seq: 0,
        }
    }

    pub fn rebuild(
        &mut self,
        checkpoint: &PaneScreenCheckpoint,
        replay: &PaneReplayPlan,
    ) -> Result<(), PaneEmulatorError> {
        self.validate_pane(&checkpoint.pane_id)?;
        self.validate_pane(&replay.pane_id)?;
        if checkpoint.pane_epoch != replay.pane_epoch {
            return Err(PaneEmulatorError::EpochMismatch);
        }
        if replay.gap.is_some() {
            return Err(PaneEmulatorError::ReplayGap);
        }
        if replay.needs_screen {
            return Err(PaneEmulatorError::ReplayNeedsScreen);
        }
        let mut expected_seq = checkpoint.base_seq;
        for segment in &replay.segments {
            self.validate_pane(&segment.pane_id)?;
            if segment.pane_epoch != checkpoint.pane_epoch {
                return Err(PaneEmulatorError::EpochMismatch);
            }
            if segment.seq_start != expected_seq {
                return Err(PaneEmulatorError::SequenceGap {
                    expected: expected_seq,
                    actual: segment.seq_start,
                });
            }
            if segment.seq_start.checked_add(segment.data.len() as u64) != Some(segment.seq_end) {
                return Err(PaneEmulatorError::InvalidSequenceRange);
            }
            expected_seq = segment.seq_end;
        }
        self.terminal.rebuild(HeadlessTerminalOptions {
            cols: usize::from(checkpoint.cols),
            rows: usize::from(checkpoint.rows),
            scrollback_lines: self.terminal.scrollback_limit(),
        });
        self.pane_epoch = Some(checkpoint.pane_epoch);
        self.terminal_seq = checkpoint.base_seq;
        // Checkpoints contain capture row separators; replay segments remain raw application VT.
        self.terminal
            .feed(&normalize_checkpoint_line_endings(&checkpoint.data));
        for segment in &replay.segments {
            self.feed_segment(segment)?;
        }
        Ok(())
    }

    pub fn begin(&mut self, pane_epoch: WireToken) {
        self.begin_at(pane_epoch, 0);
    }

    pub fn begin_at(&mut self, pane_epoch: WireToken, terminal_seq: u64) {
        if self.pane_epoch == Some(pane_epoch) {
            return;
        }
        self.terminal.reset();
        self.pane_epoch = Some(pane_epoch);
        self.terminal_seq = terminal_seq;
    }

    pub fn feed_segment(&mut self, segment: &PaneDataSegment) -> Result<(), PaneEmulatorError> {
        self.validate_pane(&segment.pane_id)?;
        if self.pane_epoch != Some(segment.pane_epoch) {
            return Err(PaneEmulatorError::EpochMismatch);
        }
        if segment.seq_start != self.terminal_seq {
            return Err(PaneEmulatorError::SequenceGap {
                expected: self.terminal_seq,
                actual: segment.seq_start,
            });
        }
        if segment.seq_start.checked_add(segment.data.len() as u64) != Some(segment.seq_end) {
            return Err(PaneEmulatorError::InvalidSequenceRange);
        }
        self.terminal.feed(&segment.data);
        self.terminal_seq = segment.seq_end;
        Ok(())
    }

    pub fn publish_prompt_marker(&mut self, marker: &PromptMarker) {
        self.terminal.publish_prompt_marker(marker);
    }

    pub fn viewport_text(&self) -> String {
        self.terminal.viewport_text()
    }

    pub fn is_alternate_screen(&self) -> bool {
        self.terminal.is_alternate_screen()
    }

    pub fn size(&self) -> TerminalSize {
        self.terminal.size()
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.terminal.resize(cols, rows);
    }

    pub fn cursor(&self) -> Option<(WireToken, u64)> {
        self.pane_epoch.map(|epoch| (epoch, self.terminal_seq))
    }

    pub fn continuation_state_at(
        &self,
        pane_epoch: WireToken,
        terminal_seq: u64,
    ) -> Option<TerminalContinuationState> {
        (self.pane_epoch == Some(pane_epoch) && self.terminal_seq == terminal_seq)
            .then(|| self.terminal.continuation_state())
    }

    pub fn viewport_ansi_at(
        &self,
        pane_epoch: WireToken,
        terminal_seq: u64,
        cols: usize,
        rows: usize,
        alternate_screen: bool,
    ) -> Option<Vec<u8>> {
        (self.pane_epoch == Some(pane_epoch)
            && self.terminal_seq == terminal_seq
            && self.terminal.size() == TerminalSize { cols, rows }
            && self.terminal.is_alternate_screen() == alternate_screen)
            .then(|| self.terminal.viewport_ansi())
    }

    pub fn reset(&mut self) {
        self.terminal.reset();
        self.pane_epoch = None;
        self.terminal_seq = 0;
    }

    #[must_use]
    pub fn tap<Listener>(&mut self, listener: Listener) -> TerminalTapId
    where
        Listener: for<'a> FnMut(TerminalTap<'a>) + Send + 'static,
    {
        self.terminal.tap(listener)
    }

    pub fn untap(&mut self, id: TerminalTapId) -> bool {
        self.terminal.untap(id)
    }

    fn validate_pane(&self, pane_id: &str) -> Result<(), PaneEmulatorError> {
        if self.pane_id == pane_id {
            Ok(())
        } else {
            Err(PaneEmulatorError::PaneMismatch {
                expected: self.pane_id.clone(),
                actual: pane_id.to_owned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_then_replay_rebuilds_one_terminal_without_hiding_gaps() {
        let epoch = [7; 16];
        let checkpoint = PaneScreenCheckpoint {
            pane_id: "%1".to_owned(),
            pane_epoch: epoch,
            base_seq: 4,
            rows: 24,
            cols: 80,
            modes: 0,
            data: b"\x1b[2J\x1b[Hseed\r\n".to_vec(),
            history_cursor: None,
            captured_at_ms: 0,
        };
        let replay = PaneReplayPlan {
            pane_id: "%1".to_owned(),
            pane_epoch: epoch,
            segments: vec![PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 4,
                seq_end: 9,
                data: b"after".to_vec(),
            }],
            gap: None,
            needs_screen: false,
        };
        let mut emulator = PaneEmulator::new("%1", HeadlessTerminalOptions::default());
        emulator.rebuild(&checkpoint, &replay).unwrap();
        assert!(emulator.viewport_text().contains("seed"));
        assert!(emulator.viewport_text().contains("after"));

        let mut gap = replay;
        gap.gap = Some(super::super::PaneReplayGap {
            pane_id: "%1".to_owned(),
            pane_epoch: epoch,
            reason: super::super::PaneReplayGapReason::CacheEvicted,
            expected_pane_epoch: epoch,
            expected_seq: 0,
            available_seq: 9,
        });
        assert_eq!(
            emulator.rebuild(&checkpoint, &gap),
            Err(PaneEmulatorError::ReplayGap)
        );
    }

    #[test]
    fn checkpoint_capture_lines_rebuild_at_the_left_margin() {
        let epoch = [8; 16];
        let checkpoint = PaneScreenCheckpoint {
            pane_id: "%1".to_owned(),
            pane_epoch: epoch,
            base_seq: 0,
            rows: 4,
            cols: 12,
            modes: 0,
            data: b"\x1b[2J\x1b[Hone\r\ntwo\nthree".to_vec(),
            history_cursor: None,
            captured_at_ms: 0,
        };
        let replay = PaneReplayPlan {
            pane_id: "%1".to_owned(),
            pane_epoch: epoch,
            segments: Vec::new(),
            gap: None,
            needs_screen: false,
        };
        let mut emulator = PaneEmulator::new(
            "%1",
            HeadlessTerminalOptions {
                cols: 12,
                rows: 4,
                scrollback_lines: 0,
            },
        );

        emulator.rebuild(&checkpoint, &replay).unwrap();

        assert_eq!(emulator.viewport_text(), "one\ntwo\nthree");
    }

    #[test]
    fn continuation_state_is_only_exposed_for_the_exact_terminal_identity() {
        let epoch = [3; 16];
        let mut emulator = PaneEmulator::new("%1", HeadlessTerminalOptions::default());
        emulator.begin_at(epoch, 10);
        emulator
            .feed_segment(&PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 10,
                seq_end: 20,
                data: b"\x1b[48;5;16m".to_vec(),
            })
            .unwrap();

        let state = emulator
            .continuation_state_at(epoch, 20)
            .expect("exact identity");
        assert!(state.sgr().as_bytes().starts_with(b"\x1b[0;"));
        assert!(emulator.continuation_state_at(epoch, 19).is_none());
        assert!(emulator.continuation_state_at([4; 16], 20).is_none());
    }

    #[test]
    fn viewport_ansi_is_only_exposed_for_the_exact_frame() {
        let epoch = [5; 16];
        let mut emulator = PaneEmulator::new(
            "%1",
            HeadlessTerminalOptions {
                cols: 20,
                rows: 8,
                scrollback_lines: 0,
            },
        );
        emulator.begin_at(epoch, 10);
        emulator
            .feed_segment(&PaneDataSegment {
                pane_id: "%1".to_owned(),
                pane_epoch: epoch,
                seq_start: 10,
                seq_end: 18,
                data: b"\x1b[?1049h".to_vec(),
            })
            .unwrap();

        assert!(emulator.viewport_ansi_at(epoch, 18, 20, 8, true).is_some());
        assert!(emulator.viewport_ansi_at(epoch, 17, 20, 8, true).is_none());
        assert!(emulator.viewport_ansi_at(epoch, 18, 19, 8, true).is_none());
        assert!(emulator.viewport_ansi_at(epoch, 18, 20, 8, false).is_none());
    }
}
