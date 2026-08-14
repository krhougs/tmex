use chrono::{DateTime, NaiveDate, Utc};
use sea_orm::{ConnectionTrait, DbBackend, Statement, Value};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{symlink, PermissionsExt};
use tmex_db::{
    run_compiled_migrations, CompiledMigration, Database, DbConfig, DbError, MigrationError,
    MigrationSet,
};
use uuid::Uuid;

fn statement(sql: &str) -> Statement {
    Statement::from_string(DbBackend::Sqlite, sql)
}

fn empty_migration() -> Vec<Statement> {
    Vec::new()
}

static GAP_MIGRATIONS: [CompiledMigration; 2] = [
    CompiledMigration {
        version: 1,
        name: "first",
        statements: empty_migration,
    },
    CompiledMigration {
        version: 2,
        name: "second",
        statements: empty_migration,
    },
];

async fn pragma(database: &Database, name: &str) -> Value {
    let mut rows = database
        .query(statement(&format!("PRAGMA {name}")))
        .await
        .unwrap();
    rows.pop()
        .and_then(|mut row| row.values.pop_first().map(|(_, value)| value))
        .unwrap()
}

#[tokio::test]
async fn applies_the_existing_gateway_sqlite_pragmas() {
    let database = Database::open(DbConfig::in_memory()).await.unwrap();

    assert_eq!(
        pragma(&database, "foreign_keys").await,
        Value::BigInt(Some(1))
    );
    assert_eq!(pragma(&database, "journal_mode").await, Value::from("wal"));
    assert_eq!(
        pragma(&database, "busy_timeout").await,
        Value::BigInt(Some(5_000))
    );
    assert_eq!(
        pragma(&database, "synchronous").await,
        Value::BigInt(Some(1))
    );
}

#[tokio::test]
async fn transaction_excludes_ordinary_requests_until_commit() {
    let database = Database::open(DbConfig::in_memory()).await.unwrap();
    database
        .execute(statement(
            "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)",
        ))
        .await
        .unwrap();

    let transaction = database.begin().await.unwrap();
    transaction
        .execute(statement(
            "INSERT INTO events (value) VALUES ('transaction')",
        ))
        .await
        .unwrap();

    let ordinary_database = database.clone();
    let ordinary = tokio::spawn(async move {
        ordinary_database
            .execute(statement("INSERT INTO events (value) VALUES ('ordinary')"))
            .await
    });
    tokio::task::yield_now().await;
    assert!(!ordinary.is_finished());

    transaction.commit().await.unwrap();
    ordinary.await.unwrap().unwrap();

    let rows = database
        .query(statement("SELECT value FROM events ORDER BY id"))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].values.get("value"),
        Some(&Value::from("transaction"))
    );
    assert_eq!(rows[1].values.get("value"), Some(&Value::from("ordinary")));
}

#[tokio::test]
async fn rollback_discards_transaction_writes() {
    let database = Database::open(DbConfig::in_memory()).await.unwrap();
    database
        .execute(statement("CREATE TABLE values_table (value TEXT NOT NULL)"))
        .await
        .unwrap();

    let transaction = database.begin().await.unwrap();
    transaction
        .execute(statement(
            "INSERT INTO values_table (value) VALUES ('discarded')",
        ))
        .await
        .unwrap();
    transaction.rollback().await.unwrap();

    let dropped_transaction = database.begin().await.unwrap();
    dropped_transaction
        .execute(statement(
            "INSERT INTO values_table (value) VALUES ('also discarded')",
        ))
        .await
        .unwrap();
    drop(dropped_transaction);

    let rows = database
        .query(statement("SELECT value FROM values_table"))
        .await
        .unwrap();
    assert!(rows.is_empty());
}

#[tokio::test]
async fn rejects_migration_journal_gaps() {
    let database = Database::open(DbConfig::in_memory()).await.unwrap();
    database
        .execute(statement(
            "CREATE TABLE migration_gap_journal (\
                version INTEGER PRIMARY KEY NOT NULL, \
                name TEXT NOT NULL UNIQUE, \
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
            )",
        ))
        .await
        .unwrap();
    database
        .execute(statement(
            "INSERT INTO migration_gap_journal (version, name) VALUES (2, 'second')",
        ))
        .await
        .unwrap();

    let result = run_compiled_migrations(
        &database,
        MigrationSet::new("migration_gap_journal", &GAP_MIGRATIONS),
    )
    .await;

    assert!(matches!(
        result,
        Err(MigrationError::NonPrefixApplied {
            expected_version: 1,
            actual_version: 2,
            ..
        })
    ));
}

#[tokio::test]
async fn seaorm_values_round_trip_and_report_last_insert_id() {
    let database = Database::open(DbConfig::in_memory()).await.unwrap();
    database
        .orm()
        .execute_unprepared(
            "CREATE TABLE round_trip (\
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                enabled BOOLEAN NOT NULL, \
                count INTEGER NOT NULL, \
                large_count BIGINT NOT NULL, \
                ratio REAL NOT NULL, \
                label TEXT NOT NULL, \
                payload BLOB NOT NULL, \
                json_value JSON_TEXT NOT NULL, \
                date_value DATE_TEXT NOT NULL, \
                datetime_value DATETIME_TEXT NOT NULL, \
                uuid_value UUID_TEXT NOT NULL, \
                optional TEXT NULL\
            )",
        )
        .await
        .unwrap();

    let json_value = serde_json::json!({"enabled": true, "count": 2});
    let date_value = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
    let datetime_value = DateTime::parse_from_rfc3339("2026-08-12T03:04:05.678Z")
        .unwrap()
        .with_timezone(&Utc);
    let uuid_value = Uuid::parse_str("4f9f75ca-1f46-4baa-8420-850917bcc26f").unwrap();

    let insert = Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO round_trip \
            (enabled, count, large_count, ratio, label, payload, json_value, date_value, \
             datetime_value, uuid_value, optional) \
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            true.into(),
            20_260_715_000_001i64.into(),
            5_000_000_000i64.into(),
            1.25f64.into(),
            "hello".into(),
            vec![0u8, 1, 2, 255].into(),
            json_value.clone().into(),
            date_value.into(),
            datetime_value.into(),
            uuid_value.into(),
            Value::String(None),
        ],
    );
    let result = database.orm().execute(insert).await.unwrap();
    assert_eq!(result.rows_affected(), 1);
    assert_eq!(result.last_insert_id(), 1);

    let row = database
        .orm()
        .query_one(statement(
            "SELECT enabled, count, large_count, ratio, label, payload, json_value, date_value, \
                    datetime_value, uuid_value, optional \
             FROM round_trip WHERE id = 1",
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(row.try_get_by::<bool, _>("enabled").unwrap());
    assert_eq!(
        row.try_get_by::<i64, _>("count").unwrap(),
        20_260_715_000_001
    );
    assert_eq!(
        row.try_get_by::<i64, _>("large_count").unwrap(),
        5_000_000_000
    );
    assert_eq!(row.try_get_by::<f64, _>("ratio").unwrap(), 1.25);
    assert_eq!(row.try_get_by::<String, _>("label").unwrap(), "hello");
    assert_eq!(
        row.try_get_by::<Vec<u8>, _>("payload").unwrap(),
        vec![0, 1, 2, 255]
    );
    assert_eq!(
        row.try_get_by::<serde_json::Value, _>("json_value")
            .unwrap(),
        json_value
    );
    assert_eq!(
        row.try_get_by::<NaiveDate, _>("date_value").unwrap(),
        date_value
    );
    assert_eq!(
        row.try_get_by::<DateTime<Utc>, _>("datetime_value")
            .unwrap(),
        datetime_value
    );
    assert_eq!(row.try_get_by::<Uuid, _>("uuid_value").unwrap(), uuid_value);
    assert_eq!(
        row.try_get_by::<Option<String>, _>("optional").unwrap(),
        None
    );
}

#[tokio::test]
async fn close_invalidates_clones_and_releases_the_on_disk_database() {
    let source_dir = std::env::temp_dir().join(format!("tmex-db-close-{}", Uuid::new_v4()));
    let moved_dir = source_dir.with_extension("moved");
    fs::create_dir(&source_dir).unwrap();
    let database_name = "database.sqlite3";
    let source_path = source_dir.join(database_name);

    let database = Database::open(DbConfig::new(&source_path)).await.unwrap();
    let clone = database.clone();
    database
        .execute(statement("CREATE TABLE close_test (value TEXT NOT NULL)"))
        .await
        .unwrap();
    let transaction = database.begin().await.unwrap();
    transaction
        .execute(statement(
            "INSERT INTO close_test (value) VALUES ('preserved')",
        ))
        .await
        .unwrap();

    let close = tokio::spawn(database.close());
    tokio::task::yield_now().await;
    assert!(!close.is_finished());
    transaction.commit().await.unwrap();
    close.await.unwrap().unwrap();
    assert!(matches!(clone.ping().await, Err(DbError::ActorClosed)));

    fs::rename(&source_dir, &moved_dir).unwrap();
    let reopened = Database::open(DbConfig::new(moved_dir.join(database_name)))
        .await
        .unwrap();
    let rows = reopened
        .query(statement("SELECT value FROM close_test"))
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].values.get("value"), Some(&Value::from("preserved")));

    reopened.close().await.unwrap();
    fs::remove_dir_all(moved_dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn on_disk_database_files_are_owner_only_and_symlinks_fail_closed() {
    let database_dir = std::env::temp_dir().join(format!("tmex-db-permissions-{}", Uuid::new_v4()));
    fs::create_dir(&database_dir).unwrap();
    let database_path = database_dir.join("database.sqlite3");
    let wal_path = database_dir.join("database.sqlite3-wal");
    for path in [&database_path, &wal_path] {
        fs::File::create(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o666)).unwrap();
    }

    let database = Database::open(DbConfig::new(&database_path)).await.unwrap();
    database
        .execute(statement(
            "CREATE TABLE permissions_test (value TEXT NOT NULL)",
        ))
        .await
        .unwrap();
    for path in [&database_path, &wal_path] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    database.close().await.unwrap();

    let target = database_dir.join("target.sqlite3");
    fs::File::create(&target).unwrap();
    let symlink_path = database_dir.join("symlink.sqlite3");
    symlink(&target, &symlink_path).unwrap();
    assert!(matches!(
        Database::open(DbConfig::new(&symlink_path)).await,
        Err(DbError::InvalidDatabaseFileType { path }) if path == symlink_path
    ));

    fs::remove_dir_all(database_dir).unwrap();
}
