use sea_orm::{DbBackend, Statement, Value};

use crate::{Database, DbError, DbTransaction};

#[derive(Clone, Copy)]
pub struct CompiledMigration {
    pub version: i64,
    pub name: &'static str,
    pub statements: fn() -> Vec<Statement>,
}

impl std::fmt::Debug for CompiledMigration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompiledMigration")
            .field("version", &self.version)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MigrationSet {
    pub journal_table: &'static str,
    pub migrations: &'static [CompiledMigration],
}

impl MigrationSet {
    pub const fn new(
        journal_table: &'static str,
        migrations: &'static [CompiledMigration],
    ) -> Self {
        Self {
            journal_table,
            migrations,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("compiled migration journal table name is invalid: {0}")]
    InvalidJournalTable(&'static str),
    #[error("compiled migrations are not strictly ordered at {name}")]
    InvalidRegistry { name: &'static str },
    #[error("migration database operation failed: {0}")]
    Database(#[from] DbError),
    #[error("database contains unknown migration version {version} ({name}) in {journal_table}")]
    UnknownApplied {
        journal_table: &'static str,
        version: i64,
        name: String,
    },
    #[error(
        "migration journal {journal_table} is not a continuous registry prefix: expected version {expected_version} ({expected_name}), found version {actual_version} ({actual_name})"
    )]
    NonPrefixApplied {
        journal_table: &'static str,
        expected_version: i64,
        expected_name: &'static str,
        actual_version: i64,
        actual_name: String,
    },
    #[error("compiled migration {name} statement {statement_index} failed: {source}")]
    Apply {
        name: &'static str,
        statement_index: usize,
        #[source]
        source: DbError,
    },
    #[error("compiled migration rollback failed after {apply_error}: {rollback_error}")]
    Rollback {
        apply_error: String,
        #[source]
        rollback_error: DbError,
    },
    #[error("compiled migration commit failed: {0}")]
    Commit(#[source] DbError),
}

pub async fn run_compiled_migrations(
    database: &Database,
    set: MigrationSet,
) -> Result<(), MigrationError> {
    validate_set(set)?;
    let table = quote_identifier(set.journal_table)?;
    database
        .execute(sql(format!(
            "CREATE TABLE IF NOT EXISTS {table} (\
                version INTEGER PRIMARY KEY NOT NULL, \
                name TEXT NOT NULL UNIQUE, \
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
            )"
        )))
        .await?;
    validate_applied(database, set, &table).await?;

    let latest = latest_applied_version(database, &table).await?;
    let pending = set
        .migrations
        .iter()
        .filter(|migration| migration.version > latest)
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(());
    }

    let transaction = database.begin().await?;
    if let Err(error) = apply_pending(&transaction, &pending, &table).await {
        let apply_error = error.to_string();
        return match transaction.rollback().await {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(MigrationError::Rollback {
                apply_error,
                rollback_error,
            }),
        };
    }
    transaction.commit().await.map_err(MigrationError::Commit)
}

fn validate_set(set: MigrationSet) -> Result<(), MigrationError> {
    quote_identifier(set.journal_table)?;
    let mut previous = 0;
    for migration in set.migrations {
        if migration.version <= previous || migration.name.is_empty() {
            return Err(MigrationError::InvalidRegistry {
                name: migration.name,
            });
        }
        previous = migration.version;
    }
    Ok(())
}

async fn validate_applied(
    database: &Database,
    set: MigrationSet,
    table: &str,
) -> Result<(), MigrationError> {
    let rows = database
        .query(sql(format!(
            "SELECT version, name FROM {table} ORDER BY version"
        )))
        .await?;
    for (index, mut row) in rows.into_iter().enumerate() {
        let version = match row.values.remove("version") {
            Some(Value::BigInt(Some(value))) => value,
            Some(Value::Int(Some(value))) => i64::from(value),
            value => {
                return Err(MigrationError::Database(DbError::UnsupportedValue(
                    format!("invalid applied migration version: {value:?}"),
                )))
            }
        };
        let name = match row.values.remove("name") {
            Some(Value::String(Some(value))) => *value,
            value => {
                return Err(MigrationError::Database(DbError::UnsupportedValue(
                    format!("invalid applied migration name: {value:?}"),
                )))
            }
        };
        if !set
            .migrations
            .iter()
            .any(|migration| migration.version == version && migration.name == name)
        {
            return Err(MigrationError::UnknownApplied {
                journal_table: set.journal_table,
                version,
                name,
            });
        }
        let Some(expected) = set.migrations.get(index) else {
            return Err(MigrationError::UnknownApplied {
                journal_table: set.journal_table,
                version,
                name,
            });
        };
        if expected.version != version || expected.name != name {
            return Err(MigrationError::NonPrefixApplied {
                journal_table: set.journal_table,
                expected_version: expected.version,
                expected_name: expected.name,
                actual_version: version,
                actual_name: name,
            });
        }
    }
    Ok(())
}

async fn latest_applied_version(database: &Database, table: &str) -> Result<i64, MigrationError> {
    let mut rows = database
        .query(sql(format!(
            "SELECT CAST(COALESCE(MAX(version), 0) AS INTEGER) AS version FROM {table}"
        )))
        .await?;
    match rows.pop().and_then(|mut row| row.values.remove("version")) {
        Some(Value::BigInt(Some(value))) => Ok(value),
        value => Err(MigrationError::Database(DbError::UnsupportedValue(
            format!("invalid latest migration version: {value:?}"),
        ))),
    }
}

async fn apply_pending(
    transaction: &DbTransaction,
    pending: &[&CompiledMigration],
    table: &str,
) -> Result<(), MigrationError> {
    for migration in pending {
        let statements = (migration.statements)();
        let statement_count = statements.len();
        for (statement_index, statement) in statements.into_iter().enumerate() {
            transaction
                .execute(statement)
                .await
                .map_err(|source| MigrationError::Apply {
                    name: migration.name,
                    statement_index,
                    source,
                })?;
        }
        transaction
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                format!("INSERT INTO {table} (version, name) VALUES (?, ?)"),
                [
                    Value::BigInt(Some(migration.version)),
                    Value::String(Some(Box::new(migration.name.to_owned()))),
                ],
            ))
            .await
            .map_err(|source| MigrationError::Apply {
                name: migration.name,
                statement_index: statement_count,
                source,
            })?;
    }
    Ok(())
}

fn quote_identifier(value: &'static str) -> Result<String, MigrationError> {
    let mut bytes = value.bytes();
    let valid = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if !valid {
        return Err(MigrationError::InvalidJournalTable(value));
    }
    Ok(format!("\"{value}\""))
}

fn sql(value: impl Into<String>) -> Statement {
    Statement::from_string(DbBackend::Sqlite, value)
}
