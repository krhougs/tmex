use tmex_db::{run_compiled_migrations, Database, MigrationSet};
pub use tmex_db::{CompiledMigration as GatewayMigration, MigrationError as GatewayMigrationError};

pub static GATEWAY_MIGRATIONS: [GatewayMigration; 0] = [];

const GATEWAY_MIGRATION_SET: MigrationSet =
    MigrationSet::new("tmex_gateway_migrations", &GATEWAY_MIGRATIONS);

pub async fn run_gateway_migrations(database: &Database) -> Result<(), GatewayMigrationError> {
    run_compiled_migrations(database, GATEWAY_MIGRATION_SET).await
}
