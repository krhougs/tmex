mod backpressure;
mod chunk;
mod error;
mod frame;
mod hub;
mod legacy_business;
mod session;
mod session_state;
mod switch_barrier;
mod terminal_output_batcher;

pub use backpressure::{
    BackpressureAction, BackpressureConfig, BackpressureGuard, BackpressureTermination,
    SendOutcome, GATEWAY_WS_BACKPRESSURE_LIMIT_BYTES, GATEWAY_WS_BACKPRESSURE_TIMEOUT_MS,
    GATEWAY_WS_MAX_ATOMIC_BATCH_BYTES,
};
pub use chunk::{
    next_chunk_stream_id, split_payload_into_chunks, ChunkReassembler, ReassembledMessage,
    CHUNK_PAYLOAD_OVERHEAD_BYTES, CHUNK_TIMEOUT_MS, MAX_CHUNKS_PER_MESSAGE,
    MAX_CHUNK_BUFFERED_BYTES, MAX_CHUNK_STREAMS, MAX_CHUNK_STREAM_BYTES,
};
pub use error::SessionProtocolError;
pub use frame::{decode_frame, encoded_envelope_len, validate_envelope, ENVELOPE_OVERHEAD_BYTES};
pub use hub::{
    AgentSyncProvider, GatewayTreeCustomNames, GatewayTreeOrderChange, GatewayWsHub,
    GatewayWsHubConfig, GatewayWsHubDependencies, GatewayWsHubError, WatchEventBroadcaster,
    GATEWAY_WS_IPC_FRAME_CAPACITY, GATEWAY_WS_OUTBOUND_FRAME_CAPACITY,
    GATEWAY_WS_SESSION_MAILBOX_CAPACITY,
};
pub use legacy_business::{
    parse_window_layout_size, CapturedPaneHistory, LegacyBusinessEvent, LegacyBusinessRuntime,
    LegacyBusinessSession, LegacyPanePosition, LegacyRuntimeCommand, LegacySplitDirection,
    LegacyTmuxEventDelivery,
};
pub use session::{
    LegacyBorshSession, NegotiatedClient, SessionAction, SessionConfig, SessionPhase,
    DEFAULT_CAPABILITIES, DEFAULT_HEARTBEAT_INTERVAL_MS,
};
pub use session_state::{
    DeviceConnectionContext, DeviceConnectionState, LegacySessionState, OutputGateContext,
    OutputGateState, SelectTransactionContext, SelectTransactionState, ThrottleContext,
    WsConnectionContext, WsConnectionState, OUTPUT_GATE_MAX_ITEMS,
};
pub use switch_barrier::{
    LegacyFrameSink, SwitchBarrier, SwitchBarrierContext, SwitchBarrierEvent, SwitchTimeoutStage,
    SWITCH_ACK_TIMEOUT_MS, SWITCH_HISTORY_TIMEOUT_MS, SWITCH_LIVE_RESUME_DELAY_MS,
};
pub use terminal_output_batcher::{
    TerminalOutputBatch, TerminalOutputBatcher, TerminalOutputBatcherConfig,
    TerminalOutputBatcherStats, GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
    GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES, GATEWAY_TERM_OUTPUT_BATCH_TOTAL_MAX_BYTES,
};
