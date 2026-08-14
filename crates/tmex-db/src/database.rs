use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use sea_orm::{ProxyExecResult, ProxyRow, Statement};
use tokio::runtime::Handle;
use tokio::sync::{oneshot, Mutex, OwnedMutexGuard};

use crate::actor::{ActorClient, RequestScope};
use crate::{DbConfig, DbError, OrmSession};

#[derive(Clone)]
pub struct Database {
    actor: ActorClient,
    gate: Arc<Mutex<()>>,
    orm: OrmSession,
    next_transaction_id: Arc<AtomicU64>,
}

impl Database {
    pub async fn open(config: DbConfig) -> Result<Self, DbError> {
        if config.command_capacity == 0 {
            return Err(DbError::InvalidCommandCapacity);
        }
        let runtime = Handle::try_current().map_err(|_| DbError::MissingTokioRuntime)?;
        prepare_database_files(&config.path)?;
        let path = config
            .path
            .to_str()
            .ok_or_else(|| DbError::InvalidDatabasePath(config.path.clone()))?;
        let database = turso::Builder::new_local(path)
            .build()
            .await
            .map_err(|error| DbError::turso("failed to open database", error))?;
        let connection = database
            .connect()
            .map_err(|error| DbError::turso("failed to connect database", error))?;
        connection
            .busy_timeout(config.busy_timeout)
            .map_err(|error| DbError::turso("failed to configure busy timeout", error))?;
        connection
            .pragma_update("foreign_keys", "ON")
            .await
            .map_err(|error| DbError::turso("failed to enable foreign keys", error))?;
        connection
            .pragma_update("journal_mode", "WAL")
            .await
            .map_err(|error| DbError::turso("failed to enable WAL", error))?;
        connection
            .pragma_update("synchronous", "NORMAL")
            .await
            .map_err(|error| DbError::turso("failed to configure synchronous mode", error))?;
        secure_existing_database_files(&config.path)?;

        let actor = ActorClient::spawn(&runtime, database, connection, config.command_capacity);
        let gate = Arc::new(Mutex::new(()));
        let orm = OrmSession::ordinary(actor.clone(), gate.clone()).await?;
        Ok(Self {
            actor,
            gate,
            orm,
            next_transaction_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn orm(&self) -> &OrmSession {
        &self.orm
    }

    pub async fn execute(&self, statement: Statement) -> Result<ProxyExecResult, DbError> {
        let _gate = self.gate.lock().await;
        self.actor.execute(RequestScope::Ordinary, statement).await
    }

    pub async fn query(&self, statement: Statement) -> Result<Vec<ProxyRow>, DbError> {
        let _gate = self.gate.lock().await;
        self.actor.query(RequestScope::Ordinary, statement).await
    }

    pub async fn ping(&self) -> Result<(), DbError> {
        let _gate = self.gate.lock().await;
        self.actor.ping(RequestScope::Ordinary).await
    }

    pub fn close(self) -> impl Future<Output = Result<(), DbError>> + Send + 'static {
        let response = match Handle::try_current() {
            Ok(runtime) => match self.actor.start_shutdown() {
                Ok(()) => {
                    let (reply, response) = oneshot::channel();
                    runtime.spawn(async move {
                        let gate = self.gate.clone().lock_owned().await;
                        let result = self.actor.shutdown().await;
                        drop(gate);
                        drop(self);
                        let _ = reply.send(result);
                    });
                    Ok(response)
                }
                Err(error) => Err(error),
            },
            Err(_) => Err(DbError::MissingTokioRuntime),
        };

        async move {
            let response = response?;
            response.await.map_err(|_| DbError::ActorResponseDropped)?
        }
    }

    pub async fn begin(&self) -> Result<DbTransaction, DbError> {
        let gate = self.gate.clone().lock_owned().await;
        let transaction_id = self.next_transaction_id.fetch_add(1, Ordering::Relaxed);
        if transaction_id == 0 {
            drop(gate);
            return Err(DbError::ValueOutOfRange {
                target: "transaction id",
                value: transaction_id.to_string(),
            });
        }

        let session = OrmSession::transaction(self.actor.clone(), transaction_id).await?;
        let mut lease = TransactionLease::new(self.actor.clone(), transaction_id, gate);
        match self.actor.begin(transaction_id).await {
            Ok(()) => Ok(DbTransaction {
                session,
                lease: Some(lease),
            }),
            Err(error) => {
                lease.disarm();
                Err(error)
            }
        }
    }
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    value.into()
}

#[cfg(unix)]
fn prepare_database_files(path: &Path) -> Result<(), DbError> {
    if path == Path::new(":memory:") {
        return Ok(());
    }
    secure_database_file(path, true)?;
    secure_database_file(&sqlite_sidecar_path(path, "-wal"), true)?;
    for suffix in ["-shm", "-tshm", "-journal"] {
        secure_database_file(&sqlite_sidecar_path(path, suffix), false)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn prepare_database_files(_path: &Path) -> Result<(), DbError> {
    Ok(())
}

#[cfg(unix)]
fn secure_existing_database_files(path: &Path) -> Result<(), DbError> {
    if path == Path::new(":memory:") {
        return Ok(());
    }
    secure_database_file(path, false)?;
    for suffix in ["-wal", "-shm", "-tshm", "-journal"] {
        secure_database_file(&sqlite_sidecar_path(path, suffix), false)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_existing_database_files(_path: &Path) -> Result<(), DbError> {
    Ok(())
}

#[cfg(unix)]
fn secure_database_file(path: &Path, create_if_missing: bool) -> Result<(), DbError> {
    use std::fs::{self, OpenOptions, Permissions};
    use std::io::ErrorKind;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err(DbError::InvalidDatabaseFileType {
                    path: path.to_owned(),
                });
            }
            fs::set_permissions(path, Permissions::from_mode(0o600)).map_err(|source| {
                DbError::DatabaseFileIo {
                    operation: "secure",
                    path: path.to_owned(),
                    source,
                }
            })
        }
        Err(source) if source.kind() == ErrorKind::NotFound && !create_if_missing => Ok(()),
        Err(source) if source.kind() == ErrorKind::NotFound => {
            match OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
            {
                Ok(_) => Ok(()),
                Err(source) if source.kind() == ErrorKind::AlreadyExists => {
                    secure_database_file(path, false)
                }
                Err(source) => Err(DbError::DatabaseFileIo {
                    operation: "create",
                    path: path.to_owned(),
                    source,
                }),
            }
        }
        Err(source) => Err(DbError::DatabaseFileIo {
            operation: "inspect",
            path: path.to_owned(),
            source,
        }),
    }
}

pub struct DbTransaction {
    session: OrmSession,
    lease: Option<TransactionLease>,
}

impl DbTransaction {
    pub fn orm(&self) -> &OrmSession {
        &self.session
    }

    pub async fn execute(&self, statement: Statement) -> Result<ProxyExecResult, DbError> {
        let lease = self.lease.as_ref().ok_or(DbError::ActorClosed)?;
        lease
            .actor
            .execute(RequestScope::Transaction(lease.transaction_id), statement)
            .await
    }

    pub async fn query(&self, statement: Statement) -> Result<Vec<ProxyRow>, DbError> {
        let lease = self.lease.as_ref().ok_or(DbError::ActorClosed)?;
        lease
            .actor
            .query(RequestScope::Transaction(lease.transaction_id), statement)
            .await
    }

    pub async fn commit(mut self) -> Result<(), DbError> {
        let lease = self.lease.as_ref().ok_or(DbError::ActorClosed)?;
        lease.actor.commit(lease.transaction_id).await?;
        if let Some(mut lease) = self.lease.take() {
            lease.disarm();
        }
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), DbError> {
        let lease = self.lease.as_ref().ok_or(DbError::ActorClosed)?;
        lease.actor.rollback(lease.transaction_id).await?;
        if let Some(mut lease) = self.lease.take() {
            lease.disarm();
        }
        Ok(())
    }
}

struct TransactionLease {
    actor: ActorClient,
    transaction_id: u64,
    gate: Option<OwnedMutexGuard<()>>,
}

impl TransactionLease {
    fn new(actor: ActorClient, transaction_id: u64, gate: OwnedMutexGuard<()>) -> Self {
        Self {
            actor,
            transaction_id,
            gate: Some(gate),
        }
    }

    fn disarm(&mut self) {
        self.gate.take();
    }
}

impl Drop for TransactionLease {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            self.actor.rollback_after_drop(self.transaction_id, gate);
        }
    }
}
