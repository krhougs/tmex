use borsh::{BorshDeserialize, BorshSerialize};

use crate::ProtocolError;

pub const MAGIC: [u8; 2] = [0x54, 0x58];
pub const CURRENT_VERSION: u16 = 1;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1_048_576;

pub const FLAG_ACK_REQUIRED: u16 = 1 << 0;
pub const FLAG_IS_ACK: u16 = 1 << 1;
pub const FLAG_IS_ERROR: u16 = 1 << 2;
pub const FLAG_IS_CHUNK: u16 = 1 << 3;
pub const FLAG_IS_COMPRESSED: u16 = 1 << 4;

#[derive(Clone, Debug, PartialEq, Eq, BorshDeserialize, BorshSerialize)]
pub struct Envelope {
    pub magic: [u8; 2],
    pub version: u16,
    pub kind: u16,
    pub flags: u16,
    pub seq: u32,
    pub payload: Vec<u8>,
}

impl Envelope {
    pub fn new(kind: u16, payload: Vec<u8>, seq: u32, flags: u16, version: u16) -> Self {
        Self {
            magic: MAGIC,
            version,
            kind,
            flags,
            seq,
            payload,
        }
    }

    pub fn has_flag(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }

    pub fn set_flag(&mut self, flag: u16, value: bool) {
        if value {
            self.flags |= flag;
        } else {
            self.flags &= !flag;
        }
    }
}

pub fn encode_envelope(
    kind: u16,
    payload: impl Into<Vec<u8>>,
    seq: u32,
    flags: u16,
    version: u16,
) -> Result<Vec<u8>, ProtocolError> {
    borsh::to_vec(&Envelope::new(kind, payload.into(), seq, flags, version))
        .map_err(|error| ProtocolError::InvalidFrame(error.to_string()))
}

pub fn decode_envelope(data: &[u8]) -> Result<Envelope, ProtocolError> {
    if data.len() < 12 {
        return Err(ProtocolError::InvalidFrame("Envelope too small".into()));
    }
    if !check_magic(data) {
        return Err(ProtocolError::InvalidFrame("Invalid magic bytes".into()));
    }

    Envelope::try_from_slice(data).map_err(|error| ProtocolError::InvalidFrame(error.to_string()))
}

pub fn check_magic(data: &[u8]) -> bool {
    data.starts_with(&MAGIC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_matches_the_v1_borsh_wire_order() {
        let encoded = encode_envelope(0x0902, [0, 1, 2, 0xff], 0x0102_0304, 0x0005, 1)
            .expect("encode envelope");

        assert_eq!(
            encoded,
            [
                0x54, 0x58, 0x01, 0x00, 0x02, 0x09, 0x05, 0x00, 0x04, 0x03, 0x02, 0x01, 0x04, 0x00,
                0x00, 0x00, 0x00, 0x01, 0x02, 0xff,
            ]
        );
        assert_eq!(
            decode_envelope(&encoded).expect("decode envelope").payload,
            [0, 1, 2, 0xff]
        );
    }

    #[test]
    fn envelope_rejects_missing_magic_and_trailing_bytes() {
        let mut encoded = encode_envelope(1, [], 1, 0, 1).expect("encode envelope");
        encoded[0] = 0;
        assert!(matches!(
            decode_envelope(&encoded),
            Err(ProtocolError::InvalidFrame(message)) if message == "Invalid magic bytes"
        ));

        let mut encoded = encode_envelope(1, [], 1, 0, 1).expect("encode envelope");
        encoded.push(0);
        assert!(matches!(
            decode_envelope(&encoded),
            Err(ProtocolError::InvalidFrame(_))
        ));
    }

    #[test]
    fn flags_round_trip() {
        let mut envelope = Envelope::new(1, Vec::new(), 1, 0, 1);
        envelope.set_flag(FLAG_ACK_REQUIRED, true);
        envelope.set_flag(FLAG_IS_ERROR, true);
        envelope.set_flag(FLAG_ACK_REQUIRED, false);

        assert!(!envelope.has_flag(FLAG_ACK_REQUIRED));
        assert!(envelope.has_flag(FLAG_IS_ERROR));
    }
}
