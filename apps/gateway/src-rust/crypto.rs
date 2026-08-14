use std::fmt;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;

const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

#[derive(Clone)]
pub struct MasterKey([u8; KEY_BYTES]);

impl fmt::Debug for MasterKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MasterKey([REDACTED])")
    }
}

impl MasterKey {
    pub const fn development_default() -> Self {
        Self([0; KEY_BYTES])
    }

    pub fn from_base64(value: &str) -> Result<Self, CryptoError> {
        let decoded = decode_node_base64(value).map_err(CryptoError::InvalidBase64)?;
        let actual = decoded.len();
        let key = decoded
            .try_into()
            .map_err(|_| CryptoError::InvalidKeyLength { actual })?;
        Ok(Self(key))
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let mut iv = [0_u8; IV_BYTES];
        OsRng.fill_bytes(&mut iv);
        self.encrypt_with_iv(plaintext.as_bytes(), iv)
    }

    pub fn decrypt(&self, ciphertext: &str) -> Result<String, CryptoError> {
        let payload = decode_node_base64(ciphertext).map_err(CryptoError::InvalidBase64)?;
        if payload.len() < IV_BYTES + TAG_BYTES {
            return Err(CryptoError::CiphertextTooShort {
                actual: payload.len(),
            });
        }
        let (iv, encrypted) = payload.split_at(IV_BYTES);
        let cipher =
            Aes256Gcm::new_from_slice(&self.0).map_err(|_| CryptoError::InvalidKeyLength {
                actual: self.0.len(),
            })?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(iv), encrypted)
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        String::from_utf8(plaintext).map_err(CryptoError::InvalidUtf8)
    }

    pub fn decrypt_with_context(
        &self,
        ciphertext: &str,
        context: CryptoContext,
    ) -> Result<String, CryptoDecryptError> {
        self.decrypt(ciphertext)
            .map_err(|source| CryptoDecryptError { context, source })
    }

    fn encrypt_with_iv(&self, plaintext: &[u8], iv: [u8; IV_BYTES]) -> Result<String, CryptoError> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.0).map_err(|_| CryptoError::InvalidKeyLength {
                actual: self.0.len(),
            })?;
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&iv), plaintext)
            .map_err(|_| CryptoError::EncryptFailed)?;
        let mut payload = Vec::with_capacity(IV_BYTES + encrypted.len());
        payload.extend_from_slice(&iv);
        payload.extend_from_slice(&encrypted);
        Ok(STANDARD.encode(payload))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CryptoContext {
    pub scope: String,
    pub entity_id: Option<String>,
    pub field: Option<String>,
}

impl CryptoContext {
    pub fn new(scope: impl Into<String>) -> Self {
        Self {
            scope: scope.into(),
            entity_id: None,
            field: None,
        }
    }

    pub fn entity_id(mut self, value: impl Into<String>) -> Self {
        self.entity_id = Some(value.into());
        self
    }

    pub fn field(mut self, value: impl Into<String>) -> Self {
        self.field = Some(value.into());
        self
    }
}

impl fmt::Display for CryptoContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.scope)?;
        if let Some(entity_id) = &self.entity_id {
            write!(formatter, " id={entity_id}")?;
        }
        if let Some(field) = &self.field {
            write!(formatter, " field={field}")?;
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid base64: {0}")]
    InvalidBase64(base64::DecodeError),
    #[error("TMEX_MASTER_KEY must decode to exactly 32 bytes, got {actual}")]
    InvalidKeyLength { actual: usize },
    #[error("invalid ciphertext: expected at least 28 bytes, got {actual}")]
    CiphertextTooShort { actual: usize },
    #[error("AES-GCM encryption failed")]
    EncryptFailed,
    #[error("AES-GCM authentication failed")]
    AuthenticationFailed,
    #[error("decrypted value is not UTF-8: {0}")]
    InvalidUtf8(#[source] std::string::FromUtf8Error),
}

#[derive(Debug, thiserror::Error)]
#[error(
    "解密失败（{context}）。通常意味着 TMEX_MASTER_KEY 与数据库中的加密数据不匹配，或密文已损坏。原因：{source}"
)]
pub struct CryptoDecryptError {
    pub context: CryptoContext,
    #[source]
    pub source: CryptoError,
}

impl CryptoDecryptError {
    pub const CODE: &'static str = "crypto_decrypt_failed";
}

fn decode_node_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let compact = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let first_error = match STANDARD.decode(&compact) {
        Ok(decoded) => return Ok(decoded),
        Err(error) => error,
    };
    for engine in [STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD] {
        match engine.decode(&compact) {
            Ok(decoded) => return Ok(decoded),
            Err(_) => continue,
        }
    }
    Err(first_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_the_typescript_web_crypto_format() {
        let key = MasterKey::development_default();
        let plaintext = key
            .decrypt("AAECAwQFBgcICQoL/KZWKi0YCkUn1uv65d4zIL8kmca2F/84jnWa")
            .expect("decrypt TypeScript golden vector");
        assert_eq!(plaintext, "tmex-兼容");
    }

    #[test]
    fn encrypts_iv_ciphertext_and_tag_as_standard_base64() {
        let key = MasterKey::development_default();
        let ciphertext = key.encrypt("secret").expect("encrypt");
        let bytes = STANDARD.decode(ciphertext).expect("decode ciphertext");
        assert_eq!(bytes.len(), IV_BYTES + "secret".len() + TAG_BYTES);
        assert_eq!(
            key.decrypt(&STANDARD.encode(bytes)).expect("decrypt"),
            "secret"
        );
    }

    #[test]
    fn contextual_error_redacts_the_key_and_identifies_the_record() {
        let error = MasterKey::development_default()
            .decrypt_with_context(
                "AAAA",
                CryptoContext::new("telegram_bot")
                    .entity_id("bot-1")
                    .field("token_enc"),
            )
            .expect_err("invalid ciphertext");
        let message = error.to_string();
        assert_eq!(CryptoDecryptError::CODE, "crypto_decrypt_failed");
        assert!(message.contains("telegram_bot"));
        assert!(message.contains("bot-1"));
        assert!(message.contains("token_enc"));
        assert!(message.contains("TMEX_MASTER_KEY"));
        assert!(!message.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
    }
}
