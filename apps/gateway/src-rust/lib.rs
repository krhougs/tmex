//! Tokio Gateway library and embedding API.
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

pub mod agent;
pub mod config;
pub mod crypto;
pub mod database;
pub mod entity;
pub mod events;
pub mod files;
pub mod http;
pub mod i18n;
pub mod ipc;
pub mod lifecycle;
pub mod llm;
pub mod push;
pub mod runtime;
pub mod server;
pub mod state;
pub mod system;
pub mod telegram;
pub mod tmux;
pub mod watch;
pub mod weixin;
pub mod ws;
