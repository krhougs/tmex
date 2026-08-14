pub const GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS: u64 = 16;
pub const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
pub const GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalOutputBatcherConfig {
    pub delay_ms: u64,
    pub max_bytes: usize,
    pub total_max_bytes: usize,
}

impl Default for TerminalOutputBatcherConfig {
    fn default() -> Self {
        Self {
            delay_ms: GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
            max_bytes: GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
            total_max_bytes: GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalOutputBatch {
    pub device_id: String,
    pub pane_id: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalOutputBatcherStats {
    pub pending_panes: usize,
    pub pending_bytes: usize,
    pub pending_bytes_limit: usize,
    pub per_pane_bytes_limit: usize,
    pub deadline_ms: u64,
}

#[derive(Debug)]
struct PendingBatch {
    device_id: String,
    pane_id: String,
    data: Vec<u8>,
    deadline_ms: u64,
}

#[derive(Debug, Default)]
pub struct TerminalOutputBatcher {
    config: TerminalOutputBatcherConfig,
    pending: Vec<PendingBatch>,
    device_order: Vec<String>,
    pending_bytes: usize,
}

impl TerminalOutputBatcher {
    pub fn new(config: TerminalOutputBatcherConfig) -> Result<Self, &'static str> {
        if config.delay_ms == 0 {
            return Err("terminal output batch delay must be positive");
        }
        if config.max_bytes == 0 {
            return Err("terminal output batch limit must be positive");
        }
        if config.total_max_bytes < config.max_bytes {
            return Err("terminal output total batch limit must cover one pane batch");
        }
        Ok(Self {
            config,
            pending: Vec::new(),
            device_order: Vec::new(),
            pending_bytes: 0,
        })
    }

    pub fn push(
        &mut self,
        device_id: &str,
        pane_id: &str,
        data: &[u8],
        now_ms: u64,
    ) -> Vec<TerminalOutputBatch> {
        let mut emitted = Vec::new();
        let mut offset = 0;
        while offset < data.len() {
            if self.pending_bytes >= self.config.total_max_bytes {
                if let Some(batch) = self.flush_oldest() {
                    emitted.push(batch);
                    continue;
                }
                self.pending_bytes = self.pending.iter().map(|batch| batch.data.len()).sum();
                self.device_order = self
                    .pending
                    .iter()
                    .map(|batch| batch.device_id.clone())
                    .fold(Vec::new(), |mut order, device_id| {
                        if !order.contains(&device_id) {
                            order.push(device_id);
                        }
                        order
                    });
                continue;
            }
            let index = self
                .pending
                .iter()
                .position(|batch| batch.device_id == device_id && batch.pane_id == pane_id)
                .unwrap_or_else(|| {
                    if !self
                        .pending
                        .iter()
                        .any(|batch| batch.device_id == device_id)
                    {
                        self.device_order.push(device_id.to_owned());
                    }
                    self.pending.push(PendingBatch {
                        device_id: device_id.to_owned(),
                        pane_id: pane_id.to_owned(),
                        data: Vec::with_capacity(self.config.max_bytes.min(1_024)),
                        deadline_ms: now_ms.saturating_add(self.config.delay_ms),
                    });
                    self.pending.len() - 1
                });
            let count = (self.config.max_bytes - self.pending[index].data.len())
                .min(self.config.total_max_bytes - self.pending_bytes)
                .min(data.len() - offset);
            self.pending[index]
                .data
                .extend_from_slice(&data[offset..offset + count]);
            self.pending_bytes += count;
            offset += count;
            if self.pending[index].data.len() == self.config.max_bytes {
                if let Some(batch) = self.flush_index(index) {
                    emitted.push(batch);
                }
            }
        }
        emitted
    }

    pub fn poll(&mut self, now_ms: u64) -> Vec<TerminalOutputBatch> {
        let mut emitted = Vec::new();
        let mut index = 0;
        while index < self.pending.len() {
            if now_ms >= self.pending[index].deadline_ms {
                if let Some(batch) = self.flush_index(index) {
                    emitted.push(batch);
                }
            } else {
                index += 1;
            }
        }
        emitted
    }

    pub fn flush_device(&mut self, device_id: &str) -> Vec<TerminalOutputBatch> {
        let mut emitted = Vec::new();
        let mut index = 0;
        while index < self.pending.len() {
            if self.pending[index].device_id == device_id {
                if let Some(batch) = self.flush_index(index) {
                    emitted.push(batch);
                }
            } else {
                index += 1;
            }
        }
        emitted
    }

    pub fn discard_device(&mut self, device_id: &str) {
        let mut index = 0;
        while index < self.pending.len() {
            if self.pending[index].device_id == device_id {
                let batch = self.pending.remove(index);
                self.pending_bytes -= batch.data.len();
            } else {
                index += 1;
            }
        }
        self.device_order.retain(|candidate| candidate != device_id);
    }

    pub fn snapshot_stats(&self) -> TerminalOutputBatcherStats {
        TerminalOutputBatcherStats {
            pending_panes: self.pending.len(),
            pending_bytes: self.pending_bytes,
            pending_bytes_limit: self.config.total_max_bytes,
            per_pane_bytes_limit: self.config.max_bytes,
            deadline_ms: self.config.delay_ms,
        }
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.pending.iter().map(|batch| batch.deadline_ms).min()
    }

    fn flush_index(&mut self, index: usize) -> Option<TerminalOutputBatch> {
        if index >= self.pending.len() {
            return None;
        }
        let batch = self.pending.remove(index);
        self.pending_bytes -= batch.data.len();
        if !self
            .pending
            .iter()
            .any(|pending| pending.device_id == batch.device_id)
        {
            self.device_order
                .retain(|device_id| device_id != &batch.device_id);
        }
        if batch.data.is_empty() {
            return None;
        }
        Some(TerminalOutputBatch {
            device_id: batch.device_id,
            pane_id: batch.pane_id,
            data: batch.data,
        })
    }

    fn flush_oldest(&mut self) -> Option<TerminalOutputBatch> {
        while let Some(device_id) = self.device_order.first().cloned() {
            if let Some(index) = self
                .pending
                .iter()
                .position(|batch| batch.device_id == device_id)
            {
                return self.flush_index(index);
            }
            self.device_order.remove(0);
        }
        self.flush_index(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_until_deadline_and_preserves_first_seen_order() {
        let mut batcher = TerminalOutputBatcher::default();
        assert!(batcher.push("device", "%2", &[1, 2], 10).is_empty());
        assert!(batcher.push("device", "%1", &[3], 20).is_empty());
        assert!(batcher.push("device", "%2", &[4], 25).is_empty());
        assert!(batcher.poll(25).is_empty());

        assert_eq!(
            batcher.poll(26),
            vec![TerminalOutputBatch {
                device_id: "device".into(),
                pane_id: "%2".into(),
                data: vec![1, 2, 4],
            }]
        );
        assert_eq!(batcher.flush_device("device")[0].pane_id, "%1");
    }

    #[test]
    fn pane_and_aggregate_limits_flush_without_losing_sequence() {
        let mut batcher = TerminalOutputBatcher::new(TerminalOutputBatcherConfig {
            delay_ms: 16,
            max_bytes: 5,
            total_max_bytes: 6,
        })
        .expect("valid config");
        assert!(batcher.push("device", "%1", &[1, 2, 3, 4], 0).is_empty());
        let emitted = batcher.push("device", "%2", &[5, 6, 7], 0);
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].pane_id, "%1");
        assert_eq!(emitted[0].data, vec![1, 2, 3, 4]);
        assert_eq!(batcher.snapshot_stats().pending_bytes, 3);

        let full = batcher.push("device", "%2", &[8, 9], 0);
        assert_eq!(full[0].data, vec![5, 6, 7, 8, 9]);
    }
}
