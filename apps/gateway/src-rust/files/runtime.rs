use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::entity::devices;

use super::{FileCancellation, FileErrorCode, RsyncProgress};

const SENSITIVE_ENV_KEYS: [&str; 4] = ["DATABASE_URL", "NODE_ENV", "GATEWAY_PORT", "FE_PORT"];

pub struct PreparedRsyncDevice {
    pub target_prefix: String,
    pub rsh: Option<String>,
    pub env: BTreeMap<String, String>,
    cleanup: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl fmt::Debug for PreparedRsyncDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRsyncDevice")
            .field("target_prefix", &self.target_prefix)
            .field("rsh", &self.rsh)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl PreparedRsyncDevice {
    pub fn new(
        target_prefix: impl Into<String>,
        rsh: Option<String>,
        env: BTreeMap<String, String>,
        cleanup: impl FnOnce() + Send + Sync + 'static,
    ) -> Self {
        Self {
            target_prefix: target_prefix.into(),
            rsh,
            env,
            cleanup: Some(Box::new(cleanup)),
        }
    }

    pub fn local() -> Self {
        Self::new("", None, BTreeMap::new(), || {})
    }
}

impl Drop for PreparedRsyncDevice {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RsyncTimeout {
    Fixed(Duration),
    Idle(Duration),
}

pub struct RsyncRequest {
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub timeout: RsyncTimeout,
    pub cancellation: FileCancellation,
    pub progress: Option<mpsc::Sender<RsyncProgress>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RsyncResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct FileRuntimeError {
    pub code: FileErrorCode,
    pub message: String,
}

impl FileRuntimeError {
    pub fn new(code: FileErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait FileRuntime: Send + Sync {
    async fn prepare_rsync(
        &self,
        device: &devices::Model,
    ) -> Result<PreparedRsyncDevice, FileRuntimeError>;

    /// Executes `rsync` with exactly the supplied argv and environment. Implementations must
    /// terminate the child rsync/SSH process when `request.cancellation` fires, then await its
    /// exit before returning.
    async fn run_rsync(&self, request: RsyncRequest) -> Result<RsyncResult, FileRuntimeError>;
}

pub(crate) fn subprocess_environment(
    overrides: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = std::env::vars()
        .filter(|(key, _)| !key.starts_with("TMEX_") && !SENSITIVE_ENV_KEYS.contains(&key.as_str()))
        .collect::<BTreeMap<_, _>>();
    environment.insert("LC_ALL".to_owned(), "C".to_owned());
    environment.extend(overrides.clone());
    environment
}
