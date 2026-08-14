mod agent_notifications;
mod composition;
mod control;
mod deferred_lifecycle;
mod gateway;
mod http_runtime;
mod model_adapters;
mod ports;
mod system_info;

pub use agent_notifications::GatewayAgentNotificationSink;
pub use gateway::GatewayRuntime;
pub use http_runtime::GatewayHttpRuntime;
pub use model_adapters::{GatewayLanguageModelAdapters, GatewayStructuredModelAdapter};
pub use ports::{
    GatewayRuntimeDependencies, GatewayRuntimeError, GatewayRuntimeExit, GatewayRuntimeOptions,
    GatewayRuntimePortError, GatewaySystemInfoProvider, WatchAssistRegexGenerator,
    DEFAULT_RUNTIME_CONTROL_CAPACITY, DEFAULT_RUNTIME_HTTP_CONCURRENCY,
};
pub use system_info::{
    GatewayDeployment, GatewayHostSystemInfo, ProductionGatewaySystemInfoProvider,
};
