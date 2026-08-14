use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::{AtomicU32, Ordering},
};

use tmex_protocol::{Chunk, ProtocolErrorCode};

use super::{SessionProtocolError, ENVELOPE_OVERHEAD_BYTES};

pub const CHUNK_TIMEOUT_MS: u64 = 5_000;
pub const MAX_CHUNK_STREAMS: usize = 100;
pub const MAX_CHUNKS_PER_MESSAGE: u16 = 1_000;
pub const MAX_CHUNK_STREAM_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CHUNK_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
pub const CHUNK_PAYLOAD_OVERHEAD_BYTES: usize = 18;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReassembledMessage {
    pub kind: u16,
    pub seq: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
struct ChunkStream {
    chunks: BTreeMap<u16, Vec<u8>>,
    total_chunks: u16,
    last_progress_at_ms: u64,
    original_kind: u16,
    original_seq: u32,
    buffered_bytes: usize,
}

#[derive(Debug)]
pub struct ChunkReassembler {
    streams: HashMap<u32, ChunkStream>,
    timeout_ms: u64,
    max_streams: usize,
    max_chunks_per_message: u16,
    max_stream_bytes: usize,
    max_buffered_bytes: usize,
    buffered_bytes: usize,
}

impl Default for ChunkReassembler {
    fn default() -> Self {
        Self::new(CHUNK_TIMEOUT_MS)
    }
}

impl ChunkReassembler {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            streams: HashMap::new(),
            timeout_ms,
            max_streams: MAX_CHUNK_STREAMS,
            max_chunks_per_message: MAX_CHUNKS_PER_MESSAGE,
            max_stream_bytes: MAX_CHUNK_STREAM_BYTES,
            max_buffered_bytes: MAX_CHUNK_BUFFERED_BYTES,
            buffered_bytes: 0,
        }
    }

    pub fn with_limits(timeout_ms: u64, max_streams: usize, max_chunks_per_message: u16) -> Self {
        Self {
            streams: HashMap::new(),
            timeout_ms,
            max_streams,
            max_chunks_per_message,
            max_stream_bytes: MAX_CHUNK_STREAM_BYTES,
            max_buffered_bytes: MAX_CHUNK_BUFFERED_BYTES,
            buffered_bytes: 0,
        }
    }

    #[cfg(test)]
    fn with_resource_limits(
        timeout_ms: u64,
        max_streams: usize,
        max_chunks_per_message: u16,
        max_stream_bytes: usize,
        max_buffered_bytes: usize,
    ) -> Self {
        Self {
            streams: HashMap::new(),
            timeout_ms,
            max_streams,
            max_chunks_per_message,
            max_stream_bytes,
            max_buffered_bytes,
            buffered_bytes: 0,
        }
    }

    pub fn add_chunk(
        &mut self,
        chunk: Chunk,
        now_ms: u64,
    ) -> Result<Option<ReassembledMessage>, SessionProtocolError> {
        self.cleanup(now_ms);

        if chunk.total_chunks > self.max_chunks_per_message {
            return Err(SessionProtocolError::invalid_frame(format!(
                "Too many chunks: {} > {}",
                chunk.total_chunks, self.max_chunks_per_message
            )));
        }
        if chunk.chunk_index >= chunk.total_chunks {
            return Err(SessionProtocolError::invalid_frame(format!(
                "Chunk index out of bounds: {} >= {}",
                chunk.chunk_index, chunk.total_chunks
            )));
        }

        if !self.streams.contains_key(&chunk.chunk_stream_id) {
            if self.streams.len() >= self.max_streams {
                self.cleanup(now_ms);
                if self.streams.len() >= self.max_streams {
                    return Err(SessionProtocolError::invalid_frame(
                        "Too many concurrent chunk streams",
                    ));
                }
            }

            self.streams.insert(
                chunk.chunk_stream_id,
                ChunkStream {
                    chunks: BTreeMap::new(),
                    total_chunks: chunk.total_chunks,
                    last_progress_at_ms: now_ms,
                    original_kind: chunk.original_kind,
                    original_seq: chunk.original_seq,
                    buffered_bytes: 0,
                },
            );
        }

        let Some(stream) = self.streams.get(&chunk.chunk_stream_id) else {
            return Err(SessionProtocolError::invalid_frame(
                "Chunk stream state unavailable",
            ));
        };
        if stream.total_chunks != chunk.total_chunks
            || stream.original_kind != chunk.original_kind
            || stream.original_seq != chunk.original_seq
        {
            self.remove_stream(chunk.chunk_stream_id);
            return Err(SessionProtocolError::invalid_frame(
                "Chunk stream metadata mismatch",
            ));
        }
        if stream.chunks.contains_key(&chunk.chunk_index) {
            return Err(SessionProtocolError::invalid_frame(format!(
                "Duplicate chunk index: {}",
                chunk.chunk_index
            )));
        }

        let stream_bytes = stream
            .buffered_bytes
            .checked_add(chunk.data.len())
            .ok_or_else(|| SessionProtocolError::invalid_frame("Chunk payload length overflow"))?;
        let buffered_bytes = self
            .buffered_bytes
            .checked_add(chunk.data.len())
            .ok_or_else(|| SessionProtocolError::invalid_frame("Chunk payload length overflow"))?;
        if stream_bytes > self.max_stream_bytes || buffered_bytes > self.max_buffered_bytes {
            self.remove_stream(chunk.chunk_stream_id);
            return Err(SessionProtocolError::new(
                ProtocolErrorCode::FrameTooLarge,
                "Chunk reassembly byte limit exceeded",
                false,
            ));
        }

        let Some(stream) = self.streams.get_mut(&chunk.chunk_stream_id) else {
            return Err(SessionProtocolError::invalid_frame(
                "Chunk stream state unavailable",
            ));
        };
        stream.buffered_bytes = stream_bytes;
        self.buffered_bytes = buffered_bytes;
        stream.chunks.insert(chunk.chunk_index, chunk.data);
        stream.last_progress_at_ms = now_ms;

        if stream.chunks.len() != usize::from(stream.total_chunks) {
            return Ok(None);
        }

        let Some(stream) = self.streams.remove(&chunk.chunk_stream_id) else {
            return Err(SessionProtocolError::invalid_frame(
                "Complete chunk stream state unavailable",
            ));
        };
        self.buffered_bytes = self.buffered_bytes.saturating_sub(stream.buffered_bytes);
        let mut payload = Vec::with_capacity(stream.buffered_bytes);
        for index in 0..stream.total_chunks {
            let data = stream.chunks.get(&index).ok_or_else(|| {
                SessionProtocolError::invalid_frame(format!("Missing chunk index: {index}"))
            })?;
            payload.extend_from_slice(data);
        }

        Ok(Some(ReassembledMessage {
            kind: stream.original_kind,
            seq: stream.original_seq,
            payload,
        }))
    }

    pub fn cleanup(&mut self, now_ms: u64) -> usize {
        let before = self.streams.len();
        let timeout_ms = self.timeout_ms;
        self.streams.retain(|_, stream| {
            now_ms
                .checked_sub(stream.last_progress_at_ms)
                .is_none_or(|elapsed| elapsed < timeout_ms)
        });
        self.buffered_bytes = self
            .streams
            .values()
            .map(|stream| stream.buffered_bytes)
            .fold(0usize, usize::saturating_add);
        before - self.streams.len()
    }

    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.streams
            .values()
            .map(|stream| stream.last_progress_at_ms.saturating_add(self.timeout_ms))
            .min()
    }

    pub fn active_stream_count(&self) -> usize {
        self.streams.len()
    }

    pub fn clear(&mut self) {
        self.streams.clear();
        self.buffered_bytes = 0;
    }

    fn remove_stream(&mut self, stream_id: u32) {
        if let Some(stream) = self.streams.remove(&stream_id) {
            self.buffered_bytes = self.buffered_bytes.saturating_sub(stream.buffered_bytes);
        }
    }
}

pub fn split_payload_into_chunks(
    payload: &[u8],
    kind: u16,
    seq: u32,
    max_frame_bytes: usize,
    chunk_stream_id: u32,
) -> Result<Vec<Chunk>, SessionProtocolError> {
    let max_unchunked_payload = max_frame_bytes
        .checked_sub(ENVELOPE_OVERHEAD_BYTES)
        .filter(|maximum| *maximum > 0)
        .ok_or_else(|| {
            SessionProtocolError::new(
                ProtocolErrorCode::FrameTooLarge,
                format!("maxFrameBytes too small: {max_frame_bytes}"),
                false,
            )
        })?;

    if payload.len() <= max_unchunked_payload {
        return Ok(Vec::new());
    }

    let max_chunk_data_size = max_frame_bytes
        .checked_sub(ENVELOPE_OVERHEAD_BYTES + CHUNK_PAYLOAD_OVERHEAD_BYTES)
        .filter(|maximum| *maximum > 0)
        .ok_or_else(|| {
            SessionProtocolError::new(
                ProtocolErrorCode::FrameTooLarge,
                format!("maxFrameBytes too small for chunking: {max_frame_bytes}"),
                false,
            )
        })?;
    let total_chunks = payload.len().div_ceil(max_chunk_data_size);
    if total_chunks > usize::from(MAX_CHUNKS_PER_MESSAGE) {
        return Err(SessionProtocolError::new(
            ProtocolErrorCode::FrameTooLarge,
            format!("Too many chunks: {total_chunks}"),
            false,
        ));
    }
    let total_chunks = u16::try_from(total_chunks).map_err(|_| {
        SessionProtocolError::new(
            ProtocolErrorCode::FrameTooLarge,
            "Chunk count does not fit the wire format",
            false,
        )
    })?;

    payload
        .chunks(max_chunk_data_size)
        .enumerate()
        .map(|(index, data)| {
            let chunk_index = u16::try_from(index).map_err(|_| {
                SessionProtocolError::new(
                    ProtocolErrorCode::FrameTooLarge,
                    "Chunk index does not fit the wire format",
                    false,
                )
            })?;
            Ok(Chunk {
                chunk_stream_id,
                original_kind: kind,
                original_seq: seq,
                total_chunks,
                chunk_index,
                data: data.to_vec(),
            })
        })
        .collect()
}

static NEXT_CHUNK_STREAM_ID: AtomicU32 = AtomicU32::new(1);

pub fn next_chunk_stream_id() -> u32 {
    NEXT_CHUNK_STREAM_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            Some(if current == u32::MAX { 1 } else { current + 1 })
        })
        .unwrap_or_else(|current| current)
}

#[cfg(test)]
mod tests {
    use tmex_protocol::MessageKind;

    use super::*;

    fn chunk(stream: u32, index: u16, total: u16, data: &[u8]) -> Chunk {
        Chunk {
            chunk_stream_id: stream,
            original_kind: MessageKind::Ping as u16,
            original_seq: 9,
            total_chunks: total,
            chunk_index: index,
            data: data.to_vec(),
        }
    }

    #[test]
    fn reassembles_out_of_order_chunks_and_rejects_duplicates() {
        let mut reassembler = ChunkReassembler::default();
        assert_eq!(reassembler.add_chunk(chunk(1, 1, 2, &[3, 4]), 0), Ok(None));
        assert_eq!(
            reassembler.add_chunk(chunk(1, 0, 2, &[1, 2]), 1),
            Ok(Some(ReassembledMessage {
                kind: MessageKind::Ping as u16,
                seq: 9,
                payload: vec![1, 2, 3, 4],
            }))
        );

        assert_eq!(reassembler.add_chunk(chunk(2, 0, 2, &[1]), 2), Ok(None));
        assert_eq!(
            reassembler
                .add_chunk(chunk(2, 0, 2, &[1]), 3)
                .expect_err("duplicate chunk")
                .code,
            ProtocolErrorCode::InvalidFrame
        );
    }

    #[test]
    fn chunk_progress_refreshes_the_inactivity_deadline() {
        let mut reassembler = ChunkReassembler::new(100);
        assert_eq!(reassembler.add_chunk(chunk(7, 0, 3, &[0]), 0), Ok(None));
        assert_eq!(reassembler.add_chunk(chunk(7, 1, 3, &[1]), 90), Ok(None));
        assert_eq!(
            reassembler.add_chunk(chunk(7, 2, 3, &[2]), 180),
            Ok(Some(ReassembledMessage {
                kind: MessageKind::Ping as u16,
                seq: 9,
                payload: vec![0, 1, 2],
            }))
        );

        assert_eq!(reassembler.add_chunk(chunk(8, 0, 2, &[0]), 200), Ok(None));
        assert_eq!(reassembler.cleanup(299), 0);
        assert_eq!(reassembler.cleanup(300), 1);
    }

    #[test]
    fn enforces_stream_chunk_and_index_limits() {
        let mut reassembler = ChunkReassembler::with_limits(5_000, 1, 2);
        assert_eq!(reassembler.add_chunk(chunk(1, 0, 2, &[0]), 0), Ok(None));
        assert!(reassembler.add_chunk(chunk(2, 0, 2, &[0]), 0).is_err());
        assert!(reassembler.add_chunk(chunk(3, 0, 3, &[0]), 0).is_err());
        assert!(reassembler.add_chunk(chunk(3, 2, 2, &[0]), 0).is_err());
    }

    #[test]
    fn bounds_reassembly_bytes_and_discards_mismatched_streams() {
        let mut reassembler = ChunkReassembler::with_resource_limits(100, 2, 4, 3, 5);
        assert_eq!(reassembler.add_chunk(chunk(1, 0, 2, &[1, 2]), 10), Ok(None));
        assert_eq!(reassembler.next_deadline_ms(), Some(110));
        let error = reassembler
            .add_chunk(chunk(1, 1, 2, &[3, 4]), 20)
            .expect_err("stream byte limit");
        assert_eq!(error.code, ProtocolErrorCode::FrameTooLarge);
        assert_eq!(reassembler.active_stream_count(), 0);

        assert_eq!(reassembler.add_chunk(chunk(2, 0, 2, &[1, 2]), 30), Ok(None));
        let mut mismatched = chunk(2, 1, 2, &[3]);
        mismatched.original_seq = 10;
        let error = reassembler
            .add_chunk(mismatched, 31)
            .expect_err("stream metadata mismatch");
        assert_eq!(error.code, ProtocolErrorCode::InvalidFrame);
        assert_eq!(reassembler.active_stream_count(), 0);

        assert_eq!(
            reassembler.add_chunk(chunk(3, 0, 2, &[1, 2, 3]), 40),
            Ok(None)
        );
        assert_eq!(reassembler.add_chunk(chunk(4, 0, 2, &[4, 5]), 40), Ok(None));
        let error = reassembler
            .add_chunk(chunk(4, 1, 2, &[6]), 41)
            .expect_err("session byte limit");
        assert_eq!(error.code, ProtocolErrorCode::FrameTooLarge);
        assert_eq!(reassembler.active_stream_count(), 1);
        assert_eq!(reassembler.cleanup(140), 1);
        assert_eq!(reassembler.next_deadline_ms(), None);
    }

    #[test]
    fn splitter_accounts_for_both_borsh_length_prefixes() {
        let max_frame_bytes = 64;
        let payload = vec![0xab; 200];
        let chunks =
            split_payload_into_chunks(&payload, MessageKind::Ping as u16, 11, max_frame_bytes, 4)
                .expect("split payload");

        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.data.len()
            + ENVELOPE_OVERHEAD_BYTES
            + CHUNK_PAYLOAD_OVERHEAD_BYTES
            <= max_frame_bytes));
        assert_eq!(
            chunks
                .iter()
                .flat_map(|chunk| chunk.data.iter().copied())
                .collect::<Vec<_>>(),
            payload
        );
    }
}
