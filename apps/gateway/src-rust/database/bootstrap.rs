use tmex_db::{Database, DbConfig};

use super::{
    run_gateway_migrations, run_legacy_drizzle_migrations, GatewayMigrationError,
    LegacyMigrationError,
};

#[derive(Debug, thiserror::Error)]
pub enum DatabaseBootstrapError {
    #[error("failed to open the Gateway database: {0}")]
    Open(#[source] tmex_db::DbError),
    #[error(transparent)]
    Legacy(#[from] LegacyMigrationError),
    #[error(transparent)]
    Gateway(#[from] GatewayMigrationError),
    #[error("database close failed while recovering from {bootstrap}: {close}")]
    CloseAfterFailure {
        bootstrap: Box<DatabaseBootstrapError>,
        close: tmex_db::DbError,
    },
}

#[derive(Clone, Debug)]
pub struct DatabaseBootstrap {
    config: DbConfig,
}

impl DatabaseBootstrap {
    pub fn new(config: DbConfig) -> Self {
        Self { config }
    }

    pub async fn run(self) -> Result<Database, DatabaseBootstrapError> {
        let database = Database::open(self.config)
            .await
            .map_err(DatabaseBootstrapError::Open)?;
        if let Err(error) = run_legacy_drizzle_migrations(&database).await {
            return Err(close_after_failure(database, error.into()).await);
        }
        if let Err(error) = run_gateway_migrations(&database).await {
            return Err(close_after_failure(database, error.into()).await);
        }
        Ok(database)
    }
}

async fn close_after_failure(
    database: Database,
    bootstrap: DatabaseBootstrapError,
) -> DatabaseBootstrapError {
    match database.close().await {
        Ok(()) => bootstrap,
        Err(close) => DatabaseBootstrapError::CloseAfterFailure {
            bootstrap: Box::new(bootstrap),
            close,
        },
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{DbBackend, Statement, Value};

    use super::*;

    #[tokio::test]
    async fn owns_the_complete_database_initialization_sequence() {
        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .expect("bootstrap database");

        let rows = database
            .query(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM __drizzle_migrations",
            ))
            .await
            .expect("query legacy journal");
        assert_eq!(rows[0].values.get("count"), Some(&Value::BigInt(Some(18))));

        let rows = database
            .query(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM tmex_gateway_migrations",
            ))
            .await
            .expect("query Gateway journal");
        assert_eq!(rows[0].values.get("count"), Some(&Value::BigInt(Some(0))));
    }
}
