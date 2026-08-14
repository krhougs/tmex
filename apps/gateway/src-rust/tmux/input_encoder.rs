use std::fmt;

pub const SEND_KEYS_HEX_CHUNK_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputEncodingError;

impl fmt::Display for InputEncodingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("tmux send-keys hex chunk size must be greater than zero")
    }
}

impl std::error::Error for InputEncodingError {}

pub fn encode_input_to_hex_chunks(input: &str) -> Vec<Vec<String>> {
    encode_chunks(input.as_bytes(), SEND_KEYS_HEX_CHUNK_BYTES)
}

pub fn encode_input_to_hex_chunks_with_size(
    input: &str,
    chunk_bytes: usize,
) -> Result<Vec<Vec<String>>, InputEncodingError> {
    encode_bytes_to_hex_chunks_with_size(input.as_bytes(), chunk_bytes)
}

pub fn encode_bytes_to_hex_chunks(bytes: &[u8]) -> Vec<Vec<String>> {
    encode_chunks(bytes, SEND_KEYS_HEX_CHUNK_BYTES)
}

pub fn encode_bytes_to_hex_chunks_with_size(
    bytes: &[u8],
    chunk_bytes: usize,
) -> Result<Vec<Vec<String>>, InputEncodingError> {
    if chunk_bytes == 0 {
        return Err(InputEncodingError);
    }
    Ok(encode_chunks(bytes, chunk_bytes))
}

fn encode_chunks(bytes: &[u8], chunk_bytes: usize) -> Vec<Vec<String>> {
    bytes
        .chunks(chunk_bytes)
        .map(|chunk| chunk.iter().map(|byte| format!("{byte:02x}")).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_and_arbitrary_bytes_across_tmux_chunks() {
        assert_eq!(
            encode_input_to_hex_chunks("A中"),
            vec![vec!["41", "e4", "b8", "ad"]]
        );
        let mut bytes = vec![b'a'; SEND_KEYS_HEX_CHUNK_BYTES];
        bytes.extend([0x00, 0x80, 0xff]);
        let chunks = encode_bytes_to_hex_chunks(&bytes);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1], ["00", "80", "ff"]);
    }
}
