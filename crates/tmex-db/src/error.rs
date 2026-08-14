use std::path::PathBuf;

use sea_orm::DbErr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database command capacity must be greater than zero")]
    InvalidCommandCapacity,
    #[error("database path is not valid UTF-8: {path}", path = .0.display())]
    InvalidDatabasePath(PathBuf),
    #[error("database path is not a regular file: {path}", path = .path.display())]
    InvalidDatabaseFileType { path: PathBuf },
    #[error("failed to {operation} database file {path}: {source}", path = .path.display())]
    DatabaseFileIo {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("tmex-db requires a Tokio runtime")]
    MissingTokioRuntime,
    #[error("{context}: {source}")]
    Turso {
        context: &'static str,
        #[source]
        source: turso::Error,
    },
    #[error("SeaORM proxy setup failed: {0}")]
    SeaOrm(#[source] DbErr),
    #[error("database actor is closed")]
    ActorClosed,
    #[error("database actor dropped a response")]
    ActorResponseDropped,
    #[error("database actor panicked")]
    ActorPanicked,
    #[error("only SQLite SeaORM statements are supported")]
    UnsupportedBackend,
    #[error("unsupported SeaORM value: {0}")]
    UnsupportedValue(String),
    #[error("SeaORM value {value} does not fit {target}")]
    ValueOutOfRange { target: &'static str, value: String },
    #[error("duplicate result column name `{0}` is unsupported by SeaORM ProxyRow")]
    DuplicateColumn(String),
    #[error("invalid value for column `{column}` ({declared_type}): {message}")]
    InvalidColumnValue {
        column: String,
        declared_type: String,
        message: String,
    },
    #[error("a database transaction is already active")]
    TransactionAlreadyActive,
    #[error("ordinary database request blocked by active transaction {0}")]
    TransactionBusy(u64),
    #[error("database transaction {0} is not active")]
    TransactionNotActive(u64),
    #[error("database transaction mismatch: active {active}, requested {requested}")]
    TransactionMismatch { active: u64, requested: u64 },
    #[error("SeaORM Proxy transaction hooks are unsupported; use Database::begin")]
    ProxyTransactionsUnsupported,
}

impl DbError {
    pub(crate) fn turso(context: &'static str, source: turso::Error) -> Self {
        Self::Turso { context, source }
    }
}
