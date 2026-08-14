use std::error::Error;
use std::fmt;

pub const CONTROL_STREAM_METRICS_INTERVAL_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ControlStreamMetricsSnapshot {
    pub interval_ms: u64,
    pub raw_chunks: u64,
    pub raw_bytes: u64,
    pub control_outputs: u64,
    pub control_output_bytes: u64,
    pub terminal_outputs: u64,
    pub terminal_output_bytes: u64,
    pub titles: u64,
    pub bells: u64,
    pub notifications: u64,
    pub structure_changes: u64,
    pub blocks: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlStreamMetricsError;

impl fmt::Display for ControlStreamMetricsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("control stream metrics interval must be a positive safe integer")
    }
}

impl Error for ControlStreamMetricsError {}

#[derive(Clone, Debug)]
pub struct ControlStreamMetrics {
    interval_ms: u64,
    window_started_at_ms: u64,
    counters: ControlStreamMetricsSnapshot,
}

impl ControlStreamMetrics {
    pub fn new(
        interval_ms: u64,
        window_started_at_ms: u64,
    ) -> Result<Self, ControlStreamMetricsError> {
        if interval_ms == 0 || interval_ms > MAX_SAFE_INTEGER {
            return Err(ControlStreamMetricsError);
        }
        Ok(Self {
            interval_ms,
            window_started_at_ms,
            counters: ControlStreamMetricsSnapshot::default(),
        })
    }

    pub fn with_default_interval(window_started_at_ms: u64) -> Self {
        Self {
            interval_ms: CONTROL_STREAM_METRICS_INTERVAL_MS,
            window_started_at_ms,
            counters: ControlStreamMetricsSnapshot::default(),
        }
    }

    pub fn record_raw_chunk(&mut self, bytes: usize) {
        increment(&mut self.counters.raw_chunks);
        add_bytes(&mut self.counters.raw_bytes, bytes);
    }

    pub fn record_control_output(&mut self, bytes: usize) {
        increment(&mut self.counters.control_outputs);
        add_bytes(&mut self.counters.control_output_bytes, bytes);
    }

    pub fn record_terminal_output(&mut self, bytes: usize) {
        increment(&mut self.counters.terminal_outputs);
        add_bytes(&mut self.counters.terminal_output_bytes, bytes);
    }

    pub fn record_title(&mut self) {
        increment(&mut self.counters.titles);
    }

    pub fn record_bell(&mut self) {
        increment(&mut self.counters.bells);
    }

    pub fn record_notification(&mut self) {
        increment(&mut self.counters.notifications);
    }

    pub fn record_structure_change(&mut self) {
        increment(&mut self.counters.structure_changes);
    }

    pub fn record_block(&mut self) {
        increment(&mut self.counters.blocks);
    }

    pub fn take_if_due(&mut self, now_ms: u64) -> Option<ControlStreamMetricsSnapshot> {
        let elapsed_ms = now_ms.checked_sub(self.window_started_at_ms)?;
        if elapsed_ms < self.interval_ms {
            return None;
        }

        let mut snapshot = std::mem::take(&mut self.counters);
        snapshot.interval_ms = elapsed_ms;
        self.window_started_at_ms = now_ms;
        Some(snapshot)
    }
}

fn increment(value: &mut u64) {
    *value = value.saturating_add(1);
}

fn add_bytes(value: &mut u64, bytes: usize) {
    *value = value.saturating_add(u64::try_from(bytes).unwrap_or(u64::MAX));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_and_resets_one_bounded_window() {
        let mut metrics = ControlStreamMetrics::new(1_000, 10_000).unwrap();
        metrics.record_raw_chunk(100);
        metrics.record_control_output(80);
        metrics.record_terminal_output(20);
        metrics.record_title();
        metrics.record_bell();
        metrics.record_notification();
        metrics.record_structure_change();
        metrics.record_block();

        assert_eq!(metrics.take_if_due(10_999), None);
        assert_eq!(
            metrics.take_if_due(11_000),
            Some(ControlStreamMetricsSnapshot {
                interval_ms: 1_000,
                raw_chunks: 1,
                raw_bytes: 100,
                control_outputs: 1,
                control_output_bytes: 80,
                terminal_outputs: 1,
                terminal_output_bytes: 20,
                titles: 1,
                bells: 1,
                notifications: 1,
                structure_changes: 1,
                blocks: 1,
            })
        );
        assert_eq!(
            metrics.take_if_due(12_000),
            Some(ControlStreamMetricsSnapshot {
                interval_ms: 1_000,
                ..ControlStreamMetricsSnapshot::default()
            })
        );
    }
}
