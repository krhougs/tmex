use borsh::{BorshDeserialize, BorshSerialize};

use crate::{ProtocolError, WireToken};

pub const CANONICAL_STATE_PROTOCOL_VERSION: u16 = 1;
pub const CANONICAL_STATE_MAX_FRAME_BYTES: usize = 32 * 1024;
pub const WS_ENVELOPE_WIRE_OVERHEAD_BYTES: usize = 16;
pub const CANONICAL_STATE_MAX_PAYLOAD_BYTES: usize =
    CANONICAL_STATE_MAX_FRAME_BYTES - WS_ENVELOPE_WIRE_OVERHEAD_BYTES;

pub const SOURCE_ENTITY_DEVICE: u8 = 0;
pub const SOURCE_ENTITY_SERVER: u8 = 1;
pub const SOURCE_ENTITY_SESSION: u8 = 2;
pub const SOURCE_ENTITY_WINDOW: u8 = 3;
pub const SOURCE_ENTITY_PANE: u8 = 4;

pub const SOURCE_FIELD_NAME: u8 = 1;
pub const SOURCE_FIELD_TITLE: u8 = 2;
pub const SOURCE_FIELD_INDEX: u8 = 3;
pub const SOURCE_FIELD_ACTIVE: u8 = 4;
pub const SOURCE_FIELD_LAYOUT: u8 = 5;
pub const SOURCE_FIELD_WIDTH: u8 = 6;
pub const SOURCE_FIELD_HEIGHT: u8 = 7;
pub const SOURCE_FIELD_LEFT: u8 = 8;
pub const SOURCE_FIELD_TOP: u8 = 9;
pub const SOURCE_FIELD_CURRENT_PATH: u8 = 10;
pub const SOURCE_FIELD_CURRENT_COMMAND: u8 = 11;
pub const SOURCE_FIELD_CONNECTED: u8 = 12;
pub const SOURCE_FIELD_PANE_EPOCH: u8 = 13;
pub const SOURCE_FIELD_CUSTOM_NAME: u8 = 14;

pub const SUBSCRIPTION_REJECTED_NOT_FOUND: u8 = 1;
pub const SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED: u8 = 2;
pub const SUBSCRIPTION_REJECTED_EPOCH_CHANGED: u8 = 3;

pub const SOURCE_GAP_SCOPE_STREAM: u8 = 0;
pub const SOURCE_GAP_SCOPE_METADATA: u8 = 1;
pub const SOURCE_GAP_SCOPE_PANE: u8 = 2;

pub const SOURCE_GAP_REASON_METADATA_GAP: u8 = 1;
pub const SOURCE_GAP_REASON_PANE_GAP: u8 = 2;
pub const SOURCE_GAP_REASON_EPOCH_CHANGED: u8 = 3;
pub const SOURCE_GAP_REASON_CACHE_EVICTED: u8 = 4;
pub const SOURCE_GAP_REASON_RESOURCE_EXHAUSTED: u8 = 5;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SourceEntityKey {
    pub device_id: String,
    pub server_epoch: WireToken,
    pub entity_kind: u8,
    pub native_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum SourceMetadataValue {
    Unset,
    String(String),
    Bool(bool),
    U16(u16),
    U32(u32),
    Bytes16(WireToken),
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SourceMetadataField {
    pub field: u8,
    pub value: SourceMetadataValue,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SourceMetadataRecord {
    pub key: SourceEntityKey,
    pub parent: Option<SourceEntityKey>,
    pub fields: Vec<SourceMetadataField>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalPaneTarget {
    pub device_id: String,
    pub server_epoch: WireToken,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalTerminalCursor {
    pub pane_epoch: WireToken,
    pub terminal_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalHistoryCursor {
    pub pane_epoch: WireToken,
    pub history_epoch: WireToken,
    pub before_line: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalPaneSubscription {
    pub pane: CanonicalPaneTarget,
    pub cursor: Option<CanonicalTerminalCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SetPaneSubscriptions {
    pub generation: u64,
    pub active_panes: Vec<CanonicalPaneSubscription>,
    pub hot_panes: Vec<CanonicalPaneSubscription>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalTerminalInput {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub pane_epoch: WireToken,
    pub input_id: WireToken,
    pub data: Vec<u8>,
}

pub const TERMINAL_KEY_MOD_SHIFT: u16 = 1 << 0;
pub const TERMINAL_KEY_MOD_ALT: u16 = 1 << 1;
pub const TERMINAL_KEY_MOD_CTRL: u16 = 1 << 2;
pub const TERMINAL_KEY_MOD_SUPER: u16 = 1 << 3;
pub const TERMINAL_KEY_MOD_HYPER: u16 = 1 << 4;
pub const TERMINAL_KEY_MOD_META: u16 = 1 << 5;
pub const TERMINAL_KEY_MOD_CAPS_LOCK: u16 = 1 << 6;
pub const TERMINAL_KEY_MOD_NUM_LOCK: u16 = 1 << 7;
pub const TERMINAL_KEY_MOD_MASK: u16 = 0xff;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum TerminalKey {
    Unicode(u32),
    Enter,
    Tab,
    BackTab,
    Escape,
    Backspace,
    Insert,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Function(u8),
    NumpadEnter,
    NumpadDigit(u8),
    NumpadDecimal,
    NumpadAdd,
    NumpadSubtract,
    NumpadMultiply,
    NumpadDivide,
    NumpadEqual,
    ShiftLeft,
    ShiftRight,
    ControlLeft,
    ControlRight,
    AltLeft,
    AltRight,
    SuperLeft,
    SuperRight,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum TerminalKeyAction {
    Press,
    Repeat(u16),
    Release,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalTerminalKeyInput {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub pane_epoch: WireToken,
    pub input_id: WireToken,
    pub key: TerminalKey,
    pub modifiers: u16,
    pub action: TerminalKeyAction,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalResizePane {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalRequestScreen {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub byte_limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalRequestHistory {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub before_cursor: Option<CanonicalHistoryCursor>,
    pub byte_limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum CanonicalCommand {
    SetPaneSubscriptions(SetPaneSubscriptions),
    TerminalInput(CanonicalTerminalInput),
    ResizePane(CanonicalResizePane),
    RequestScreen(CanonicalRequestScreen),
    RequestHistory(CanonicalRequestHistory),
    TerminalKeyInput(CanonicalTerminalKeyInput),
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalCommandEnvelope {
    pub protocol_version: u16,
    pub command: CanonicalCommand,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalFeedReady {
    pub gateway_epoch: WireToken,
    pub max_frame_bytes: u32,
    pub max_active_panes: u16,
    pub max_hot_panes: u16,
    pub max_screen_bytes: u32,
    pub max_history_page_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SourceMetadataSnapshot {
    pub metadata_epoch: WireToken,
    pub revision: u64,
    pub snapshot_id: WireToken,
    pub chunk_index: u16,
    pub total_chunks: u16,
    pub records: Vec<SourceMetadataRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct SourceMetadataPatch {
    pub metadata_epoch: WireToken,
    pub from_revision: u64,
    pub through_revision: u64,
    pub upserts: Vec<SourceMetadataRecord>,
    pub removals: Vec<SourceEntityKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalPaneData {
    pub pane: CanonicalPaneTarget,
    pub pane_epoch: WireToken,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalSubscriptionRejection {
    pub pane: CanonicalPaneTarget,
    pub reason: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalSubscriptionApplied {
    pub generation: u64,
    pub active_panes: Vec<CanonicalPaneTarget>,
    pub hot_panes: Vec<CanonicalPaneTarget>,
    pub rejected: Vec<CanonicalSubscriptionRejection>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalScreenBegin {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub pane_epoch: WireToken,
    pub base_seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub modes: u8,
    pub total_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalContentChunk {
    pub request_id: WireToken,
    pub offset: u32,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalScreenCommit {
    pub request_id: WireToken,
    pub total_bytes: u32,
    pub history_cursor: Option<CanonicalHistoryCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalHistoryBegin {
    pub request_id: WireToken,
    pub pane: CanonicalPaneTarget,
    pub pane_epoch: WireToken,
    pub history_epoch: WireToken,
    pub line_start: u32,
    pub line_end: u32,
    pub truncated: bool,
    pub total_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalHistoryCommit {
    pub request_id: WireToken,
    pub total_bytes: u32,
    pub next_cursor: Option<CanonicalHistoryCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalMetadataGap {
    pub expected_epoch: WireToken,
    pub available_epoch: WireToken,
    pub expected_revision: u64,
    pub available_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalPaneGap {
    pub pane: CanonicalPaneTarget,
    pub expected_pane_epoch: WireToken,
    pub available_pane_epoch: WireToken,
    pub expected_seq: u64,
    pub available_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum CanonicalGapScope {
    Stream,
    Metadata(CanonicalMetadataGap),
    Pane(CanonicalPaneGap),
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalSourceGap {
    pub reason: u8,
    pub scope: CanonicalGapScope,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalError {
    pub request_id: Option<WireToken>,
    pub code: u16,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub enum CanonicalEvent {
    FeedReady(CanonicalFeedReady),
    SourceMetadataSnapshot(SourceMetadataSnapshot),
    SourceMetadataPatch(SourceMetadataPatch),
    PaneData(CanonicalPaneData),
    SubscriptionApplied(CanonicalSubscriptionApplied),
    ScreenBegin(CanonicalScreenBegin),
    ScreenChunk(CanonicalContentChunk),
    ScreenCommit(CanonicalScreenCommit),
    HistoryBegin(CanonicalHistoryBegin),
    HistoryChunk(CanonicalContentChunk),
    HistoryCommit(CanonicalHistoryCommit),
    SourceGap(CanonicalSourceGap),
    Error(CanonicalError),
    KittyImageAsset(KittyImageAsset),
    KittyPlacementAsset(KittyPlacementAsset),
    KittyDeleteAsset(KittyDeleteAsset),
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct KittyImageAsset {
    pub pane: CanonicalPaneTarget,
    pub image_id: u32,
    pub width: u32,
    pub height: u32,
    pub format: u8,
    pub offset: u32,
    pub total: u32,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct KittyPlacementAsset {
    pub pane: CanonicalPaneTarget,
    pub placement_id: u32,
    pub image_id: u32,
    pub src_x: u32,
    pub src_y: u32,
    pub src_width: u32,
    pub src_height: u32,
    pub columns: u16,
    pub rows: u16,
    pub x_offset: u16,
    pub y_offset: u16,
    pub z_index: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct KittyDeleteAsset {
    pub pane: CanonicalPaneTarget,
    pub image_id: Option<u32>,
}

pub const KITTY_IMAGE_FORMAT_PNG: u8 = 100;
pub const KITTY_IMAGE_FORMAT_ZLIB: u8 = 122;
pub const KITTY_IMAGE_FORMAT_RAW: u8 = 0;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct CanonicalEventEnvelope {
    pub protocol_version: u16,
    pub event: CanonicalEvent,
}

pub fn encode_canonical_command(command: CanonicalCommand) -> Result<Vec<u8>, ProtocolError> {
    encode_bounded(&CanonicalCommandEnvelope {
        protocol_version: CANONICAL_STATE_PROTOCOL_VERSION,
        command,
    })
}

pub fn decode_canonical_command(data: &[u8]) -> Result<CanonicalCommandEnvelope, ProtocolError> {
    let decoded = decode_bounded::<CanonicalCommandEnvelope>(data)?;
    assert_protocol_version(decoded.protocol_version)?;
    assert_canonical_encoding(&decoded, data)?;
    Ok(decoded)
}

pub fn encode_canonical_event(event: CanonicalEvent) -> Result<Vec<u8>, ProtocolError> {
    if let CanonicalEvent::PaneData(data) = &event {
        let expected_end = data
            .seq_start
            .checked_add(data.data.len() as u64)
            .ok_or_else(|| {
                ProtocolError::InvalidFrame("PaneData sequence range mismatch".into())
            })?;
        if data.seq_end != expected_end {
            return Err(ProtocolError::InvalidFrame(
                "PaneData sequence range mismatch".into(),
            ));
        }
    }
    encode_bounded(&CanonicalEventEnvelope {
        protocol_version: CANONICAL_STATE_PROTOCOL_VERSION,
        event,
    })
}

pub fn decode_canonical_event(data: &[u8]) -> Result<CanonicalEventEnvelope, ProtocolError> {
    let decoded = decode_bounded::<CanonicalEventEnvelope>(data)?;
    assert_protocol_version(decoded.protocol_version)?;
    assert_canonical_encoding(&decoded, data)?;
    Ok(decoded)
}

fn encode_bounded<T: BorshSerialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let encoded =
        borsh::to_vec(value).map_err(|error| ProtocolError::PayloadDecode(error.to_string()))?;
    assert_payload_bounded(encoded.len())?;
    Ok(encoded)
}

fn decode_bounded<T: BorshDeserialize>(data: &[u8]) -> Result<T, ProtocolError> {
    assert_payload_bounded(data.len())?;
    T::try_from_slice(data).map_err(|error| ProtocolError::PayloadDecode(error.to_string()))
}

fn assert_payload_bounded(actual: usize) -> Result<(), ProtocolError> {
    if actual > CANONICAL_STATE_MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual,
            maximum: CANONICAL_STATE_MAX_PAYLOAD_BYTES,
        });
    }
    Ok(())
}

fn assert_protocol_version(actual: u16) -> Result<(), ProtocolError> {
    if actual != CANONICAL_STATE_PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedProtocol(actual));
    }
    Ok(())
}

fn assert_canonical_encoding<T: BorshSerialize>(
    decoded: &T,
    original: &[u8],
) -> Result<(), ProtocolError> {
    let canonical =
        borsh::to_vec(decoded).map_err(|error| ProtocolError::PayloadDecode(error.to_string()))?;
    if canonical != original {
        return Err(ProtocolError::InvalidFrame(
            "non-canonical payload encoding".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{encode_envelope, MessageKind, CURRENT_VERSION};

    fn pane() -> CanonicalPaneTarget {
        CanonicalPaneTarget {
            device_id: "local".into(),
            server_epoch: [1; 16],
            pane_id: "%1".into(),
        }
    }

    #[test]
    fn command_variant_indices_match_the_v1_schema_order() {
        let encoded =
            encode_canonical_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: [2; 16],
                pane: pane(),
                byte_limit: 512,
            }))
            .expect("encode command");

        assert_eq!(&encoded[..3], &[1, 0, 3]);
        assert!(matches!(
            decode_canonical_command(&encoded)
                .expect("decode command")
                .command,
            CanonicalCommand::RequestScreen(_)
        ));
    }

    #[test]
    fn semantic_key_is_appended_without_reindexing_v1_commands() {
        let command = CanonicalCommand::TerminalKeyInput(CanonicalTerminalKeyInput {
            request_id: [2; 16],
            pane: pane(),
            pane_epoch: [3; 16],
            input_id: [4; 16],
            key: TerminalKey::Enter,
            modifiers: TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
            action: TerminalKeyAction::Press,
        });
        let encoded = encode_canonical_command(command.clone()).expect("encode semantic key");
        assert_eq!(
            encoded[2], 5,
            "new variant must be appended after all v1 commands"
        );
        assert_eq!(
            decode_canonical_command(&encoded)
                .expect("decode semantic key")
                .command,
            command
        );
    }

    #[test]
    fn pane_data_requires_an_exact_sequence_range() {
        let invalid = CanonicalEvent::PaneData(CanonicalPaneData {
            pane: pane(),
            pane_epoch: [3; 16],
            seq_start: 10,
            seq_end: 12,
            data: vec![1, 2, 3],
        });

        assert!(matches!(
            encode_canonical_event(invalid),
            Err(ProtocolError::InvalidFrame(message))
                if message == "PaneData sequence range mismatch"
        ));
    }

    #[test]
    fn canonical_payload_enforces_version_and_size() {
        let mut encoded =
            encode_canonical_command(CanonicalCommand::RequestScreen(CanonicalRequestScreen {
                request_id: [2; 16],
                pane: pane(),
                byte_limit: 512,
            }))
            .expect("encode command");
        encoded[..2].copy_from_slice(&2_u16.to_le_bytes());
        assert_eq!(
            decode_canonical_command(&encoded),
            Err(ProtocolError::UnsupportedProtocol(2))
        );

        let oversized = vec![0; CANONICAL_STATE_MAX_PAYLOAD_BYTES + 1];
        assert!(matches!(
            decode_canonical_command(&oversized),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn matches_the_typescript_v1_golden_vectors() {
        let pane = CanonicalPaneTarget {
            device_id: "dev-1".into(),
            server_epoch: core::array::from_fn(|index| index as u8),
            pane_id: "%7".into(),
        };
        let command = encode_canonical_command(CanonicalCommand::SetPaneSubscriptions(
            SetPaneSubscriptions {
                generation: 7,
                active_panes: vec![CanonicalPaneSubscription {
                    pane: pane.clone(),
                    cursor: None,
                }],
                hot_panes: Vec::new(),
            },
        ))
        .expect("encode subscriptions");
        assert_eq!(
            hex::encode(command),
            "010000070000000000000001000000050000006465762d31000102030405060708090a0b0c0d0e0f0200000025370000000000"
        );

        let pane_data = encode_canonical_event(CanonicalEvent::PaneData(CanonicalPaneData {
            pane: pane.clone(),
            pane_epoch: [0xaa; 16],
            seq_start: 10,
            seq_end: 13,
            data: b"ABC".to_vec(),
        }))
        .expect("encode pane data");
        let pane_data_envelope = encode_envelope(
            MessageKind::CanonicalEvent.into(),
            pane_data,
            9,
            0,
            CURRENT_VERSION,
        )
        .expect("encode event envelope");
        assert_eq!(
            hex::encode(pane_data_envelope),
            "54580100020900000900000049000000010003050000006465762d31000102030405060708090a0b0c0d0e0f020000002537aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0a000000000000000d0000000000000003000000414243"
        );

        let history_command =
            encode_canonical_command(CanonicalCommand::RequestHistory(CanonicalRequestHistory {
                request_id: [0; 16],
                pane: pane.clone(),
                before_cursor: Some(CanonicalHistoryCursor {
                    pane_epoch: [0; 16],
                    history_epoch: core::array::from_fn(|index| index as u8),
                    before_line: 99,
                }),
                byte_limit: 4096,
            }))
            .expect("encode history command");
        assert_eq!(
            hex::encode(history_command),
            "01000400000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f0200000025370100000000000000000000000000000000000102030405060708090a0b0c0d0e0f6300000000100000"
        );

        let history_event =
            encode_canonical_event(CanonicalEvent::HistoryBegin(CanonicalHistoryBegin {
                request_id: [0; 16],
                pane,
                pane_epoch: [0; 16],
                history_epoch: core::array::from_fn(|index| index as u8),
                line_start: 10,
                line_end: 20,
                truncated: false,
                total_bytes: 5,
            }))
            .expect("encode history event");
        assert_eq!(
            hex::encode(history_event),
            "01000800000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f02000000253700000000000000000000000000000000000102030405060708090a0b0c0d0e0f0a000000140000000005000000"
        );
    }
}
