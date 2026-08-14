use tmex_protocol::{check_magic, decode_envelope, Envelope, MAGIC};

use super::SessionProtocolError;

pub const ENVELOPE_OVERHEAD_BYTES: usize = 16;

pub fn encoded_envelope_len(envelope: &Envelope) -> usize {
    ENVELOPE_OVERHEAD_BYTES.saturating_add(envelope.payload.len())
}

pub fn decode_frame(data: &[u8], max_frame_bytes: usize) -> Result<Envelope, SessionProtocolError> {
    if data.len() > max_frame_bytes {
        return Err(SessionProtocolError::frame_too_large(
            data.len(),
            max_frame_bytes,
        ));
    }
    if !check_magic(data) {
        return Err(SessionProtocolError::invalid_frame("Missing magic bytes"));
    }

    decode_envelope(data).map_err(SessionProtocolError::from)
}

pub fn validate_envelope(
    envelope: &Envelope,
    max_frame_bytes: usize,
) -> Result<(), SessionProtocolError> {
    if envelope.magic != MAGIC {
        return Err(SessionProtocolError::invalid_frame("Missing magic bytes"));
    }

    let actual = encoded_envelope_len(envelope);
    if actual > max_frame_bytes {
        return Err(SessionProtocolError::frame_too_large(
            actual,
            max_frame_bytes,
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use tmex_protocol::{encode_envelope, MessageKind, CURRENT_VERSION};

    use super::*;

    #[test]
    fn frame_limit_is_checked_before_borsh_allocation() {
        let frame = encode_envelope(MessageKind::Ping as u16, vec![0; 64], 1, 0, CURRENT_VERSION)
            .expect("encode frame");

        assert_eq!(
            decode_frame(&frame, frame.len() - 1),
            Err(SessionProtocolError::frame_too_large(
                frame.len(),
                frame.len() - 1
            ))
        );
        assert!(decode_frame(&frame, frame.len()).is_ok());
    }

    #[test]
    fn missing_magic_uses_the_gateway_error_message() {
        let error = decode_frame(&[0, 0], 64).expect_err("invalid magic");
        assert_eq!(error.message, "Missing magic bytes");
    }
}
