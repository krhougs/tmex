use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use sea_orm::{
    ConnectionTrait, Database as SeaDatabase, DatabaseConnection, DbBackend, DbErr, ExecResult,
    ProxyDatabaseTrait, ProxyExecResult, ProxyRow, QueryResult, RuntimeErr, Statement,
};
use tokio::sync::Mutex;

use crate::actor::{ActorClient, RequestScope};
use crate::DbError;

#[derive(Clone)]
enum SessionScope {
    Ordinary(Arc<Mutex<()>>),
    Transaction(u64),
}

impl SessionScope {
    fn request_scope(&self) -> RequestScope {
        match self {
            Self::Ordinary(_) => RequestScope::Ordinary,
            Self::Transaction(transaction_id) => RequestScope::Transaction(*transaction_id),
        }
    }
}

#[derive(Clone)]
struct TursoProxy {
    actor: ActorClient,
    scope: SessionScope,
}

impl fmt::Debug for TursoProxy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TursoProxy")
            .field(
                "transactional",
                &matches!(self.scope, SessionScope::Transaction(_)),
            )
            .finish()
    }
}

#[async_trait]
impl ProxyDatabaseTrait for TursoProxy {
    async fn query(&self, statement: Statement) -> Result<Vec<ProxyRow>, DbErr> {
        let _gate = match &self.scope {
            SessionScope::Ordinary(gate) => Some(gate.lock().await),
            SessionScope::Transaction(_) => None,
        };
        self.actor
            .query(self.scope.request_scope(), statement)
            .await
            .map_err(query_error)
    }

    async fn execute(&self, statement: Statement) -> Result<ProxyExecResult, DbErr> {
        let _gate = match &self.scope {
            SessionScope::Ordinary(gate) => Some(gate.lock().await),
            SessionScope::Transaction(_) => None,
        };
        self.actor
            .execute(self.scope.request_scope(), statement)
            .await
            .map_err(execute_error)
    }

    async fn ping(&self) -> Result<(), DbErr> {
        let _gate = match &self.scope {
            SessionScope::Ordinary(gate) => Some(gate.lock().await),
            SessionScope::Transaction(_) => None,
        };
        self.actor
            .ping(self.scope.request_scope())
            .await
            .map_err(connection_error)
    }

    async fn begin(&self) {
        report_proxy_transaction_hook("begin");
    }

    async fn commit(&self) {
        report_proxy_transaction_hook("commit");
    }

    async fn rollback(&self) {
        report_proxy_transaction_hook("rollback");
    }

    fn start_rollback(&self) {
        report_proxy_transaction_hook("start_rollback");
    }
}

fn report_proxy_transaction_hook(operation: &'static str) {
    let error = DbError::ProxyTransactionsUnsupported;
    tracing::error!(operation, %error, "rejected SeaORM Proxy transaction hook");
}

fn connection_error(error: DbError) -> DbErr {
    DbErr::Conn(RuntimeErr::Internal(error.to_string()))
}

fn query_error(error: DbError) -> DbErr {
    DbErr::Query(RuntimeErr::Internal(error.to_string()))
}

fn execute_error(error: DbError) -> DbErr {
    DbErr::Exec(RuntimeErr::Internal(error.to_string()))
}

#[derive(Clone)]
pub struct OrmSession {
    connection: DatabaseConnection,
}

impl fmt::Debug for OrmSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("OrmSession").finish()
    }
}

impl OrmSession {
    pub(crate) async fn ordinary(
        actor: ActorClient,
        gate: Arc<Mutex<()>>,
    ) -> Result<Self, DbError> {
        Self::connect(TursoProxy {
            actor,
            scope: SessionScope::Ordinary(gate),
        })
        .await
    }

    pub(crate) async fn transaction(
        actor: ActorClient,
        transaction_id: u64,
    ) -> Result<Self, DbError> {
        Self::connect(TursoProxy {
            actor,
            scope: SessionScope::Transaction(transaction_id),
        })
        .await
    }

    async fn connect(proxy: TursoProxy) -> Result<Self, DbError> {
        let proxy: Arc<Box<dyn ProxyDatabaseTrait>> = Arc::new(Box::new(proxy));
        let connection = SeaDatabase::connect_proxy(DbBackend::Sqlite, proxy)
            .await
            .map_err(DbError::SeaOrm)?;
        Ok(Self { connection })
    }
}

#[async_trait]
impl ConnectionTrait for OrmSession {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Sqlite
    }

    async fn execute(&self, statement: Statement) -> Result<ExecResult, DbErr> {
        self.connection.execute(statement).await
    }

    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        self.connection.execute_unprepared(sql).await
    }

    async fn query_one(&self, statement: Statement) -> Result<Option<QueryResult>, DbErr> {
        self.connection.query_one(statement).await
    }

    async fn query_all(&self, statement: Statement) -> Result<Vec<QueryResult>, DbErr> {
        self.connection.query_all(statement).await
    }

    fn support_returning(&self) -> bool {
        self.connection.support_returning()
    }

    fn is_mock_connection(&self) -> bool {
        false
    }
}
