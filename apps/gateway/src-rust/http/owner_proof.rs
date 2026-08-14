use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

const OWNER_PROOF_DOMAIN: &str = "vibex-gateway-owner-v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct GatewayOwnerProof {
    pub pid: u32,
    pub proof: String,
}

pub fn create_gateway_owner_proof(
    owner_token: Option<&str>,
    challenge: Option<&str>,
    pid: u32,
    tmux_healthy: bool,
) -> Option<GatewayOwnerProof> {
    let owner_token = owner_token?;
    let challenge = challenge?;
    if owner_token.len() != 64
        || !owner_token.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !(32..=128).contains(&challenge.len())
        || !challenge.bytes().all(|byte| byte.is_ascii_hexdigit())
        || pid == 0
    {
        return None;
    }

    let key = decode_hex(owner_token)?;
    let challenge = challenge.to_ascii_lowercase();
    let message = format!(
        "{OWNER_PROOF_DOMAIN}\0{challenge}\0{pid}\0{}",
        if tmux_healthy { '1' } else { '0' }
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(message.as_bytes());
    let proof = encode_hex(&mac.finalize().into_bytes());
    Some(GatewayOwnerProof { pid, proof })
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let high = hex_nibble(chunk[0])?;
            let low = hex_nibble(chunk[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_owner_proof_vector() {
        let proof = create_gateway_owner_proof(
            Some("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
            Some("0123456789abcdef0123456789abcdef"),
            4242,
            true,
        )
        .expect("valid proof inputs");

        assert_eq!(proof.pid, 4242);
        assert_eq!(
            proof.proof,
            "c44ae823d1d72a8b487080d4dae68095a40f652f3ace28aceb78ffcd29cd675f"
        );
    }
}
