use tmex_protocol::{
    decode_payload, encode_payload, Chunk, Envelope, ErrorPayload, HelloC2s, HelloS2c, MessageKind,
    PingPong, ProtocolErrorCode, CURRENT_VERSION, DEFAULT_MAX_FRAME_BYTES,
};

use super::{
    decode_frame, encoded_envelope_len, next_chunk_stream_id, split_payload_into_chunks,
    validate_envelope, ChunkReassembler, SessionProtocolError,
};

pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u32 = 15_000;
pub const TERMINAL_SEMANTIC_KEY_V1: &str = "terminal.semantic-key.v1";
pub const DEFAULT_CAPABILITIES: [&str; 5] = [
    "tmex-ws-borsh-v1",
    "tmex-agent-v1",
    "tmex-split-v1",
    "canonical-state-v1",
    TERMINAL_SEMANTIC_KEY_V1,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionConfig {
    pub server_impl: String,
    pub server_version: String,
    pub server_max_frame_bytes: u32,
    pub heartbeat_interval_ms: u32,
    pub capabilities: Vec<String>,
    pub chunk_timeout_ms: u64,
}

impl SessionConfig {
    pub fn new(server_version: impl Into<String>) -> Self {
        Self {
            server_impl: "tmex-gateway".into(),
            server_version: server_version.into(),
            server_max_frame_bytes: DEFAULT_MAX_FRAME_BYTES.min(u32::MAX as usize) as u32,
            heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
            capabilities: DEFAULT_CAPABILITIES
                .into_iter()
                .map(str::to_owned)
                .collect(),
            chunk_timeout_ms: super::CHUNK_TIMEOUT_MS,
        }
    }
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self::new("unknown")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPhase {
    AwaitingHello,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NegotiatedClient {
    pub client_impl: String,
    pub client_version: String,
    pub client_max_frame_bytes: u32,
    pub effective_max_frame_bytes: u32,
    pub supports_compression: bool,
    pub supports_diff_snapshot: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionAction {
    Negotiated(NegotiatedClient),
    SendBatch(Vec<Envelope>),
    Inbound(Envelope),
}

#[derive(Debug)]
pub struct LegacyBorshSession {
    config: SessionConfig,
    phase: SessionPhase,
    negotiated: Option<NegotiatedClient>,
    next_outbound_seq: u32,
    chunks: ChunkReassembler,
    opened_at_ms: u64,
    last_activity_at_ms: u64,
}

impl LegacyBorshSession {
    pub fn new(config: SessionConfig, now_ms: u64) -> Self {
        let chunk_timeout_ms = config.chunk_timeout_ms;
        Self {
            config,
            phase: SessionPhase::AwaitingHello,
            negotiated: None,
            next_outbound_seq: 1,
            chunks: ChunkReassembler::new(chunk_timeout_ms),
            opened_at_ms: now_ms,
            last_activity_at_ms: now_ms,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.phase
    }

    pub fn negotiated_client(&self) -> Option<&NegotiatedClient> {
        self.negotiated.as_ref()
    }

    pub fn opened_at_ms(&self) -> u64 {
        self.opened_at_ms
    }

    pub fn last_activity_at_ms(&self) -> u64 {
        self.last_activity_at_ms
    }

    pub fn inbound_max_frame_bytes(&self) -> usize {
        self.config.server_max_frame_bytes as usize
    }

    pub fn outbound_max_frame_bytes(&self) -> usize {
        self.negotiated
            .as_ref()
            .map_or(self.config.server_max_frame_bytes, |client| {
                client.effective_max_frame_bytes
            }) as usize
    }

    pub fn active_chunk_stream_count(&self) -> usize {
        self.chunks.active_stream_count()
    }

    pub fn cleanup_chunks(&mut self, now_ms: u64) -> usize {
        self.chunks.cleanup(now_ms)
    }

    pub fn next_chunk_deadline_ms(&self) -> Option<u64> {
        self.chunks.next_deadline_ms()
    }

    pub fn receive_frame(&mut self, frame: &[u8], now_ms: u64) -> Vec<SessionAction> {
        match decode_frame(frame, self.inbound_max_frame_bytes()) {
            Ok(envelope) => self.process_envelope(envelope, now_ms, true),
            Err(error) => self.error_actions(None, error),
        }
    }

    pub fn receive_envelope(&mut self, envelope: Envelope, now_ms: u64) -> Vec<SessionAction> {
        if let Err(error) = validate_envelope(&envelope, self.inbound_max_frame_bytes()) {
            return self.error_actions(None, error);
        }
        self.process_envelope(envelope, now_ms, true)
    }

    pub fn prepare_outbound(
        &mut self,
        kind: u16,
        payload: impl Into<Vec<u8>>,
    ) -> Result<Vec<Envelope>, SessionProtocolError> {
        self.prepare_outbound_with_flags(kind, payload.into(), 0)
    }

    pub fn prepare_outbound_unfragmented(
        &mut self,
        kind: u16,
        payload: impl Into<Vec<u8>>,
    ) -> Envelope {
        Envelope::new(
            kind,
            payload.into(),
            self.take_outbound_seq(),
            0,
            CURRENT_VERSION,
        )
    }

    pub fn prepare_outbound_with_flags(
        &mut self,
        kind: u16,
        payload: Vec<u8>,
        flags: u16,
    ) -> Result<Vec<Envelope>, SessionProtocolError> {
        let original_seq = self.take_outbound_seq();
        let max_frame_bytes = self.outbound_max_frame_bytes();
        let max_unchunked_payload = max_frame_bytes
            .checked_sub(super::ENVELOPE_OVERHEAD_BYTES)
            .filter(|maximum| *maximum > 0);
        if max_unchunked_payload.is_some_and(|maximum| payload.len() <= maximum) {
            return Ok(vec![Envelope::new(
                kind,
                payload,
                original_seq,
                flags,
                CURRENT_VERSION,
            )]);
        }
        if flags != 0 {
            return Err(SessionProtocolError::invalid_frame(
                "Chunked v1 envelopes cannot preserve non-zero flags",
            ));
        }

        let chunks = split_payload_into_chunks(
            &payload,
            kind,
            original_seq,
            max_frame_bytes,
            next_chunk_stream_id(),
        )?;
        debug_assert!(!chunks.is_empty());

        chunks
            .into_iter()
            .map(|chunk| {
                let payload = encode_payload(&chunk).map_err(SessionProtocolError::from)?;
                let envelope = Envelope::new(
                    MessageKind::Chunk as u16,
                    payload,
                    self.take_outbound_seq(),
                    0,
                    CURRENT_VERSION,
                );
                if encoded_envelope_len(&envelope) > max_frame_bytes {
                    return Err(SessionProtocolError::frame_too_large(
                        encoded_envelope_len(&envelope),
                        max_frame_bytes,
                    ));
                }
                Ok(envelope)
            })
            .collect()
    }

    fn process_envelope(
        &mut self,
        envelope: Envelope,
        now_ms: u64,
        allow_chunk: bool,
    ) -> Vec<SessionAction> {
        self.last_activity_at_ms = now_ms;

        if allow_chunk && envelope.kind == MessageKind::Chunk as u16 {
            let chunk = match decode_payload::<Chunk>(&envelope.payload) {
                Ok(chunk) => chunk,
                Err(_) => {
                    return self
                        .error_actions(None, SessionProtocolError::invalid_frame("Invalid chunk"));
                }
            };
            return match self.chunks.add_chunk(chunk, now_ms) {
                Ok(Some(message)) => self.process_envelope(
                    Envelope::new(
                        message.kind,
                        message.payload,
                        message.seq,
                        0,
                        CURRENT_VERSION,
                    ),
                    now_ms,
                    false,
                ),
                Ok(None) => Vec::new(),
                Err(error) => self.error_actions(None, error),
            };
        }

        if envelope.kind != MessageKind::HelloC2s as u16
            && self.phase == SessionPhase::AwaitingHello
        {
            return self.error_actions(
                Some(envelope.seq),
                SessionProtocolError::invalid_frame("HELLO required"),
            );
        }

        if envelope.kind == MessageKind::HelloC2s as u16 {
            return self.handle_hello(envelope);
        }
        if envelope.kind == MessageKind::Ping as u16 {
            return self.handle_ping(envelope);
        }

        let kind = match MessageKind::try_from(envelope.kind) {
            Ok(kind) => kind,
            Err(_) => {
                return self.error_actions(
                    Some(envelope.seq),
                    SessionProtocolError::new(
                        ProtocolErrorCode::UnknownKind,
                        format!("Unknown kind: {}", envelope.kind),
                        false,
                    ),
                );
            }
        };
        if !is_client_business_kind(kind) {
            return self.error_actions(
                Some(envelope.seq),
                SessionProtocolError::new(
                    ProtocolErrorCode::UnknownKind,
                    format!("Unknown kind: {}", envelope.kind),
                    false,
                ),
            );
        }

        vec![SessionAction::Inbound(envelope)]
    }

    fn handle_hello(&mut self, envelope: Envelope) -> Vec<SessionAction> {
        let hello = match decode_payload::<HelloC2s>(&envelope.payload) {
            Ok(hello) => hello,
            Err(error) => {
                return self.error_actions(Some(envelope.seq), SessionProtocolError::from(error));
            }
        };

        let negotiated = NegotiatedClient {
            client_impl: truncate_utf16_units(&hello.client_impl, 64),
            client_version: hello.client_version,
            client_max_frame_bytes: hello.max_frame_bytes,
            effective_max_frame_bytes: hello
                .max_frame_bytes
                .min(self.config.server_max_frame_bytes),
            supports_compression: hello.supports_compression,
            supports_diff_snapshot: hello.supports_diff_snapshot,
        };
        let response = HelloS2c {
            server_impl: self.config.server_impl.clone(),
            server_version: self.config.server_version.clone(),
            selected_version: CURRENT_VERSION,
            max_frame_bytes: self.config.server_max_frame_bytes,
            heartbeat_interval_ms: self.config.heartbeat_interval_ms,
            capabilities: self.config.capabilities.clone(),
        };
        let payload = match encode_payload(&response) {
            Ok(payload) => payload,
            Err(error) => {
                return self.error_actions(Some(envelope.seq), SessionProtocolError::from(error));
            }
        };
        let response_size = encoded_envelope_len(&Envelope::new(
            MessageKind::HelloS2c as u16,
            payload.clone(),
            self.next_outbound_seq,
            0,
            CURRENT_VERSION,
        ));
        if response_size > negotiated.effective_max_frame_bytes as usize {
            return self.error_actions(
                Some(envelope.seq),
                SessionProtocolError::new(
                    ProtocolErrorCode::InvalidFrame,
                    format!(
                        "client maxFrameBytes is too small for HELLO_S2C: {} < {response_size}",
                        negotiated.effective_max_frame_bytes
                    ),
                    false,
                ),
            );
        }

        self.phase = SessionPhase::Ready;
        self.negotiated = Some(negotiated.clone());
        match self.prepare_outbound(MessageKind::HelloS2c as u16, payload) {
            Ok(frames) => vec![
                SessionAction::Negotiated(negotiated),
                SessionAction::SendBatch(frames),
            ],
            Err(error) => {
                self.phase = SessionPhase::AwaitingHello;
                self.negotiated = None;
                self.error_actions(Some(envelope.seq), error)
            }
        }
    }

    fn handle_ping(&mut self, envelope: Envelope) -> Vec<SessionAction> {
        let ping = match decode_payload::<PingPong>(&envelope.payload) {
            Ok(ping) => ping,
            Err(error) => {
                return self.error_actions(Some(envelope.seq), SessionProtocolError::from(error));
            }
        };
        let frames = encode_payload(&ping)
            .map_err(SessionProtocolError::from)
            .and_then(|payload| self.prepare_outbound(MessageKind::Pong as u16, payload));
        frames
            .map(|frames| vec![SessionAction::SendBatch(frames)])
            .unwrap_or_default()
    }

    fn error_actions(
        &mut self,
        ref_seq: Option<u32>,
        error: SessionProtocolError,
    ) -> Vec<SessionAction> {
        let payload = ErrorPayload {
            ref_seq,
            code: error.code as u16,
            message: error.message,
            retryable: error.retryable,
        };
        encode_payload(&payload)
            .map_err(SessionProtocolError::from)
            .and_then(|payload| self.prepare_outbound(MessageKind::Error as u16, payload))
            .map(|frames| vec![SessionAction::SendBatch(frames)])
            .unwrap_or_default()
    }

    fn take_outbound_seq(&mut self) -> u32 {
        let seq = self.next_outbound_seq;
        self.next_outbound_seq = if seq == u32::MAX { 1 } else { seq + 1 };
        seq
    }
}

fn truncate_utf16_units(value: &str, max_units: usize) -> String {
    let units = value.encode_utf16().take(max_units).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn is_client_business_kind(kind: MessageKind) -> bool {
    matches!(
        kind,
        MessageKind::DeviceConnect
            | MessageKind::DeviceDisconnect
            | MessageKind::TmuxSelect
            | MessageKind::TmuxSelectWindow
            | MessageKind::TmuxCreateWindow
            | MessageKind::TmuxCloseWindow
            | MessageKind::TmuxClosePane
            | MessageKind::TmuxRenameWindow
            | MessageKind::TmuxSetWindowStyle
            | MessageKind::TmuxReorderWindows
            | MessageKind::TmuxReorderPanes
            | MessageKind::TmuxSubscribePanes
            | MessageKind::TmuxFetchPaneHistory
            | MessageKind::TmuxResizePane
            | MessageKind::TmuxApplyStackedLayout
            | MessageKind::TmuxSplitPane
            | MessageKind::TmuxFocusPane
            | MessageKind::TmuxRenamePane
            | MessageKind::TmuxMovePane
            | MessageKind::TmuxBreakPane
            | MessageKind::TermInput
            | MessageKind::TermKeyInput
            | MessageKind::TermPaste
            | MessageKind::TermResize
            | MessageKind::TermSyncSize
            | MessageKind::AgentSubscribe
            | MessageKind::AgentUnsubscribe
            | MessageKind::SiteThemeUpdate
            | MessageKind::CanonicalCommand
    )
}

#[cfg(test)]
mod tests {
    use tmex_protocol::{
        decode_payload, encode_payload, ErrorPayload, HelloC2s, HelloS2c, MessageKind, PingPong,
        ProtocolErrorCode, FLAG_ACK_REQUIRED, FLAG_IS_ACK,
    };

    use super::*;
    use crate::ws::MAX_CHUNK_STREAM_BYTES;
    fn hello(max_frame_bytes: u32) -> HelloC2s {
        HelloC2s {
            client_impl: "tmex-fe".into(),
            client_version: "0.1.0".into(),
            max_frame_bytes,
            supports_compression: false,
            supports_diff_snapshot: false,
        }
    }

    fn send_batch(actions: &[SessionAction]) -> &[Envelope] {
        actions
            .iter()
            .find_map(|action| match action {
                SessionAction::SendBatch(frames) => Some(frames.as_slice()),
                _ => None,
            })
            .expect("send batch")
    }

    fn decode_error(actions: &[SessionAction]) -> ErrorPayload {
        let envelope = send_batch(actions).first().expect("error frame");
        assert_eq!(envelope.kind, MessageKind::Error as u16);
        assert_eq!(envelope.flags, 0);
        decode_payload(&envelope.payload).expect("decode error")
    }

    #[test]
    fn hello_negotiates_capabilities_and_starts_outbound_seq_at_one() {
        let mut session = LegacyBorshSession::new(SessionConfig::new("0.17.0"), 5);
        let mut client_hello = hello(65_536);
        client_hello.client_impl = format!("tmex-fe-{}", "x".repeat(100));
        let payload = encode_payload(&client_hello).expect("encode hello");
        let envelope = Envelope::new(
            MessageKind::HelloC2s as u16,
            payload,
            42,
            FLAG_ACK_REQUIRED,
            7,
        );

        let actions = session.receive_envelope(envelope, 10);
        assert_eq!(session.phase(), SessionPhase::Ready);
        assert_eq!(session.outbound_max_frame_bytes(), 65_536);
        let SessionAction::Negotiated(client) = actions.first().expect("negotiated event") else {
            panic!("first action must report negotiation");
        };
        assert_eq!(client.client_impl, client_hello.client_impl[..64]);

        let response = send_batch(&actions).first().expect("hello response");
        assert_eq!(response.kind, MessageKind::HelloS2c as u16);
        assert_eq!(response.seq, 1);
        assert_eq!(response.flags, 0);
        assert_eq!(response.version, CURRENT_VERSION);
        let hello: HelloS2c = decode_payload(&response.payload).expect("decode hello response");
        assert_eq!(hello.server_impl, "tmex-gateway");
        assert_eq!(hello.server_version, "0.17.0");
        assert_eq!(hello.max_frame_bytes as usize, DEFAULT_MAX_FRAME_BYTES);
        assert_eq!(hello.heartbeat_interval_ms, DEFAULT_HEARTBEAT_INTERVAL_MS);
        assert_eq!(hello.capabilities, DEFAULT_CAPABILITIES);
    }

    #[test]
    fn business_before_hello_gets_error_only_and_flags_remain_reserved() {
        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let envelope = Envelope::new(
            MessageKind::DeviceConnect as u16,
            Vec::new(),
            9,
            FLAG_ACK_REQUIRED | FLAG_IS_ACK,
            CURRENT_VERSION,
        );
        let error = decode_error(&session.receive_envelope(envelope, 1));
        assert_eq!(error.ref_seq, Some(9));
        assert_eq!(error.code, ProtocolErrorCode::InvalidFrame as u16);
        assert_eq!(error.message, "HELLO required");

        let hello = encode_payload(&hello(DEFAULT_MAX_FRAME_BYTES as u32)).expect("encode hello");
        session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, hello, 10, 0, CURRENT_VERSION),
            2,
        );
        let business = Envelope::new(
            MessageKind::DeviceConnect as u16,
            vec![1, 2],
            11,
            FLAG_ACK_REQUIRED | FLAG_IS_ACK,
            CURRENT_VERSION,
        );
        assert_eq!(
            session.receive_envelope(business.clone(), 3),
            vec![SessionAction::Inbound(business)]
        );
    }

    #[test]
    fn ping_pong_echoes_payload_and_uses_the_next_server_seq() {
        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let hello = encode_payload(&hello(DEFAULT_MAX_FRAME_BYTES as u32)).expect("encode hello");
        session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, hello, 1, 0, CURRENT_VERSION),
            0,
        );

        let ping = PingPong {
            nonce: 12_345,
            time_ms: 67_890,
        };
        let payload = encode_payload(&ping).expect("encode ping");
        let actions = session.receive_envelope(
            Envelope::new(
                MessageKind::Ping as u16,
                payload,
                2,
                FLAG_ACK_REQUIRED,
                CURRENT_VERSION,
            ),
            10_000_000,
        );
        let response = send_batch(&actions).first().expect("pong");
        assert_eq!(response.kind, MessageKind::Pong as u16);
        assert_eq!(response.seq, 2);
        assert_eq!(response.flags, 0);
        assert_eq!(decode_payload::<PingPong>(&response.payload), Ok(ping));
    }

    #[test]
    fn incoming_frame_limit_and_unknown_kind_return_borsh_errors_without_close_actions() {
        let config = SessionConfig {
            server_max_frame_bytes: 64,
            ..SessionConfig::default()
        };
        let mut session = LegacyBorshSession::new(config, 0);
        let oversized = vec![0; 65];
        let error = decode_error(&session.receive_frame(&oversized, 1));
        assert_eq!(error.ref_seq, None);
        assert_eq!(error.code, ProtocolErrorCode::FrameTooLarge as u16);

        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let hello = encode_payload(&hello(DEFAULT_MAX_FRAME_BYTES as u32)).expect("encode hello");
        session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, hello, 1, 0, CURRENT_VERSION),
            2,
        );
        let unknown = Envelope::new(0xffff, Vec::new(), 88, 0, CURRENT_VERSION);
        let error = decode_error(&session.receive_envelope(unknown, 3));
        assert_eq!(error.ref_seq, Some(88));
        assert_eq!(error.code, ProtocolErrorCode::UnknownKind as u16);
    }

    #[test]
    fn too_small_client_frame_limit_does_not_half_negotiate_the_session() {
        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let payload = encode_payload(&hello(1)).expect("encode hello");
        let actions = session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, payload, 7, 0, CURRENT_VERSION),
            1,
        );

        assert_eq!(session.phase(), SessionPhase::AwaitingHello);
        assert!(session.negotiated_client().is_none());
        assert!(actions
            .iter()
            .all(|action| !matches!(action, SessionAction::Negotiated(_))));
        let error = decode_error(&actions);
        assert_eq!(error.ref_seq, Some(7));
        assert_eq!(error.code, ProtocolErrorCode::InvalidFrame as u16);
        assert!(error.message.contains("maxFrameBytes"));
    }

    #[test]
    fn outbound_chunk_batch_preserves_original_seq_and_frame_limit() {
        let config = SessionConfig {
            server_max_frame_bytes: 128,
            capabilities: Vec::new(),
            ..SessionConfig::default()
        };
        let mut session = LegacyBorshSession::new(config, 0);
        let hello = encode_payload(&hello(128)).expect("encode hello");
        session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, hello, 1, 0, CURRENT_VERSION),
            0,
        );

        let frames = session
            .prepare_outbound(MessageKind::StateSnapshot as u16, vec![0xab; 512])
            .expect("chunk payload");
        assert!(frames.len() > 1);
        assert!(frames.iter().all(|frame| {
            frame.kind == MessageKind::Chunk as u16 && encoded_envelope_len(frame) <= 128
        }));

        let decoded: Vec<Chunk> = frames
            .iter()
            .map(|frame| decode_payload(&frame.payload).expect("decode chunk"))
            .collect();
        assert!(decoded.iter().all(|chunk| {
            chunk.original_kind == MessageKind::StateSnapshot as u16 && chunk.original_seq == 2
        }));
        assert_eq!(frames.first().map(|frame| frame.seq), Some(3));

        let error = session
            .prepare_outbound(
                MessageKind::StateSnapshot as u16,
                vec![0; MAX_CHUNK_STREAM_BYTES + 1],
            )
            .expect_err("outbound chunk streams are byte bounded");
        assert_eq!(error.code, ProtocolErrorCode::FrameTooLarge);
    }

    #[test]
    fn incoming_chunks_can_carry_the_required_first_hello() {
        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let hello_payload = encode_payload(&hello(DEFAULT_MAX_FRAME_BYTES as u32)).expect("hello");
        let split = hello_payload.len() / 2;
        let chunks = [
            Chunk {
                chunk_stream_id: 7,
                original_kind: MessageKind::HelloC2s as u16,
                original_seq: 5,
                total_chunks: 2,
                chunk_index: 0,
                data: hello_payload[..split].to_vec(),
            },
            Chunk {
                chunk_stream_id: 7,
                original_kind: MessageKind::HelloC2s as u16,
                original_seq: 5,
                total_chunks: 2,
                chunk_index: 1,
                data: hello_payload[split..].to_vec(),
            },
        ];

        let first = encode_payload(&chunks[0]).expect("chunk one");
        assert!(session
            .receive_envelope(
                Envelope::new(MessageKind::Chunk as u16, first, 1, 0, CURRENT_VERSION),
                0,
            )
            .is_empty());
        let second = encode_payload(&chunks[1]).expect("chunk two");
        let actions = session.receive_envelope(
            Envelope::new(MessageKind::Chunk as u16, second, 2, 0, CURRENT_VERSION),
            1,
        );
        assert_eq!(session.phase(), SessionPhase::Ready);
        assert!(matches!(
            actions.first(),
            Some(SessionAction::Negotiated(_))
        ));
    }

    #[test]
    fn gateway_does_not_add_a_server_side_heartbeat_timeout() {
        let mut session = LegacyBorshSession::new(SessionConfig::default(), 0);
        let hello = encode_payload(&hello(DEFAULT_MAX_FRAME_BYTES as u32)).expect("encode hello");
        session.receive_envelope(
            Envelope::new(MessageKind::HelloC2s as u16, hello, 1, 0, CURRENT_VERSION),
            0,
        );

        assert_eq!(session.cleanup_chunks(u64::MAX), 0);
        assert_eq!(session.phase(), SessionPhase::Ready);
    }
}
