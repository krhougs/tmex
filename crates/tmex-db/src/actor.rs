use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::FutureExt;
use sea_orm::{ProxyExecResult, ProxyRow, Statement};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot, watch, OwnedMutexGuard};

use crate::value::{row_to_proxy, statement_parts, ColumnMetadata};
use crate::DbError;

type Reply<T> = oneshot::Sender<Result<T, DbError>>;

#[derive(Clone, Copy, Debug)]
pub(crate) enum RequestScope {
    Ordinary,
    Transaction(u64),
}

enum Command {
    Query {
        scope: RequestScope,
        statement: Statement,
        reply: Reply<Vec<ProxyRow>>,
    },
    Execute {
        scope: RequestScope,
        statement: Statement,
        reply: Reply<ProxyExecResult>,
    },
    Ping {
        scope: RequestScope,
        reply: Reply<()>,
    },
    Begin {
        transaction_id: u64,
        reply: Reply<()>,
    },
    Commit {
        transaction_id: u64,
        reply: Reply<()>,
    },
    Rollback {
        transaction_id: u64,
        reply: Reply<()>,
    },
    Shutdown {
        reply: Reply<()>,
    },
    #[cfg(test)]
    Panic {
        started: oneshot::Sender<()>,
    },
}

struct DropRollback {
    transaction_id: u64,
    gate: OwnedMutexGuard<()>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActorState {
    Running,
    Stopped,
    Panicked,
}

impl Command {
    fn reject_closed(self) {
        match self {
            Self::Query { reply, .. } => {
                let _ = reply.send(Err(DbError::ActorClosed));
            }
            Self::Execute { reply, .. } => {
                let _ = reply.send(Err(DbError::ActorClosed));
            }
            Self::Ping { reply, .. }
            | Self::Begin { reply, .. }
            | Self::Commit { reply, .. }
            | Self::Rollback { reply, .. }
            | Self::Shutdown { reply } => {
                let _ = reply.send(Err(DbError::ActorClosed));
            }
            #[cfg(test)]
            Self::Panic { started } => {
                drop(started);
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct ActorClient {
    sender: mpsc::Sender<Command>,
    drop_rollbacks: mpsc::UnboundedSender<DropRollback>,
    stopped: watch::Receiver<ActorState>,
    closing: Arc<AtomicBool>,
}

impl ActorClient {
    pub(crate) fn spawn(
        runtime: &Handle,
        database: turso::Database,
        connection: turso::Connection,
        command_capacity: usize,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(command_capacity);
        let (drop_rollbacks, drop_rollback_receiver) = mpsc::unbounded_channel();
        let (stopped_sender, stopped) = watch::channel(ActorState::Running);
        runtime.spawn(async move {
            let result = AssertUnwindSafe(
                Actor {
                    _database: database,
                    connection,
                    receiver,
                    drop_rollbacks: drop_rollback_receiver,
                    active_transaction: None,
                }
                .run(),
            )
            .catch_unwind()
            .await;
            let state = if result.is_ok() {
                ActorState::Stopped
            } else {
                tracing::error!("database actor panicked");
                ActorState::Panicked
            };
            let _ = stopped_sender.send(state);
        });
        Self {
            sender,
            drop_rollbacks,
            stopped,
            closing: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) async fn query(
        &self,
        scope: RequestScope,
        statement: Statement,
    ) -> Result<Vec<ProxyRow>, DbError> {
        self.ensure_request_allowed(scope)?;
        let (reply, response) = oneshot::channel();
        self.send(Command::Query {
            scope,
            statement,
            reply,
        })
        .await?;
        self.receive(response).await
    }

    pub(crate) async fn execute(
        &self,
        scope: RequestScope,
        statement: Statement,
    ) -> Result<ProxyExecResult, DbError> {
        self.ensure_request_allowed(scope)?;
        let (reply, response) = oneshot::channel();
        self.send(Command::Execute {
            scope,
            statement,
            reply,
        })
        .await?;
        self.receive(response).await
    }

    pub(crate) async fn ping(&self, scope: RequestScope) -> Result<(), DbError> {
        self.ensure_request_allowed(scope)?;
        let (reply, response) = oneshot::channel();
        self.send(Command::Ping { scope, reply }).await?;
        self.receive(response).await
    }

    pub(crate) async fn begin(&self, transaction_id: u64) -> Result<(), DbError> {
        self.ensure_open()?;
        let (reply, response) = oneshot::channel();
        self.send(Command::Begin {
            transaction_id,
            reply,
        })
        .await?;
        self.receive(response).await
    }

    pub(crate) async fn commit(&self, transaction_id: u64) -> Result<(), DbError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Commit {
            transaction_id,
            reply,
        })
        .await?;
        self.receive(response).await
    }

    pub(crate) async fn rollback(&self, transaction_id: u64) -> Result<(), DbError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Rollback {
            transaction_id,
            reply,
        })
        .await?;
        self.receive(response).await
    }

    pub(crate) fn start_shutdown(&self) -> Result<(), DbError> {
        self.closing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| DbError::ActorClosed)
    }

    pub(crate) async fn shutdown(&self) -> Result<(), DbError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Shutdown { reply }).await?;
        self.receive(response).await?;

        let mut stopped = self.stopped.clone();
        loop {
            match *stopped.borrow_and_update() {
                ActorState::Running => {}
                ActorState::Stopped => return Ok(()),
                ActorState::Panicked => return Err(DbError::ActorPanicked),
            }
            stopped
                .changed()
                .await
                .map_err(|_| DbError::ActorResponseDropped)?;
        }
    }

    fn ensure_request_allowed(&self, scope: RequestScope) -> Result<(), DbError> {
        if matches!(scope, RequestScope::Ordinary) {
            self.ensure_open()?;
        }
        Ok(())
    }

    fn ensure_open(&self) -> Result<(), DbError> {
        if self.closing.load(Ordering::Acquire) {
            Err(DbError::ActorClosed)
        } else {
            Ok(())
        }
    }

    async fn send(&self, command: Command) -> Result<(), DbError> {
        if self.sender.send(command).await.is_ok() {
            return Ok(());
        }
        match self.stopped_error().await {
            DbError::ActorPanicked => Err(DbError::ActorPanicked),
            _ => Err(DbError::ActorClosed),
        }
    }

    async fn receive<T>(
        &self,
        response: oneshot::Receiver<Result<T, DbError>>,
    ) -> Result<T, DbError> {
        match response.await {
            Ok(result) => result,
            Err(_) => Err(self.stopped_error().await),
        }
    }

    async fn stopped_error(&self) -> DbError {
        let mut stopped = self.stopped.clone();
        loop {
            match *stopped.borrow_and_update() {
                ActorState::Running => {}
                ActorState::Panicked => return DbError::ActorPanicked,
                ActorState::Stopped => return DbError::ActorResponseDropped,
            }
            if stopped.changed().await.is_err() {
                return DbError::ActorResponseDropped;
            }
        }
    }

    pub(crate) fn rollback_after_drop(&self, transaction_id: u64, gate: OwnedMutexGuard<()>) {
        if let Err(error) = self.drop_rollbacks.send(DropRollback {
            transaction_id,
            gate,
        }) {
            tracing::error!(
                transaction_id = error.0.transaction_id,
                "failed to queue rollback for dropped transaction"
            );
        }
    }

    #[cfg(test)]
    async fn inject_panic(&self) -> DbError {
        let (started, observed) = oneshot::channel();
        if self.sender.send(Command::Panic { started }).await.is_err() {
            return self.stopped_error().await;
        }
        let _ = observed.await;
        self.stopped_error().await
    }
}

struct Actor {
    _database: turso::Database,
    connection: turso::Connection,
    receiver: mpsc::Receiver<Command>,
    drop_rollbacks: mpsc::UnboundedReceiver<DropRollback>,
    active_transaction: Option<u64>,
}

impl Actor {
    async fn run(mut self) {
        loop {
            let command = tokio::select! {
                biased;
                rollback = self.drop_rollbacks.recv(), if !self.drop_rollbacks.is_closed() => {
                    if let Some(rollback) = rollback {
                        let transaction_id = rollback.transaction_id;
                        if let Err(error) = self.rollback(transaction_id).await {
                            tracing::error!(transaction_id, %error, "failed to roll back dropped transaction");
                        }
                        drop(rollback.gate);
                    }
                    continue;
                }
                command = self.receiver.recv() => command,
            };
            let Some(command) = command else {
                return;
            };
            match command {
                Command::Query {
                    scope,
                    statement,
                    reply,
                } => {
                    let result = match self.validate_scope(scope) {
                        Ok(()) => query(&self.connection, statement).await,
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                }
                Command::Execute {
                    scope,
                    statement,
                    reply,
                } => {
                    let result = match self.validate_scope(scope) {
                        Ok(()) => execute(&self.connection, statement).await,
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                }
                Command::Ping { scope, reply } => {
                    let result = match self.validate_scope(scope) {
                        Ok(()) => ping(&self.connection).await,
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                }
                Command::Begin {
                    transaction_id,
                    reply,
                } => {
                    let result = self.begin(transaction_id).await;
                    let _ = reply.send(result);
                }
                Command::Commit {
                    transaction_id,
                    reply,
                } => {
                    let result = self.commit(transaction_id).await;
                    let _ = reply.send(result);
                }
                Command::Rollback {
                    transaction_id,
                    reply,
                } => {
                    let result = self.rollback(transaction_id).await;
                    let _ = reply.send(result);
                }
                Command::Shutdown { reply } => {
                    self.receiver.close();
                    while let Some(command) = self.receiver.recv().await {
                        command.reject_closed();
                    }
                    drop(self.connection);
                    drop(self._database);
                    let _ = reply.send(Ok(()));
                    return;
                }
                #[cfg(test)]
                Command::Panic { started } => {
                    let _ = started.send(());
                    panic!("injected database actor panic");
                }
            }
        }
    }

    fn validate_scope(&self, scope: RequestScope) -> Result<(), DbError> {
        match (self.active_transaction, scope) {
            (None, RequestScope::Ordinary) => Ok(()),
            (Some(active), RequestScope::Transaction(requested)) if active == requested => Ok(()),
            (Some(active), RequestScope::Transaction(requested)) => {
                Err(DbError::TransactionMismatch { active, requested })
            }
            (Some(active), RequestScope::Ordinary) => Err(DbError::TransactionBusy(active)),
            (None, RequestScope::Transaction(requested)) => {
                Err(DbError::TransactionNotActive(requested))
            }
        }
    }

    async fn begin(&mut self, transaction_id: u64) -> Result<(), DbError> {
        if self.active_transaction.is_some() {
            return Err(DbError::TransactionAlreadyActive);
        }
        self.connection
            .execute("BEGIN", ())
            .await
            .map_err(|error| DbError::turso("failed to begin transaction", error))?;
        self.active_transaction = Some(transaction_id);
        Ok(())
    }

    async fn commit(&mut self, transaction_id: u64) -> Result<(), DbError> {
        self.validate_transaction(transaction_id)?;
        self.connection
            .execute("COMMIT", ())
            .await
            .map_err(|error| DbError::turso("failed to commit transaction", error))?;
        self.active_transaction = None;
        Ok(())
    }

    async fn rollback(&mut self, transaction_id: u64) -> Result<(), DbError> {
        self.validate_transaction(transaction_id)?;
        self.connection
            .execute("ROLLBACK", ())
            .await
            .map_err(|error| DbError::turso("failed to roll back transaction", error))?;
        self.active_transaction = None;
        Ok(())
    }

    fn validate_transaction(&self, requested: u64) -> Result<(), DbError> {
        match self.active_transaction {
            Some(active) if active == requested => Ok(()),
            Some(active) => Err(DbError::TransactionMismatch { active, requested }),
            None => Err(DbError::TransactionNotActive(requested)),
        }
    }
}

async fn query(
    connection: &turso::Connection,
    statement: Statement,
) -> Result<Vec<ProxyRow>, DbError> {
    let (sql, values) = statement_parts(statement)?;
    let mut statement = connection
        .prepare(&sql)
        .await
        .map_err(|error| DbError::turso("failed to prepare query", error))?;
    let columns = statement
        .columns()
        .into_iter()
        .map(|column| ColumnMetadata {
            name: column.name().to_owned(),
            declared_type: column.decl_type().map(ToOwned::to_owned),
        })
        .collect::<Vec<_>>();
    let mut rows = statement
        .query(values)
        .await
        .map_err(|error| DbError::turso("failed to execute query", error))?;
    let mut raw_rows = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|error| DbError::turso("failed to advance query rows", error))?
    {
        raw_rows.push(row);
    }
    raw_rows
        .into_iter()
        .map(|row| row_to_proxy(&columns, row))
        .collect()
}

async fn execute(
    connection: &turso::Connection,
    statement: Statement,
) -> Result<ProxyExecResult, DbError> {
    let (sql, values) = statement_parts(statement)?;
    let rows_affected = connection
        .execute(&sql, values)
        .await
        .map_err(|error| DbError::turso("failed to execute statement", error))?;
    let last_insert_rowid = connection.last_insert_rowid();
    let last_insert_id = match u64::try_from(last_insert_rowid) {
        Ok(last_insert_id) => last_insert_id,
        Err(_) => {
            tracing::warn!(
                last_insert_rowid,
                "negative SQLite rowid cannot be represented by SeaORM"
            );
            0
        }
    };
    Ok(ProxyExecResult::new(last_insert_id, rows_affected))
}

async fn ping(connection: &turso::Connection) -> Result<(), DbError> {
    let mut rows = connection
        .query("SELECT 1", ())
        .await
        .map_err(|error| DbError::turso("database ping failed", error))?;
    let mut found_row = false;
    while rows
        .next()
        .await
        .map_err(|error| DbError::turso("database ping failed", error))?
        .is_some()
    {
        found_row = true;
    }
    if found_row {
        Ok(())
    } else {
        Err(DbError::ActorResponseDropped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn actor_panic_is_caught_and_reported() {
        let database = turso::Builder::new_local(":memory:")
            .build()
            .await
            .expect("in-memory database");
        let connection = database.connect().expect("database connection");
        let actor = ActorClient::spawn(&Handle::current(), database, connection, 4);

        assert!(matches!(actor.inject_panic().await, DbError::ActorPanicked));
        assert!(matches!(
            actor.ping(RequestScope::Ordinary).await,
            Err(DbError::ActorPanicked)
        ));
    }
}
