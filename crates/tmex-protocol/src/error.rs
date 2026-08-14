use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum ProtocolErrorCode {
    UnsupportedProtocol = 1001,
    InvalidFrame = 1002,
    UnknownKind = 1003,
    PayloadDecodeFailed = 1004,
    FrameTooLarge = 1005,
    DeviceNotFound = 1101,
    DeviceConnectFailed = 1102,
    TmuxTargetNotFound = 1201,
    TmuxNotReady = 1202,
    SelectConflict = 1301,
    SelectTokenMismatch = 1302,
    Internal = 1401,
}

impl ProtocolErrorCode {
    pub const fn message(self) -> &'static str {
        match self {
            Self::UnsupportedProtocol => "Unsupported protocol version",
            Self::InvalidFrame => "Invalid frame format",
            Self::UnknownKind => "Unknown message kind",
            Self::PayloadDecodeFailed => "Failed to decode payload",
            Self::FrameTooLarge => "Frame exceeds maximum size",
            Self::DeviceNotFound => "Device not found",
            Self::DeviceConnectFailed => "Failed to connect device",
            Self::TmuxTargetNotFound => "Tmux target not found",
            Self::TmuxNotReady => "Tmux not ready",
            Self::SelectConflict => "Select conflict",
            Self::SelectTokenMismatch => "Select token mismatch",
            Self::Internal => "Internal server error",
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported protocol version: {0}")]
    UnsupportedProtocol(u16),
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
    #[error("payload decode failed: {0}")]
    PayloadDecode(String),
    #[error("unknown message kind: 0x{0:04x}")]
    UnknownKind(u16),
    #[error("frame exceeds maximum size: {actual} > {maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
}

impl ProtocolError {
    pub const fn code(&self) -> ProtocolErrorCode {
        match self {
            Self::UnsupportedProtocol(_) => ProtocolErrorCode::UnsupportedProtocol,
            Self::InvalidFrame(_) => ProtocolErrorCode::InvalidFrame,
            Self::PayloadDecode(_) => ProtocolErrorCode::PayloadDecodeFailed,
            Self::UnknownKind(_) => ProtocolErrorCode::UnknownKind,
            Self::FrameTooLarge { .. } => ProtocolErrorCode::FrameTooLarge,
        }
    }
}
