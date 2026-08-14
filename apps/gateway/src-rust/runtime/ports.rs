use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::agent::AgentModelDriver;
use crate::config::{GatewayConfig, GatewayRestartPolicy};
use crate::crypto::MasterKey;
use crate::database::repository::Repository;
use crate::files::FileRuntime;
use crate::http::{SystemInfo, WatchAssistRegexModelOutput, WatchAssistRegexModelRequest};
use crate::ipc::DEFAULT_COMMAND_CAPACITY;
use crate::tmux::{SpawnPolicy, TmuxTransportFactory};
use crate::watch::WatchModelGenerator;

pub const DEFAULT_RUNTIME_CONTROL_CAPACITY: usize = 8;
pub const DEFAULT_RUNTIME_HTTP_CONCURRENCY: usize = 32;

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct GatewayRuntimePortError {
    pub message: String,
}

impl GatewayRuntimePortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait WatchAssistRegexGenerator: Send + Sync {
    async fn generate(
        &self,
        request: WatchAssistRegexModelRequest,
    ) -> Result<WatchAssistRegexModelOutput, GatewayRuntimePortError>;
}

#[async_trait]
pub trait GatewaySystemInfoProvider: Send + Sync {
    async fn system_info(&self) -> Result<SystemInfo, GatewayRuntimePortError>;
}

pub struct GatewayRuntimeDependencies {
    pub repository: Repository,
    pub config: GatewayConfig,
    pub master_key: MasterKey,
    pub host_name: String,
    pub environment: BTreeMap<String, String>,
    pub spawn_policy: Arc<dyn SpawnPolicy>,
    pub tmux_transport_factory: Arc<dyn TmuxTransportFactory>,
    pub file_runtime: Arc<dyn FileRuntime>,
    pub agent_model: Arc<dyn AgentModelDriver>,
    pub watch_model: Arc<dyn WatchModelGenerator>,
    pub watch_assist: Arc<dyn WatchAssistRegexGenerator>,
    pub system_info: Arc<dyn GatewaySystemInfoProvider>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GatewayRuntimeOptions {
    pub command_capacity: usize,
    pub control_capacity: usize,
    pub max_http_concurrency: usize,
}

impl Default for GatewayRuntimeOptions {
    fn default() -> Self {
        Self {
            command_capacity: DEFAULT_COMMAND_CAPACITY,
            control_capacity: DEFAULT_RUNTIME_CONTROL_CAPACITY,
            max_http_concurrency: DEFAULT_RUNTIME_HTTP_CONCURRENCY,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GatewayRuntimeExit {
    Stopped,
    RestartRequested(GatewayRestartPolicy),
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("Gateway runtime failed during {stage}: {cause}")]
pub struct GatewayRuntimeError {
    pub stage: String,
    pub cause: String,
}

impl GatewayRuntimeError {
    pub fn new(stage: impl Into<String>, cause: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            cause: cause.into(),
        }
    }
}
