use std::fmt;

use tmex_protocol::{ProtocolError, ProtocolErrorCode};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionProtocolError {
    pub code: ProtocolErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl SessionProtocolError {
    pub fn new(code: ProtocolErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn invalid_frame(message: impl Into<String>) -> Self {
        Self::new(ProtocolErrorCode::InvalidFrame, message, false)
    }

    pub fn frame_too_large(actual: usize, maximum: usize) -> Self {
        Self::new(
            ProtocolErrorCode::FrameTooLarge,
            format!("Frame exceeds maximum size: {actual} > {maximum}"),
            false,
        )
    }

    pub fn payload_decode(message: impl Into<String>) -> Self {
        Self::new(ProtocolErrorCode::PayloadDecodeFailed, message, false)
    }
}

impl fmt::Display for SessionProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionProtocolError {}

impl From<ProtocolError> for SessionProtocolError {
    fn from(error: ProtocolError) -> Self {
        match error {
            ProtocolError::UnsupportedProtocol(version) => Self::new(
                ProtocolErrorCode::UnsupportedProtocol,
                format!("Unsupported protocol version: {version}"),
                false,
            ),
            ProtocolError::InvalidFrame(message) => Self::invalid_frame(message),
            ProtocolError::PayloadDecode(message) => Self::payload_decode(message),
            ProtocolError::UnknownKind(kind) => Self::new(
                ProtocolErrorCode::UnknownKind,
                format!("Unknown kind: {kind}"),
                false,
            ),
            ProtocolError::FrameTooLarge { actual, maximum } => {
                Self::frame_too_large(actual, maximum)
            }
        }
    }
}
