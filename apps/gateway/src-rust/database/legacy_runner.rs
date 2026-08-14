use sea_orm::{DbBackend, Statement, Value};
use tmex_db::{Database, DbError, DbTransaction};

use super::{LegacyDrizzleMigration, LEGACY_DRIZZLE_MIGRATIONS};

const CREATE_JOURNAL: &str = r#"CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)"#;

#[derive(Debug, thiserror::Error)]
pub enum LegacyMigrationError {
    #[error("legacy Drizzle database operation failed: {0}")]
    Database(#[from] DbError),
    #[error("legacy Drizzle journal returned an invalid latest created_at value: {0:?}")]
    InvalidLatestWhen(Option<Value>),
    #[error("legacy Drizzle migration {tag} statement {statement_index} failed: {source}")]
    Apply {
        tag: &'static str,
        statement_index: usize,
        #[source]
        source: DbError,
    },
    #[error("legacy Drizzle migration rollback failed after {apply_error}: {rollback_error}")]
    Rollback {
        apply_error: String,
        #[source]
        rollback_error: DbError,
    },
    #[error("legacy Drizzle migration commit failed: {0}")]
    Commit(#[source] DbError),
}

pub async fn run_legacy_drizzle_migrations(
    database: &Database,
) -> Result<(), LegacyMigrationError> {
    run_migrations(database, LEGACY_DRIZZLE_MIGRATIONS).await
}

async fn run_migrations(
    database: &Database,
    migrations: &[LegacyDrizzleMigration],
) -> Result<(), LegacyMigrationError> {
    database.execute(sql(CREATE_JOURNAL)).await?;

    let latest_when = latest_applied_when(database).await?;
    let pending = migrations
        .iter()
        .filter(|migration| migration.when > latest_when)
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(());
    }

    let transaction = database.begin().await?;
    if let Err(error) = apply_pending(&transaction, &pending).await {
        let apply_error = error.to_string();
        return match transaction.rollback().await {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(LegacyMigrationError::Rollback {
                apply_error,
                rollback_error,
            }),
        };
    }
    transaction
        .commit()
        .await
        .map_err(LegacyMigrationError::Commit)
}

async fn latest_applied_when(database: &Database) -> Result<i64, LegacyMigrationError> {
    let mut rows = database
        .query(sql(
            "SELECT CAST(COALESCE(MAX(created_at), 0) AS INTEGER) AS latest_when \
             FROM __drizzle_migrations",
        ))
        .await?;
    let value = rows
        .pop()
        .and_then(|mut row| row.values.remove("latest_when"));
    match value {
        Some(Value::BigInt(Some(value))) => Ok(value),
        Some(Value::Int(Some(value))) => Ok(i64::from(value)),
        Some(Value::SmallInt(Some(value))) => Ok(i64::from(value)),
        Some(Value::TinyInt(Some(value))) => Ok(i64::from(value)),
        value => Err(LegacyMigrationError::InvalidLatestWhen(value)),
    }
}

async fn apply_pending(
    transaction: &DbTransaction,
    pending: &[&LegacyDrizzleMigration],
) -> Result<(), LegacyMigrationError> {
    for migration in pending {
        for (statement_index, statement) in migration.statements.iter().enumerate() {
            transaction
                .execute(sql(*statement))
                .await
                .map_err(|source| LegacyMigrationError::Apply {
                    tag: migration.tag,
                    statement_index,
                    source,
                })?;
        }

        let insert = Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
            [
                Value::from(migration.hash),
                Value::BigInt(Some(migration.when)),
            ],
        );
        transaction
            .execute(insert)
            .await
            .map_err(|source| LegacyMigrationError::Apply {
                tag: migration.tag,
                statement_index: migration.statements.len(),
                source,
            })?;
    }
    Ok(())
}

fn sql(value: impl Into<String>) -> Statement {
    Statement::from_string(DbBackend::Sqlite, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tmex_db::DbConfig;

    async fn scalar_i64(database: &Database, query: &str) -> i64 {
        let mut rows = database.query(sql(query)).await.expect("query scalar");
        match rows
            .pop()
            .and_then(|mut row| row.values.pop_first().map(|(_, value)| value))
        {
            Some(Value::BigInt(Some(value))) => value,
            value => panic!("unexpected scalar value: {value:?}"),
        }
    }

    #[tokio::test]
    async fn upgrades_fresh_and_partial_databases_without_runtime_files() {
        let fresh = Database::open(DbConfig::in_memory())
            .await
            .expect("open fresh database");
        run_legacy_drizzle_migrations(&fresh)
            .await
            .expect("migrate fresh database");
        assert_eq!(
            scalar_i64(&fresh, "SELECT COUNT(*) FROM __drizzle_migrations").await,
            18
        );
        assert_eq!(
            scalar_i64(
                &fresh,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'watch_rules'"
            )
            .await,
            1
        );
        run_legacy_drizzle_migrations(&fresh)
            .await
            .expect("repeat fresh migration");
        assert_eq!(
            scalar_i64(&fresh, "SELECT COUNT(*) FROM __drizzle_migrations").await,
            18
        );

        for (migration_count, era) in [(8, "0007"), (12, "0011"), (16, "0015"), (18, "0017")] {
            let partial = Database::open(DbConfig::in_memory())
                .await
                .unwrap_or_else(|error| panic!("open {era}-era database: {error}"));
            run_migrations(&partial, &LEGACY_DRIZZLE_MIGRATIONS[..migration_count])
                .await
                .unwrap_or_else(|error| panic!("build {era}-era database: {error}"));
            partial
                .execute(sql(format!(
                    "INSERT INTO devices \
                     (id, name, type, auth_mode, created_at, updated_at) \
                     VALUES ('historical-{era}', 'historical', 'local', 'auto', 'before', 'before')"
                )))
                .await
                .unwrap_or_else(|error| panic!("seed {era}-era data: {error}"));
            assert_eq!(
                scalar_i64(&partial, "SELECT COUNT(*) FROM __drizzle_migrations").await,
                migration_count as i64
            );

            run_legacy_drizzle_migrations(&partial)
                .await
                .unwrap_or_else(|error| panic!("upgrade {era}-era database: {error}"));

            assert_eq!(
                scalar_i64(&partial, "SELECT COUNT(*) FROM __drizzle_migrations").await,
                18
            );
            assert_eq!(
                scalar_i64(
                    &partial,
                    &format!(
                        "SELECT COUNT(*) FROM devices WHERE id = 'historical-{era}' \
                         AND default_working_dir IS NULL"
                    )
                )
                .await,
                1
            );
            assert_eq!(
                scalar_i64(
                    &partial,
                    "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type = 'table' AND name IN ('weixin_accounts', 'gateway_kv')"
                )
                .await,
                2
            );
        }
    }

    #[tokio::test]
    async fn rolls_back_the_whole_pending_batch_on_statement_failure() {
        let database = Database::open(DbConfig::in_memory())
            .await
            .expect("open database");
        let bad = [LegacyDrizzleMigration {
            idx: 0,
            version: "6",
            when: 1,
            tag: "bad",
            hash: "bad",
            sql: "CREATE TABLE durable (id INTEGER);broken SQL",
            statements: &["CREATE TABLE durable (id INTEGER)", "broken SQL"],
        }];

        assert!(run_migrations(&database, &bad).await.is_err());
        assert_eq!(
            scalar_i64(
                &database,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'durable'"
            )
            .await,
            0
        );
        assert_eq!(
            scalar_i64(&database, "SELECT COUNT(*) FROM __drizzle_migrations").await,
            0
        );
    }
}
