use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tmex_protocol::StateSnapshot as ProtocolStateSnapshot;
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::config::GatewayConfig;
use crate::database::repository::{Repository, RepositorySiteSettingsDefaults};
use crate::http::{
    ConnectionTestResult, HttpRuntime, HttpRuntimeError, HttpRuntimeErrorKind, HttpRuntimeResult,
    SettingsNamespace, StateSnapshot, SystemInfo, ThemeMode, TmuxHealth, TmuxPane, TmuxSession,
    TmuxWindow, TreeCustomNames, TreeOrderChange, WatchAssistRegexModelOutput,
    WatchAssistRegexModelRequest,
};
use crate::i18n::{GatewayI18n, GatewayLocale};
use crate::push::{classify_connection_error, ConnectionAlertNotifier, PushSupervisor};
use crate::tmux::{
    build_local_tmux_env, is_control_mode_supported, is_no_server_running_message,
    normalize_tmux_version_output, parse_tmux_version, tmux_client_matches_server, CommandSpec,
    DeviceSessionRuntime, HostPlatform, LocalShellPathResolver, SpawnExecutor, SpawnPurpose,
    TmuxRuntimeRegistry,
};
use crate::ws::{GatewayTreeOrderChange, GatewayWsHub};

use super::control::RuntimeControl;
use super::ports::{GatewaySystemInfoProvider, WatchAssistRegexGenerator};

const HEALTH_CACHE_DURATION: Duration = Duration::from_secs(5);
const HEALTH_COMMAND_TIMEOUT: Duration = Duration::from_millis(1_500);
const HEALTH_OUTPUT_LIMIT: usize = 64 * 1024;

pub struct GatewayHttpRuntime {
    repository: Repository,
    defaults: RepositorySiteSettingsDefaults,
    runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    push: Arc<PushSupervisor>,
    alerts: ConnectionAlertNotifier,
    hub: Arc<GatewayWsHub>,
    i18n: GatewayI18n,
    watch_assist: Arc<dyn WatchAssistRegexGenerator>,
    system_info: Arc<dyn GatewaySystemInfoProvider>,
    control: mpsc::Sender<RuntimeControl>,
    restarting: Arc<AtomicBool>,
    health: TmuxHealthProbe,
}

pub(crate) struct GatewayHttpRuntimeDependencies {
    pub repository: Repository,
    pub defaults: RepositorySiteSettingsDefaults,
    pub config: GatewayConfig,
    pub runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    pub push: Arc<PushSupervisor>,
    pub alerts: ConnectionAlertNotifier,
    pub hub: Arc<GatewayWsHub>,
    pub i18n: GatewayI18n,
    pub watch_assist: Arc<dyn WatchAssistRegexGenerator>,
    pub system_info: Arc<dyn GatewaySystemInfoProvider>,
    pub control: mpsc::Sender<RuntimeControl>,
    pub restarting: Arc<AtomicBool>,
    pub spawn_executor: SpawnExecutor,
    pub environment: BTreeMap<String, String>,
}

impl GatewayHttpRuntime {
    pub(crate) fn new(dependencies: GatewayHttpRuntimeDependencies) -> Self {
        let health = TmuxHealthProbe::new(
            dependencies.config.tmux_bin.clone(),
            dependencies.config.tmux_socket.clone(),
            dependencies.spawn_executor,
            dependencies.environment,
        );
        Self {
            repository: dependencies.repository,
            defaults: dependencies.defaults,
            runtimes: dependencies.runtimes,
            push: dependencies.push,
            alerts: dependencies.alerts,
            hub: dependencies.hub,
            i18n: dependencies.i18n,
            watch_assist: dependencies.watch_assist,
            system_info: dependencies.system_info,
            control: dependencies.control,
            restarting: dependencies.restarting,
            health,
        }
    }

    async fn acquire_runtime(
        &self,
        device_id: &str,
    ) -> HttpRuntimeResult<Arc<DeviceSessionRuntime>> {
        self.runtimes
            .acquire(device_id)
            .await
            .map_err(|error| unavailable(error.to_string()))
    }

    async fn release_runtime(&self, device_id: &str, runtime: &Arc<DeviceSessionRuntime>) {
        self.runtimes.release(device_id, Some(runtime)).await;
    }
}

#[async_trait]
impl HttpRuntime for GatewayHttpRuntime {
    fn translate(&self, key: &'static str) -> String {
        self.i18n.translate(key)
    }

    fn tree_overlay_available(&self) -> bool {
        true
    }

    fn is_restarting(&self) -> bool {
        self.restarting.load(Ordering::Acquire)
    }

    async fn upsert_device(&self, device_id: &str) -> HttpRuntimeResult<()> {
        self.push.upsert(device_id).await;
        Ok(())
    }

    async fn reconnect_device(&self, device_id: &str) -> HttpRuntimeResult<()> {
        self.push.reconnect(device_id).await;
        Ok(())
    }

    async fn remove_device(&self, device_id: &str) -> HttpRuntimeResult<()> {
        self.push.remove(device_id).await;
        Ok(())
    }

    async fn update_default_working_dir(
        &self,
        device_id: &str,
        working_dir: Option<String>,
    ) -> HttpRuntimeResult<()> {
        self.push
            .update_default_working_dir(device_id, working_dir)
            .await
            .map_err(|error| unavailable(error.to_string()))
    }

    async fn clear_connection_alert(&self, device_id: &str) -> HttpRuntimeResult<()> {
        self.alerts.clear(device_id);
        Ok(())
    }

    async fn test_connection(&self, device_id: &str) -> HttpRuntimeResult<ConnectionTestResult> {
        let runtime = match self.acquire_runtime(device_id).await {
            Ok(runtime) => runtime,
            Err(error) => return Ok(self.connection_failure(error.message)),
        };
        let result = runtime
            .request_snapshot()
            .map_err(|error| error.to_string());
        self.release_runtime(device_id, &runtime).await;
        match result {
            Ok(()) => Ok(ConnectionTestResult {
                success: true,
                tmux_available: true,
                phase: "ready".to_owned(),
                error_type: None,
                message: Some(self.i18n.translate("common.success")),
                raw_message: None,
            }),
            Err(message) => Ok(self.connection_failure(message)),
        }
    }

    async fn latest_snapshot(&self, device_id: &str) -> HttpRuntimeResult<Option<StateSnapshot>> {
        let snapshot = self
            .hub
            .latest_snapshot(device_id)
            .await
            .map_err(|error| unavailable(error.to_string()))?
            .or_else(|| self.push.get_last_snapshot(device_id));
        Ok(snapshot.map(protocol_snapshot))
    }

    async fn watch_capture_screen(
        &self,
        device_id: &str,
        pane_id: &str,
    ) -> HttpRuntimeResult<String> {
        let runtime = self.acquire_runtime(device_id).await?;
        let result = runtime
            .capture_pane_text(pane_id, None)
            .await
            .map_err(|error| unavailable(error.to_string()));
        self.release_runtime(device_id, &runtime).await;
        result
    }

    async fn watch_assist_regex(
        &self,
        request: WatchAssistRegexModelRequest,
    ) -> HttpRuntimeResult<WatchAssistRegexModelOutput> {
        self.watch_assist
            .generate(request)
            .await
            .map_err(|error| bad_gateway(error.message))
    }

    async fn agent_origin_process_name(
        &self,
        device_id: &str,
        pane_id: &str,
    ) -> HttpRuntimeResult<Option<String>> {
        let runtime = self.acquire_runtime(device_id).await?;
        let result = runtime
            .pane_info(pane_id)
            .await
            .map(|pane| pane.current_command)
            .map_err(|error| unavailable(error.to_string()));
        self.release_runtime(device_id, &runtime).await;
        result
    }

    async fn tree_custom_names(
        &self,
        device_id: &str,
    ) -> HttpRuntimeResult<Option<TreeCustomNames>> {
        let names = self.hub.tree_custom_names(device_id);
        Ok(Some(TreeCustomNames {
            windows: names.windows,
            panes: names.panes,
        }))
    }

    async fn tree_order_changed(&self, change: TreeOrderChange) -> HttpRuntimeResult<()> {
        self.hub.tree_order_changed(match change {
            TreeOrderChange::Windows {
                device_id,
                window_ids,
            } => GatewayTreeOrderChange::Windows {
                device_id,
                window_ids,
            },
            TreeOrderChange::Panes {
                device_id,
                window_id,
                pane_ids,
            } => GatewayTreeOrderChange::Panes {
                device_id,
                window_id,
                pane_ids,
            },
        });
        self.hub.broadcast_settings_update("tree-order");
        Ok(())
    }

    async fn rename_window(
        &self,
        device_id: &str,
        window_id: &str,
        name: Option<String>,
    ) -> HttpRuntimeResult<()> {
        self.hub
            .rename_window(device_id, window_id, name)
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        self.hub.broadcast_settings_update("tree-order");
        Ok(())
    }

    async fn rename_pane(
        &self,
        device_id: &str,
        pane_id: &str,
        name: Option<String>,
    ) -> HttpRuntimeResult<()> {
        self.hub
            .rename_pane(device_id, pane_id, name)
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        self.hub.broadcast_settings_update("tree-order");
        Ok(())
    }

    async fn settings_changed(&self, namespace: SettingsNamespace) -> HttpRuntimeResult<()> {
        if namespace == SettingsNamespace::Site {
            let settings = self
                .repository
                .get_site_settings(&self.defaults)
                .await
                .map_err(|error| internal(error.to_string()))?;
            self.i18n.set_locale(
                GatewayLocale::parse(&settings.language).unwrap_or(GatewayLocale::EnUs),
            );
        }
        self.hub
            .broadcast_settings_update(settings_namespace(namespace));
        Ok(())
    }

    async fn theme_changed(&self, theme: ThemeMode) -> HttpRuntimeResult<()> {
        self.hub.broadcast_site_theme(match theme {
            ThemeMode::Dark => crate::tmux::ThemeMode::Dark,
            ThemeMode::Light => crate::tmux::ThemeMode::Light,
        });
        Ok(())
    }

    async fn schedule_restart(&self, delay_ms: u64) -> HttpRuntimeResult<()> {
        let (response, receiver) = tokio::sync::oneshot::channel();
        self.control
            .send(RuntimeControl::ScheduleRestart {
                delay: Duration::from_millis(delay_ms),
                response,
            })
            .await
            .map_err(|_| unavailable("Gateway runtime control channel is closed"))?;
        receiver
            .await
            .map_err(|_| unavailable("Gateway runtime dropped the restart request"))
    }

    async fn tmux_health(&self) -> HttpRuntimeResult<TmuxHealth> {
        Ok(self.health.get().await)
    }

    async fn system_info(&self) -> HttpRuntimeResult<SystemInfo> {
        self.system_info
            .system_info()
            .await
            .map_err(|error| internal(error.message))
    }
}

impl GatewayHttpRuntime {
    fn connection_failure(&self, raw_message: String) -> ConnectionTestResult {
        let classification = classify_connection_error(&raw_message);
        let parameters = if classification.includes_raw_message {
            [("message", raw_message.clone())].into_iter().collect()
        } else {
            Default::default()
        };
        let message = self
            .i18n
            .translate_with(classification.message_key, &parameters);
        ConnectionTestResult {
            success: false,
            tmux_available: false,
            phase: if classification.error_type == "tmux_unavailable" {
                "bootstrap"
            } else {
                "connect"
            }
            .to_owned(),
            error_type: Some(classification.error_type.to_owned()),
            message: Some(message),
            raw_message: Some(raw_message),
        }
    }
}

struct TmuxHealthProbe {
    tmux_bin: String,
    tmux_socket: String,
    executor: SpawnExecutor,
    environment: BTreeMap<String, String>,
    cache: Mutex<Option<(Instant, TmuxHealth)>>,
}

impl TmuxHealthProbe {
    fn new(
        tmux_bin: String,
        tmux_socket: String,
        executor: SpawnExecutor,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            tmux_bin,
            tmux_socket,
            executor,
            environment,
            cache: Mutex::new(None),
        }
    }

    async fn get(&self) -> TmuxHealth {
        let mut cache = self.cache.lock().await;
        let now = Instant::now();
        if let Some((expires_at, value)) = cache.as_ref() {
            if *expires_at > now {
                return value.clone();
            }
        }
        let value = self.probe().await;
        *cache = Some((now + HEALTH_CACHE_DURATION, value.clone()));
        value
    }

    async fn probe(&self) -> TmuxHealth {
        let base_environment = self.environment.clone();
        let resolved_path = LocalShellPathResolver::new(
            self.executor.clone(),
            HostPlatform::current(),
            base_environment.clone(),
        )
        .resolve()
        .await
        .ok()
        .flatten();
        let environment = build_local_tmux_env(
            resolved_path.as_deref(),
            &base_environment,
            HostPlatform::current(),
        );
        let client = self.run(["-V"], environment.clone()).await;
        let client = match client {
            Ok(client) => client,
            Err(_) => return health(false, None, None, None, "client_unavailable"),
        };
        let normalized = normalize_tmux_version_output(&client.stdout_text());
        let client_version = normalized.version_line;
        let client_provenance = normalized.provenance;
        if client.exit_code != 0 || client_version.is_none() {
            return health(
                false,
                client_version,
                client_provenance,
                None,
                "client_unavailable",
            );
        }
        if !is_control_mode_supported(parse_tmux_version(
            client_version.as_deref().unwrap_or_default(),
        )) {
            return health(
                false,
                client_version,
                client_provenance,
                None,
                "unsupported_version",
            );
        }
        let server = self
            .run(["display-message", "-p", "#{version}"], environment)
            .await;
        let server = match server {
            Ok(server) => server,
            Err(_) => {
                return health(
                    false,
                    client_version,
                    client_provenance,
                    None,
                    "server_probe_failed",
                );
            }
        };
        let server_version = normalize_tmux_version_output(&server.stdout_text()).version_line;
        if server.exit_code != 0 {
            let detail = format!("{}\n{}", server.stdout_text(), server.stderr_text());
            let no_server = is_no_server_running_message(&detail);
            return health(
                no_server,
                client_version,
                client_provenance,
                None,
                if no_server {
                    "no_server"
                } else {
                    "server_probe_failed"
                },
            );
        }
        if server_version.is_none()
            || !tmux_client_matches_server(
                client_version.as_deref().unwrap_or_default(),
                server_version.as_deref().unwrap_or_default(),
            )
        {
            return health(
                false,
                client_version,
                client_provenance,
                server_version,
                "version_mismatch",
            );
        }
        health(
            true,
            client_version,
            client_provenance,
            server_version,
            "ok",
        )
    }

    async fn run<const N: usize>(
        &self,
        args: [&str; N],
        environment: BTreeMap<String, String>,
    ) -> Result<crate::tmux::CommandOutput, crate::tmux::SpawnError> {
        let mut argv = Vec::with_capacity(args.len() + 2);
        if !self.tmux_socket.is_empty() {
            argv.extend(["-L".to_owned(), self.tmux_socket.clone()]);
        }
        argv.extend(args.into_iter().map(str::to_owned));
        self.executor
            .run_bounded(
                CommandSpec::new(SpawnPurpose::TmuxClientMayStartServer, &self.tmux_bin)
                    .args(argv)
                    .with_env(environment, true),
                HEALTH_COMMAND_TIMEOUT,
                HEALTH_OUTPUT_LIMIT,
                HEALTH_OUTPUT_LIMIT,
            )
            .await
    }
}

fn protocol_snapshot(snapshot: ProtocolStateSnapshot) -> StateSnapshot {
    StateSnapshot {
        device_id: snapshot.device_id,
        session: snapshot.session.map(|session| TmuxSession {
            id: session.id,
            name: session.name,
            windows: session
                .windows
                .into_iter()
                .map(|window| TmuxWindow {
                    id: window.id,
                    name: window.name,
                    custom_name: window.custom_name,
                    index: i64::from(window.index),
                    active: window.active,
                    layout: window.layout,
                    panes: window
                        .panes
                        .into_iter()
                        .map(|pane| TmuxPane {
                            id: pane.id,
                            window_id: pane.window_id,
                            index: i64::from(pane.index),
                            title: pane.title,
                            custom_name: pane.custom_name,
                            current_command: pane.current_command,
                            current_path: pane.current_path,
                            active: pane.active,
                            width: i64::from(pane.width),
                            height: i64::from(pane.height),
                            left: pane.left.map(i64::from),
                            top: pane.top.map(i64::from),
                        })
                        .collect(),
                })
                .collect(),
        }),
    }
}

fn settings_namespace(namespace: SettingsNamespace) -> &'static str {
    match namespace {
        SettingsNamespace::Devices => "devices",
        SettingsNamespace::FileRoots => "file-roots",
        SettingsNamespace::Llm => "llm",
        SettingsNamespace::Site => "site",
        SettingsNamespace::Telegram => "telegram",
        SettingsNamespace::TerminalShortcuts => "terminal-shortcuts",
        SettingsNamespace::Theme => "theme",
        SettingsNamespace::Weixin => "weixin",
        SettingsNamespace::Webhooks => "webhooks",
    }
}

fn health(
    healthy: bool,
    client_version: Option<String>,
    client_provenance: Option<String>,
    server_version: Option<String>,
    reason: &str,
) -> TmuxHealth {
    TmuxHealth {
        healthy,
        client_version,
        client_provenance,
        server_version,
        reason: reason.to_owned(),
    }
}

fn unavailable(message: impl Into<String>) -> HttpRuntimeError {
    HttpRuntimeError::new(HttpRuntimeErrorKind::Unavailable, message)
}

fn bad_gateway(message: impl Into<String>) -> HttpRuntimeError {
    HttpRuntimeError::new(HttpRuntimeErrorKind::BadGateway, message)
}

fn internal(message: impl Into<String>) -> HttpRuntimeError {
    HttpRuntimeError::new(HttpRuntimeErrorKind::Internal, message)
}
