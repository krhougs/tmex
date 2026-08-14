#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tmex_db::{Database, DbConfig};
use tmex_gateway::config::{
    parse_gateway_args, GatewayCliIntent, GatewayConfig, GatewayEntryMode,
    GatewayFrontend as ConfiguredFrontend, GatewayListener, GatewayPlatform, GatewayRestartPolicy,
    SpaAssets, GATEWAY_VERSION,
};
use tmex_gateway::crypto::MasterKey;
use tmex_gateway::database::repository::Repository;
use tmex_gateway::database::DatabaseBootstrap;
use tmex_gateway::files::SystemFileRuntime;
use tmex_gateway::runtime::{
    GatewayLanguageModelAdapters, GatewayRuntime, GatewayRuntimeDependencies, GatewayRuntimeExit,
    ProductionGatewaySystemInfoProvider,
};
use tmex_gateway::server::{
    GatewayFrontend as ServerFrontend, GatewayServerConfig, GatewayTcpServer,
};
use tmex_gateway::tmux::{
    is_openssh_askpass_helper_request, run_openssh_askpass_helper, DefaultTmuxTransportFactory,
    OpenSshAskpassExecutable, StandaloneSpawnPolicy, SystemOpenSshInvocationBuilder,
};
use tokio::sync::oneshot;

const INSTALL_MARKER: &str = "Application Support/tmex";
const REPOSITORY_ENV_FILES: [&str; 2] = ["development.env", "test.env"];
const PRODUCTION_REQUIRED: [&str; 4] = [
    "TMEX_MASTER_KEY",
    "GATEWAY_PORT",
    "TMEX_BIND_HOST",
    "DATABASE_URL",
];

fn main() {
    if is_openssh_askpass_helper_request() {
        let code = match run_openssh_askpass_helper() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("tmex-gateway askpass helper failed: {error}");
                1
            }
        };
        std::process::exit(code);
    }

    let code = match run_entrypoint() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("tmex-gateway: {error}");
            1
        }
    };
    std::process::exit(code);
}

fn run_entrypoint() -> Result<i32, StandaloneError> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let intent = parse_gateway_args(&arguments)
        .map_err(|error| StandaloneError::context("invalid command-line arguments", error))?;
    let GatewayCliIntent::Run { tmux_namespace } = intent else {
        println!("tmex-gateway {GATEWAY_VERSION}");
        return Ok(0);
    };

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let environment = load_process_environment()?;
    validate_production_environment(&environment)?;
    let current_exe = env::current_exe()
        .map_err(|error| StandaloneError::context("failed to resolve current executable", error))?;
    let installed_layout = installed_layout_root(&current_exe);
    let entry_mode = detect_entry_mode(&environment, installed_layout.as_deref());
    let config = GatewayConfig::from_env(
        entry_mode,
        GatewayPlatform::current(),
        &environment,
        tmux_namespace.as_deref(),
    )
    .map_err(|error| StandaloneError::context("invalid Gateway configuration", error))?;
    let master_key = resolve_master_key(&config)?;
    let display_version = if config.is_prod() {
        GATEWAY_VERSION.to_owned()
    } else {
        format!("{GATEWAY_VERSION}_dev")
    };
    println!("[gateway] tmex {display_version}");
    tracing::info!(version = %display_version, "tmex-gateway starting");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| StandaloneError::context("failed to initialize Tokio", error))?;
    runtime.block_on(run_standalone(
        config,
        master_key,
        environment.into_iter().collect(),
        current_exe,
        installed_layout,
    ))
}

async fn run_standalone(
    config: GatewayConfig,
    master_key: MasterKey,
    environment: BTreeMap<String, String>,
    current_exe: PathBuf,
    installed_layout: Option<PathBuf>,
) -> Result<i32, StandaloneError> {
    let database = DatabaseBootstrap::new(DbConfig::new(&config.database_url))
        .run()
        .await
        .map_err(|error| StandaloneError::context("database bootstrap failed", error))?;
    let run_result = run_with_database(
        database.clone(),
        config,
        master_key,
        environment,
        current_exe,
        installed_layout,
    )
    .await;
    let close_result = database.close().await;

    match (run_result, close_result) {
        (Ok(code), Ok(())) => Ok(code),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(close)) => Err(StandaloneError::context(
            "failed to close Gateway database",
            close,
        )),
        (Err(error), Err(close)) => Err(StandaloneError::new(format!(
            "{error}; Gateway database close also failed: {close}"
        ))),
    }
}

async fn run_with_database(
    database: Database,
    config: GatewayConfig,
    master_key: MasterKey,
    environment: BTreeMap<String, String>,
    current_exe: PathBuf,
    installed_layout: Option<PathBuf>,
) -> Result<i32, StandaloneError> {
    let repository = Repository::new(database);
    let askpass = OpenSshAskpassExecutable::new(current_exe.clone(), BTreeMap::new());
    let credential_builder =
        SystemOpenSshInvocationBuilder::default().with_askpass_executable(askpass);
    let transport_factory = Arc::new(DefaultTmuxTransportFactory::new(
        environment.clone(),
        Arc::new(credential_builder.clone()),
    ));
    let file_runtime = Arc::new(SystemFileRuntime::with_credential_builder(
        master_key.clone(),
        credential_builder,
    ));
    let models = GatewayLanguageModelAdapters::production(repository.clone(), master_key.clone());
    let system_info = Arc::new(resolve_system_info_provider(
        &config,
        &environment,
        installed_layout.as_deref(),
    )?);
    let context = StandaloneRuntimeContext {
        repository,
        config: config.clone(),
        master_key,
        host_name: resolve_host_name(&environment),
        environment,
        spawn_policy: Arc::new(StandaloneSpawnPolicy),
        transport_factory,
        file_runtime,
        models,
        system_info,
    };
    let server_config = resolve_server_config(&config, installed_layout.as_deref())?;
    let mut signals = ShutdownSignals::new()?;

    loop {
        match run_runtime_cycle(&context, server_config.clone(), &mut signals).await? {
            RuntimeCycleExit::Signal | RuntimeCycleExit::Runtime(GatewayRuntimeExit::Stopped) => {
                return Ok(0);
            }
            RuntimeCycleExit::Runtime(GatewayRuntimeExit::RestartRequested(
                GatewayRestartPolicy::RecreateInProcess,
            )) => {}
            RuntimeCycleExit::Runtime(GatewayRuntimeExit::RestartRequested(
                GatewayRestartPolicy::ExitProcess { code },
            )) => return Ok(code),
            RuntimeCycleExit::Runtime(GatewayRuntimeExit::RestartRequested(
                GatewayRestartPolicy::DelegateToHost { .. },
            )) => {
                return Err(StandaloneError::new(
                    "standalone Gateway cannot delegate restart to an embedding host",
                ));
            }
        }
    }
}

struct StandaloneRuntimeContext {
    repository: Repository,
    config: GatewayConfig,
    master_key: MasterKey,
    host_name: String,
    environment: BTreeMap<String, String>,
    spawn_policy: Arc<StandaloneSpawnPolicy>,
    transport_factory: Arc<DefaultTmuxTransportFactory>,
    file_runtime: Arc<SystemFileRuntime>,
    models: GatewayLanguageModelAdapters,
    system_info: Arc<ProductionGatewaySystemInfoProvider>,
}

impl StandaloneRuntimeContext {
    fn dependencies(&self) -> GatewayRuntimeDependencies {
        GatewayRuntimeDependencies {
            repository: self.repository.clone(),
            config: self.config.clone(),
            master_key: self.master_key.clone(),
            host_name: self.host_name.clone(),
            environment: self.environment.clone(),
            spawn_policy: self.spawn_policy.clone(),
            tmux_transport_factory: self.transport_factory.clone(),
            file_runtime: self.file_runtime.clone(),
            agent_model: self.models.agent_model(),
            watch_model: self.models.watch_model(),
            watch_assist: self.models.watch_assist(),
            system_info: self.system_info.clone(),
        }
    }
}

enum RuntimeCycleExit {
    Signal,
    Runtime(GatewayRuntimeExit),
}

enum RuntimeCycleEvent {
    Signal(io::Result<()>),
    Runtime(Result<GatewayRuntimeExit, tmex_gateway::runtime::GatewayRuntimeError>),
    Server(io::Result<()>),
}

async fn run_runtime_cycle(
    context: &StandaloneRuntimeContext,
    server_config: GatewayServerConfig,
    signals: &mut ShutdownSignals,
) -> Result<RuntimeCycleExit, StandaloneError> {
    let runtime = GatewayRuntime::start(context.dependencies())
        .await
        .map_err(|error| StandaloneError::context("Gateway runtime startup failed", error))?;
    let client = runtime.client();
    let server = match GatewayTcpServer::bind(client.clone(), server_config).await {
        Ok(server) => server,
        Err(error) => {
            let cleanup = runtime.shutdown().await.err();
            return Err(with_cleanup_error(
                StandaloneError::context("failed to bind Gateway TCP listener", error),
                cleanup.map(|error| error.to_string()),
            ));
        }
    };
    println!("[gateway] listening on {}", server.local_addr());

    let (server_shutdown, server_shutdown_receiver) = oneshot::channel();
    let runtime_future = runtime.join();
    let server_future = server.serve(async move {
        let _ = server_shutdown_receiver.await;
    });
    tokio::pin!(runtime_future);
    tokio::pin!(server_future);

    let event = tokio::select! {
        signal = signals.wait() => RuntimeCycleEvent::Signal(signal),
        result = &mut runtime_future => RuntimeCycleEvent::Runtime(result),
        result = &mut server_future => RuntimeCycleEvent::Server(result),
    };

    match event {
        RuntimeCycleEvent::Signal(signal) => {
            let _ = server_shutdown.send(());
            let _ = client.shutdown().await;
            let runtime = runtime_future.await;
            let server = server_future.await;
            signal.map_err(|error| {
                StandaloneError::context("failed to receive shutdown signal", error)
            })?;
            runtime.map_err(|error| {
                StandaloneError::context("Gateway runtime shutdown failed", error)
            })?;
            server.map_err(|error| {
                StandaloneError::context("Gateway TCP listener shutdown failed", error)
            })?;
            Ok(RuntimeCycleExit::Signal)
        }
        RuntimeCycleEvent::Runtime(runtime) => {
            let _ = server_shutdown.send(());
            server_future.await.map_err(|error| {
                StandaloneError::context("Gateway TCP listener shutdown failed", error)
            })?;
            runtime
                .map(RuntimeCycleExit::Runtime)
                .map_err(|error| StandaloneError::context("Gateway runtime failed", error))
        }
        RuntimeCycleEvent::Server(server) => {
            let _ = client.shutdown().await;
            let runtime = runtime_future.await;
            let server_error = match server {
                Ok(()) => StandaloneError::new("Gateway TCP listener stopped unexpectedly"),
                Err(error) => StandaloneError::context("Gateway TCP listener failed", error),
            };
            Err(with_cleanup_error(
                server_error,
                runtime.err().map(|error| error.to_string()),
            ))
        }
    }
}

fn resolve_master_key(config: &GatewayConfig) -> Result<MasterKey, StandaloneError> {
    config
        .master_key
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(MasterKey::from_base64)
        .transpose()
        .map(|key| key.unwrap_or_else(MasterKey::development_default))
        .map_err(|error| StandaloneError::context("invalid TMEX_MASTER_KEY", error))
}

fn resolve_system_info_provider(
    config: &GatewayConfig,
    environment: &BTreeMap<String, String>,
    installed_layout: Option<&Path>,
) -> Result<ProductionGatewaySystemInfoProvider, StandaloneError> {
    let install_dir = resolve_install_dir(environment, installed_layout)?;
    ProductionGatewaySystemInfoProvider::from_install_dir(config.clone(), install_dir)
        .map_err(|error| StandaloneError::context("invalid system-info source", error))
}

fn resolve_server_config(
    config: &GatewayConfig,
    installed_layout: Option<&Path>,
) -> Result<GatewayServerConfig, StandaloneError> {
    let GatewayListener::Tcp { bind_host, port } = &config.listener else {
        return Err(StandaloneError::new(
            "standalone Gateway requires a TCP listener configuration",
        ));
    };
    let frontend = match &config.frontend {
        ConfiguredFrontend::ApiOnly => ServerFrontend::ApiOnly,
        ConfiguredFrontend::Spa(SpaAssets::Directory(path)) => {
            let root = PathBuf::from(path);
            validate_spa_root(&root)?;
            ServerFrontend::Spa { root }
        }
        ConfiguredFrontend::Spa(SpaAssets::Bundled) => {
            let root = installed_layout
                .map(|root| root.join("resources").join("fe-dist"))
                .ok_or_else(|| {
                    StandaloneError::new(
                        "bundled SPA assets require the installed bin/resources layout",
                    )
                })?;
            validate_spa_root(&root)?;
            ServerFrontend::Spa { root }
        }
    };
    Ok(GatewayServerConfig {
        host: bind_host.clone(),
        port: *port,
        frontend,
    })
}

fn validate_spa_root(path: &Path) -> Result<(), StandaloneError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(StandaloneError::new(format!(
            "Gateway SPA path is not a directory: {}",
            path.display()
        ))),
        Err(error) => Err(StandaloneError::context(
            format!("Gateway SPA assets are unavailable at {}", path.display()),
            error,
        )),
    }
}

fn resolve_install_dir(
    environment: &BTreeMap<String, String>,
    installed_layout: Option<&Path>,
) -> Result<PathBuf, StandaloneError> {
    if let Some(frontend) = environment
        .get("TMEX_FE_DIST_DIR")
        .filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(frontend).join("..").join(".."));
    }
    match installed_layout {
        Some(path) => Ok(path.to_path_buf()),
        None => env::current_dir().map_err(|error| {
            StandaloneError::context("failed to resolve Gateway installation directory", error)
        }),
    }
}

fn detect_entry_mode(
    environment: &HashMap<String, String>,
    installed_layout: Option<&Path>,
) -> GatewayEntryMode {
    if environment
        .get("TMEX_FE_DIST_DIR")
        .is_some_and(|value| !value.trim().is_empty())
        || installed_layout.is_some()
    {
        GatewayEntryMode::NpmManaged
    } else {
        GatewayEntryMode::Repository
    }
}

fn installed_layout_root(current_exe: &Path) -> Option<PathBuf> {
    let bin_dir = current_exe.parent()?;
    if bin_dir.file_name()?.to_str()? != "bin" {
        return None;
    }
    let root = bin_dir.parent()?;
    if root.join("install-meta.json").is_file() && root.join("resources").join("fe-dist").is_dir() {
        Some(root.to_path_buf())
    } else {
        None
    }
}

fn resolve_host_name(environment: &BTreeMap<String, String>) -> String {
    ["HOSTNAME", "COMPUTERNAME"]
        .into_iter()
        .filter_map(|key| environment.get(key))
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "local".to_owned())
}

fn load_process_environment() -> Result<HashMap<String, String>, StandaloneError> {
    let node_env = env::var("NODE_ENV").unwrap_or_else(|_| "development".to_owned());
    if node_env == "production" {
        return Ok(env::vars().collect());
    }

    if env::var("TMEX_FE_DIST_DIR")
        .ok()
        .is_some_and(|value| value.contains(INSTALL_MARKER))
    {
        env::remove_var("TMEX_FE_DIST_DIR");
    }

    let environment_name = if node_env == "test" {
        "test"
    } else {
        "development"
    };
    let repository_root = resolve_repository_root()?;
    let mut values = HashMap::new();
    for name in [
        format!("{environment_name}.env"),
        format!("{environment_name}.env.local"),
    ] {
        let path = repository_root.join(name);
        match fs::read_to_string(&path) {
            Ok(contents) => values.extend(parse_env_file(&contents)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(StandaloneError::context(
                    format!("failed to read environment file {}", path.display()),
                    error,
                ));
            }
        }
    }
    for (key, value) in values {
        env::set_var(key, value);
    }

    if let Ok(database_url) = env::var("DATABASE_URL") {
        if !is_special_database_url(&database_url) {
            let path = repository_root.join(database_url.trim_start_matches("./"));
            env::set_var("DATABASE_URL", path);
        }
    }
    Ok(env::vars().collect())
}

fn resolve_repository_root() -> Result<PathBuf, StandaloneError> {
    let current_dir = env::current_dir()
        .map_err(|error| StandaloneError::context("failed to resolve current directory", error))?;
    if let Some(root) = find_repository_root(&current_dir) {
        return Ok(root);
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(root) = current_exe.parent().and_then(find_repository_root) {
            return Ok(root);
        }
    }
    Ok(current_dir)
}

fn find_repository_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|candidate| {
        let has_environment = REPOSITORY_ENV_FILES
            .iter()
            .any(|name| candidate.join(name).is_file());
        (has_environment && candidate.join("Cargo.toml").is_file()).then(|| candidate.to_path_buf())
    })
}

fn parse_env_file(contents: &str) -> HashMap<String, String> {
    contents
        .lines()
        .filter_map(|raw_line| {
            let line = raw_line.trim_end_matches('\r');
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                return None;
            }
            let (raw_key, raw_value) = line.split_once('=')?;
            let key = raw_key
                .trim()
                .strip_prefix("export ")
                .unwrap_or(raw_key.trim())
                .trim();
            if key.is_empty() {
                return None;
            }
            let value = unquote_env_value(raw_value.trim());
            Some((key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn unquote_env_value(value: &str) -> &str {
    if value.len() < 2 {
        return value;
    }
    let bytes = value.as_bytes();
    if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
        || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn is_special_database_url(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("file:")
        || value.starts_with("sqlite:")
        || value.starts_with("http:")
        || value.starts_with("https:")
        || value.starts_with(":memory:")
}

fn validate_production_environment(
    environment: &HashMap<String, String>,
) -> Result<(), StandaloneError> {
    if environment.get("NODE_ENV").map(String::as_str) != Some("production") {
        return Ok(());
    }
    let missing = PRODUCTION_REQUIRED
        .iter()
        .filter(|key| {
            environment
                .get(**key)
                .is_none_or(|value| value.trim().is_empty())
        })
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(StandaloneError::new(format!(
            "production environment is missing required variables: {}",
            missing.join(", ")
        )))
    }
}

fn with_cleanup_error(primary: StandaloneError, cleanup: Option<String>) -> StandaloneError {
    match cleanup {
        Some(cleanup) => {
            StandaloneError::new(format!("{primary}; Gateway cleanup also failed: {cleanup}"))
        }
        None => primary,
    }
}

#[cfg(unix)]
struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl ShutdownSignals {
    fn new() -> Result<Self, StandaloneError> {
        let interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .map_err(|error| {
            StandaloneError::context("failed to install SIGINT handler", error)
        })?;
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|error| {
            StandaloneError::context("failed to install SIGTERM handler", error)
        })?;
        Ok(Self {
            interrupt,
            terminate,
        })
    }

    async fn wait(&mut self) -> io::Result<()> {
        tokio::select! {
            signal = self.interrupt.recv() => signal.map(|_| ()).ok_or_else(|| {
                io::Error::other("SIGINT signal stream closed unexpectedly")
            }),
            signal = self.terminate.recv() => signal.map(|_| ()).ok_or_else(|| {
                io::Error::other("SIGTERM signal stream closed unexpectedly")
            }),
        }
    }
}

#[cfg(windows)]
struct ShutdownSignals {
    control_c: tokio::signal::windows::CtrlC,
    control_break: tokio::signal::windows::CtrlBreak,
}

#[cfg(windows)]
impl ShutdownSignals {
    fn new() -> Result<Self, StandaloneError> {
        let control_c = tokio::signal::windows::ctrl_c()
            .map_err(|error| StandaloneError::context("failed to install CTRL_C handler", error))?;
        let control_break = tokio::signal::windows::ctrl_break().map_err(|error| {
            StandaloneError::context("failed to install CTRL_BREAK handler", error)
        })?;
        Ok(Self {
            control_c,
            control_break,
        })
    }

    async fn wait(&mut self) -> io::Result<()> {
        tokio::select! {
            signal = self.control_c.recv() => signal.map(|_| ()).ok_or_else(|| {
                io::Error::other("CTRL_C signal stream closed unexpectedly")
            }),
            signal = self.control_break.recv() => signal.map(|_| ()).ok_or_else(|| {
                io::Error::other("CTRL_BREAK signal stream closed unexpectedly")
            }),
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct ShutdownSignals;

#[cfg(not(any(unix, windows)))]
impl ShutdownSignals {
    fn new() -> Result<Self, StandaloneError> {
        Ok(Self)
    }

    async fn wait(&mut self) -> io::Result<()> {
        tokio::signal::ctrl_c().await
    }
}

#[derive(Debug)]
struct StandaloneError {
    message: String,
}

impl StandaloneError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn context(context: impl fmt::Display, error: impl fmt::Display) -> Self {
        Self::new(format!("{context}: {error}"))
    }
}

impl fmt::Display for StandaloneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StandaloneError {}
