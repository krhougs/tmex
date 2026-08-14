use async_trait::async_trait;

use super::dto::{
    ConnectionTestResult, SettingsNamespace, StateSnapshot, SystemInfo, ThemeMode, TmuxHealth,
    TreeCustomNames, TreeOrderChange,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchAssistRegexModelRequest {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub prompt: String,
    pub max_retries: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchAssistRegexModelOutput {
    pub pattern: String,
    pub flags: String,
    pub extract_group: i64,
    pub explanation: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpRuntimeErrorKind {
    Unavailable,
    BadGateway,
    Internal,
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct HttpRuntimeError {
    pub kind: HttpRuntimeErrorKind,
    pub message: String,
}

impl HttpRuntimeError {
    pub fn new(kind: HttpRuntimeErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub type HttpRuntimeResult<T> = Result<T, HttpRuntimeError>;

#[async_trait]
pub trait HttpRuntime: Send + Sync {
    fn translate(&self, key: &'static str) -> String;

    fn tree_overlay_available(&self) -> bool;

    fn is_restarting(&self) -> bool;

    async fn upsert_device(&self, device_id: &str) -> HttpRuntimeResult<()>;

    async fn reconnect_device(&self, device_id: &str) -> HttpRuntimeResult<()>;

    async fn remove_device(&self, device_id: &str) -> HttpRuntimeResult<()>;

    async fn update_default_working_dir(
        &self,
        device_id: &str,
        working_dir: Option<String>,
    ) -> HttpRuntimeResult<()>;

    async fn clear_connection_alert(&self, device_id: &str) -> HttpRuntimeResult<()>;

    async fn test_connection(&self, device_id: &str) -> HttpRuntimeResult<ConnectionTestResult>;

    async fn latest_snapshot(&self, device_id: &str) -> HttpRuntimeResult<Option<StateSnapshot>>;

    async fn watch_capture_screen(
        &self,
        device_id: &str,
        pane_id: &str,
    ) -> HttpRuntimeResult<String>;

    async fn watch_assist_regex(
        &self,
        request: WatchAssistRegexModelRequest,
    ) -> HttpRuntimeResult<WatchAssistRegexModelOutput>;

    async fn agent_origin_process_name(
        &self,
        device_id: &str,
        pane_id: &str,
    ) -> HttpRuntimeResult<Option<String>>;

    async fn tree_custom_names(
        &self,
        device_id: &str,
    ) -> HttpRuntimeResult<Option<TreeCustomNames>>;

    /// Applies the in-memory order overlay, emits the tree-order settings update, then refreshes
    /// clients from the latest snapshot. Database persistence has already completed.
    async fn tree_order_changed(&self, change: TreeOrderChange) -> HttpRuntimeResult<()>;

    /// Updates the window-name overlay, emits the tree-order settings update, and refreshes the
    /// latest snapshot for connected clients.
    async fn rename_window(
        &self,
        device_id: &str,
        window_id: &str,
        name: Option<String>,
    ) -> HttpRuntimeResult<()>;

    /// Updates the pane-name overlay, emits the tree-order settings update, and refreshes the
    /// latest snapshot for connected clients.
    async fn rename_pane(
        &self,
        device_id: &str,
        pane_id: &str,
        name: Option<String>,
    ) -> HttpRuntimeResult<()>;

    async fn settings_changed(&self, namespace: SettingsNamespace) -> HttpRuntimeResult<()>;

    async fn theme_changed(&self, theme: ThemeMode) -> HttpRuntimeResult<()>;

    async fn schedule_restart(&self, delay_ms: u64) -> HttpRuntimeResult<()>;

    async fn tmux_health(&self) -> HttpRuntimeResult<TmuxHealth>;

    async fn system_info(&self) -> HttpRuntimeResult<SystemInfo>;
}
