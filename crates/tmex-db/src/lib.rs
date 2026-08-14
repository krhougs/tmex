//! Shared Turso and SeaORM runtime for tmex components.
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

mod actor;
mod config;
mod database;
mod error;
mod migration;
mod session;
mod value;

pub use config::DbConfig;
pub use database::{Database, DbTransaction};
pub use error::DbError;
pub use migration::{run_compiled_migrations, CompiledMigration, MigrationError, MigrationSet};
pub use sea_orm;
pub use session::OrmSession;
