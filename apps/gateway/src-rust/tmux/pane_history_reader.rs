use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tmex_protocol::WireToken;

use super::PaneHistoryCaptureInfo;

pub const DEFAULT_HISTORY_SESSION_TTL_MS: u64 = 60_000;
pub const DEFAULT_MAX_HISTORY_SESSIONS: usize = 32;
pub const DEFAULT_MAX_HISTORY_PAGE_BYTES: usize = 256 * 1024;
pub const MAX_HISTORY_CAPTURE_LINES: usize = 512;
pub const HISTORY_CAPTURE_OUTPUT_OVERHEAD_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneHistoryCursor {
    pub pane_epoch: WireToken,
    pub history_epoch: WireToken,
    pub before_line: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedPaneHistoryPage {
    pub pane_id: String,
    pub pane_epoch: WireToken,
    pub history_epoch: WireToken,
    pub line_start: u32,
    pub line_end: u32,
    pub truncated: bool,
    pub data: Vec<u8>,
    pub next_cursor: Option<PaneHistoryCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneHistoryCursorErrorReason {
    EpochChanged,
    CacheEvicted,
    ResourceExhausted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneHistoryCursorError {
    pub reason: PaneHistoryCursorErrorReason,
    pub message: String,
}

impl PaneHistoryCursorError {
    pub fn new(reason: PaneHistoryCursorErrorReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl fmt::Display for PaneHistoryCursorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PaneHistoryCursorError {}

#[async_trait]
pub trait PaneHistorySource: Send + Sync {
    async fn get_pane_history_capture_info(
        &self,
        pane_id: &str,
    ) -> Result<PaneHistoryCaptureInfo, PaneHistoryCursorError>;

    async fn capture_pane_history_range(
        &self,
        pane_id: &str,
        start_line: i64,
        end_line: i64,
        max_output_bytes: usize,
    ) -> Result<String, PaneHistoryCursorError>;
}

#[derive(Clone, Debug)]
pub struct PaneHistoryReaderOptions {
    pub session_ttl_ms: u64,
    pub max_sessions: usize,
    pub max_page_bytes: usize,
}

impl Default for PaneHistoryReaderOptions {
    fn default() -> Self {
        Self {
            session_ttl_ms: DEFAULT_HISTORY_SESSION_TTL_MS,
            max_sessions: DEFAULT_MAX_HISTORY_SESSIONS,
            max_page_bytes: DEFAULT_MAX_HISTORY_PAGE_BYTES,
        }
    }
}

#[derive(Clone)]
struct HistorySession {
    pane_id: String,
    pane_epoch: WireToken,
    history_epoch: WireToken,
    before_line: u32,
    anchor_hash: Option<[u8; 32]>,
    expires_at: u64,
    last_used_at: u64,
}

pub struct PaneHistoryReader {
    source: Arc<dyn PaneHistorySource>,
    sessions: HashMap<WireToken, HistorySession>,
    options: PaneHistoryReaderOptions,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    create_epoch: Box<dyn FnMut() -> WireToken + Send>,
}

impl PaneHistoryReader {
    pub fn new(source: Arc<dyn PaneHistorySource>) -> Self {
        Self::with_dependencies(
            source,
            PaneHistoryReaderOptions::default(),
            system_time_ms,
            rand::random,
        )
    }

    pub fn with_dependencies<Now, Epoch>(
        source: Arc<dyn PaneHistorySource>,
        options: PaneHistoryReaderOptions,
        now: Now,
        create_epoch: Epoch,
    ) -> Self
    where
        Now: Fn() -> u64 + Send + Sync + 'static,
        Epoch: FnMut() -> WireToken + Send + 'static,
    {
        Self {
            source,
            sessions: HashMap::new(),
            options,
            now: Arc::new(now),
            create_epoch: Box::new(create_epoch),
        }
    }

    pub fn create_cursor(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        before_line: usize,
    ) -> Option<PaneHistoryCursor> {
        if before_line == 0 {
            return None;
        }
        let now = (self.now)();
        self.sweep(now);
        let history_epoch = (self.create_epoch)();
        let session = HistorySession {
            pane_id: pane_id.to_owned(),
            pane_epoch,
            history_epoch,
            before_line: u32::try_from(before_line).unwrap_or(u32::MAX),
            anchor_hash: None,
            expires_at: now.saturating_add(self.options.session_ttl_ms),
            last_used_at: now,
        };
        self.sessions.insert(history_epoch, session.clone());
        self.enforce_session_limit();
        Some(to_cursor(&session))
    }

    pub async fn read_page(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        cursor: Option<&PaneHistoryCursor>,
        requested_byte_limit: usize,
    ) -> Result<CapturedPaneHistoryPage, PaneHistoryCursorError> {
        let now = (self.now)();
        self.sweep(now);
        let byte_limit = requested_byte_limit.clamp(1, self.options.max_page_bytes);
        let info = self.source.get_pane_history_capture_info(pane_id).await?;
        let history_size = u32::try_from(info.history_size).unwrap_or(u32::MAX);
        let history_epoch = if let Some(cursor) = cursor {
            self.resolve_cursor(pane_id, pane_epoch, cursor)?
                .history_epoch
        } else {
            let Some(cursor) = self.create_cursor(pane_id, pane_epoch, info.history_size) else {
                return Ok(empty_page(pane_id, pane_epoch, [0; 16]));
            };
            cursor.history_epoch
        };

        let (before_line, anchor_hash) = {
            let session = self
                .sessions
                .get(&history_epoch)
                .ok_or_else(|| cache_evicted("history cursor expired"))?;
            (session.before_line, session.anchor_hash)
        };
        if before_line > history_size {
            self.sessions.remove(&history_epoch);
            return Err(cache_evicted("tmux history moved past this cursor"));
        }
        if before_line == 0 {
            return Ok(empty_page(pane_id, pane_epoch, history_epoch));
        }

        let estimated_bytes_per_line = info.cols.max(1).saturating_mul(4).max(16);
        let line_count =
            (byte_limit / estimated_bytes_per_line).clamp(1, MAX_HISTORY_CAPTURE_LINES) as u32;
        let requested_start = before_line.saturating_sub(line_count);
        let includes_anchor = anchor_hash.is_some() && before_line < history_size;
        let capture_end = if includes_anchor {
            before_line
        } else {
            before_line - 1
        };
        let start_coordinate = i64::from(requested_start) - i64::from(history_size);
        let end_coordinate = i64::from(capture_end) - i64::from(history_size);
        let capture_limit = self
            .options
            .max_page_bytes
            .saturating_mul(2)
            .saturating_add(HISTORY_CAPTURE_OUTPUT_OVERHEAD_BYTES)
            .min(
                byte_limit
                    .saturating_mul(2)
                    .saturating_add(HISTORY_CAPTURE_OUTPUT_OVERHEAD_BYTES),
            );
        let captured = self
            .source
            .capture_pane_history_range(pane_id, start_coordinate, end_coordinate, capture_limit)
            .await?;
        let mut rows = split_captured_rows(&captured);
        let expected_rows = (capture_end - requested_start + 1) as usize;
        if rows.len() != expected_rows {
            return Err(cache_evicted(format!(
                "tmux history range changed while reading: expected {expected_rows} rows, got {}",
                rows.len()
            )));
        }
        if includes_anchor {
            let boundary = rows
                .pop()
                .ok_or_else(|| cache_evicted("tmux history boundary changed"))?;
            if Some(hash_row(boundary)) != anchor_hash {
                self.sessions.remove(&history_epoch);
                return Err(cache_evicted("tmux history boundary changed"));
            }
        }

        let mut selected = Vec::new();
        let mut selected_bytes: usize = 0;
        let mut selected_rows = 0_u32;
        let mut truncated = false;
        for row in rows.iter().rev() {
            let mut encoded = row.as_bytes().to_vec();
            encoded.push(b'\n');
            if selected_bytes.saturating_add(encoded.len()) <= byte_limit {
                selected.push(encoded);
                selected_bytes += selected.last().map_or(0, Vec::len);
                selected_rows += 1;
                continue;
            }
            if selected_rows == 0 {
                let tail = truncate_utf8_tail(&encoded, byte_limit);
                selected.push(tail);
                selected_rows = 1;
                truncated = true;
            }
            break;
        }
        if selected_rows == 0 {
            return Err(PaneHistoryCursorError::new(
                PaneHistoryCursorErrorReason::ResourceExhausted,
                "history page made no progress",
            ));
        }
        selected.reverse();
        let line_start = before_line - selected_rows;
        let first_selected = rows
            .get(rows.len().saturating_sub(selected_rows as usize))
            .ok_or_else(|| cache_evicted("history page boundary disappeared"))?;
        let session = self
            .sessions
            .get_mut(&history_epoch)
            .ok_or_else(|| cache_evicted("history cursor expired"))?;
        session.before_line = line_start;
        session.anchor_hash = Some(hash_row(first_selected));
        session.expires_at = now.saturating_add(self.options.session_ttl_ms);
        session.last_used_at = now;
        let next_cursor = (line_start > 0).then(|| to_cursor(session));
        Ok(CapturedPaneHistoryPage {
            pane_id: pane_id.to_owned(),
            pane_epoch,
            history_epoch,
            line_start,
            line_end: before_line,
            truncated,
            data: selected.into_iter().flatten().collect(),
            next_cursor,
        })
    }

    pub fn invalidate_pane(&mut self, pane_id: &str, pane_epoch: Option<WireToken>) {
        self.sessions.retain(|_, session| {
            session.pane_id != pane_id
                || pane_epoch.is_some_and(|epoch| session.pane_epoch == epoch)
        });
    }

    pub fn dispose(&mut self) {
        self.sessions.clear();
    }

    fn resolve_cursor(
        &self,
        pane_id: &str,
        pane_epoch: WireToken,
        cursor: &PaneHistoryCursor,
    ) -> Result<&HistorySession, PaneHistoryCursorError> {
        let session = self
            .sessions
            .get(&cursor.history_epoch)
            .ok_or_else(|| cache_evicted("history cursor expired"))?;
        if session.pane_id != pane_id
            || session.pane_epoch != pane_epoch
            || cursor.pane_epoch != pane_epoch
        {
            return Err(PaneHistoryCursorError::new(
                PaneHistoryCursorErrorReason::EpochChanged,
                "history cursor pane epoch changed",
            ));
        }
        if cursor.before_line != session.before_line {
            return Err(cache_evicted("history cursor is stale or out of order"));
        }
        Ok(session)
    }

    fn sweep(&mut self, now: u64) {
        self.sessions.retain(|_, session| session.expires_at > now);
    }

    fn enforce_session_limit(&mut self) {
        while self.sessions.len() > self.options.max_sessions {
            let oldest = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_used_at)
                .map(|(epoch, _)| *epoch);
            let Some(oldest) = oldest else {
                break;
            };
            self.sessions.remove(&oldest);
        }
    }
}

fn empty_page(
    pane_id: &str,
    pane_epoch: WireToken,
    history_epoch: WireToken,
) -> CapturedPaneHistoryPage {
    CapturedPaneHistoryPage {
        pane_id: pane_id.to_owned(),
        pane_epoch,
        history_epoch,
        line_start: 0,
        line_end: 0,
        truncated: false,
        data: Vec::new(),
        next_cursor: None,
    }
}

fn to_cursor(session: &HistorySession) -> PaneHistoryCursor {
    PaneHistoryCursor {
        pane_epoch: session.pane_epoch,
        history_epoch: session.history_epoch,
        before_line: session.before_line,
    }
}

fn split_captured_rows(value: &str) -> Vec<&str> {
    if value.is_empty() {
        return Vec::new();
    }
    value
        .strip_suffix('\n')
        .unwrap_or(value)
        .split('\n')
        .collect()
}

fn hash_row(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn truncate_utf8_tail(value: &[u8], byte_limit: usize) -> Vec<u8> {
    let mut start = value.len().saturating_sub(byte_limit);
    while start < value.len() && (0x80..0xc0).contains(&value[start]) {
        start += 1;
    }
    value[start..].to_vec()
}

fn cache_evicted(message: impl Into<String>) -> PaneHistoryCursorError {
    PaneHistoryCursorError::new(PaneHistoryCursorErrorReason::CacheEvicted, message)
}

fn system_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Source {
        rows: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl PaneHistorySource for Source {
        async fn get_pane_history_capture_info(
            &self,
            _pane_id: &str,
        ) -> Result<PaneHistoryCaptureInfo, PaneHistoryCursorError> {
            Ok(PaneHistoryCaptureInfo {
                history_size: self.rows.lock().unwrap().len(),
                cols: 8,
            })
        }

        async fn capture_pane_history_range(
            &self,
            _pane_id: &str,
            start_line: i64,
            end_line: i64,
            _max_output_bytes: usize,
        ) -> Result<String, PaneHistoryCursorError> {
            let rows = self.rows.lock().unwrap();
            let base = rows.len() as i64;
            let start = usize::try_from(base + start_line).unwrap();
            let end = usize::try_from(base + end_line).unwrap();
            Ok(format!("{}\n", rows[start..=end].join("\n")))
        }
    }

    #[tokio::test]
    async fn cursor_anchor_fails_closed_when_tmux_history_moves() {
        let rows = Arc::new(Mutex::new(vec![
            "one".to_owned(),
            "two".to_owned(),
            "three".to_owned(),
            "four".to_owned(),
        ]));
        let now = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let now_for_reader = now.clone();
        let mut reader = PaneHistoryReader::with_dependencies(
            Arc::new(Source { rows: rows.clone() }),
            PaneHistoryReaderOptions {
                max_page_bytes: 8,
                ..PaneHistoryReaderOptions::default()
            },
            move || now_for_reader.load(std::sync::atomic::Ordering::Relaxed),
            || [9; 16],
        );
        let first = reader.read_page("%1", [1; 16], None, 8).await.unwrap();
        let cursor = first.next_cursor.unwrap();
        rows.lock().unwrap()[cursor.before_line as usize] = "shifted".to_owned();
        let error = reader
            .read_page("%1", [1; 16], Some(&cursor), 8)
            .await
            .unwrap_err();
        assert_eq!(error.reason, PaneHistoryCursorErrorReason::CacheEvicted);
    }
}
