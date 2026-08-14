//! Shared Gateway wire protocol types and codecs.
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

mod canonical;
mod envelope;
mod error;
mod kind;
mod legacy;

pub use canonical::*;
pub use envelope::{
    check_magic, decode_envelope, encode_envelope, Envelope, CURRENT_VERSION,
    DEFAULT_MAX_FRAME_BYTES, FLAG_ACK_REQUIRED, FLAG_IS_ACK, FLAG_IS_CHUNK, FLAG_IS_COMPRESSED,
    FLAG_IS_ERROR, MAGIC,
};
pub use error::{ProtocolError, ProtocolErrorCode};
pub use kind::MessageKind;
pub use legacy::*;
