use std::collections::BTreeMap;
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use super::spawn_policy::RetainedTempDir;
use super::ssh_connect_config::build_openssh_subprocess_environment;
use super::{
    build_local_tmux_env, build_ssh_bootstrap_script, join_shell_args, parse_ssh_bootstrap_output,
    CommandOutput, CommandSpec, HostPlatform, LocalTmuxConfig, ParsedSshBootstrap, ResolvedSshAuth,
    SpawnError, SpawnExecutor, SpawnPurpose, SpawnedChild, SshConnectConfig, TmuxCommandResult,
};

const DEFAULT_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const SSH_STDERR_TAIL_LIMIT: usize = 2048;
const COMMAND_SENTINEL: &[u8] = b"\x1eTMEX_END ";

#[derive(Debug)]
pub enum TmuxTransportError {
    Spawn(SpawnError),
    Io(std::io::Error),
    Closed,
    SshClosed {
        stderr_tail: String,
    },
    CommandTimedOut(Duration),
    SshCommandTimedOut {
        duration: Duration,
        stderr_tail: String,
    },
    CommandOutputTooLarge(usize),
    InvalidCommandFrame,
    SshInvalidCommandFrame {
        stderr_tail: String,
    },
    Bootstrap(String),
    CredentialAdapterRequired(&'static str),
    CredentialSetup {
        operation: &'static str,
        source: io::Error,
    },
}

impl fmt::Display for TmuxTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => error.fmt(formatter),
            Self::Io(error) => error.fmt(formatter),
            Self::Closed => formatter.write_str("tmux transport is closed"),
            Self::SshClosed { stderr_tail } => {
                write_ssh_diagnostic(formatter, "tmux transport is closed", stderr_tail)
            }
            Self::CommandTimedOut(duration) => {
                write!(formatter, "remote tmux command timed out after {duration:?}")
            }
            Self::SshCommandTimedOut {
                duration,
                stderr_tail,
            } => write_ssh_diagnostic(
                formatter,
                &format!("remote tmux command timed out after {duration:?}"),
                stderr_tail,
            ),
            Self::CommandOutputTooLarge(limit) => {
                write!(formatter, "remote tmux command exceeded {limit} bytes")
            }
            Self::InvalidCommandFrame => {
                formatter.write_str("remote shell returned an invalid command frame")
            }
            Self::SshInvalidCommandFrame { stderr_tail } => write_ssh_diagnostic(
                formatter,
                "remote shell returned an invalid command frame",
                stderr_tail,
            ),
            Self::Bootstrap(reason) => write!(formatter, "remote tmux bootstrap failed: {reason}"),
            Self::CredentialAdapterRequired(mode) => write!(
                formatter,
                "system OpenSSH cannot safely consume {mode} credential material; inject an SshInvocationBuilder"
            ),
            Self::CredentialSetup { operation, source } => {
                write!(formatter, "failed to prepare OpenSSH credentials ({operation}): {source}")
            }
        }
    }
}

impl TmuxTransportError {
    fn with_ssh_stderr(self, stderr_tail: String) -> Self {
        match self {
            Self::Closed => Self::SshClosed { stderr_tail },
            Self::CommandTimedOut(duration) => Self::SshCommandTimedOut {
                duration,
                stderr_tail,
            },
            Self::InvalidCommandFrame => Self::SshInvalidCommandFrame { stderr_tail },
            error => error,
        }
    }
}

fn write_ssh_diagnostic(
    formatter: &mut fmt::Formatter<'_>,
    message: &str,
    stderr_tail: &str,
) -> fmt::Result {
    if stderr_tail.is_empty() {
        formatter.write_str(message)
    } else {
        write!(formatter, "{message}; ssh stderr: {stderr_tail}")
    }
}

impl std::error::Error for TmuxTransportError {}

impl From<SpawnError> for TmuxTransportError {
    fn from(value: SpawnError) -> Self {
        Self::Spawn(value)
    }
}

impl From<std::io::Error> for TmuxTransportError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub struct ControlClient {
    child: SpawnedChild,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

pub struct ControlClientParts {
    pub child: SpawnedChild,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

impl ControlClient {
    pub async fn wait(&mut self) -> Result<i32, TmuxTransportError> {
        Ok(self.child.wait().await?.code().unwrap_or(-1))
    }

    pub async fn kill(&mut self) -> Result<(), TmuxTransportError> {
        self.stdin.shutdown().await.ok();
        self.child.kill().await?;
        Ok(())
    }

    pub fn into_parts(self) -> ControlClientParts {
        ControlClientParts {
            child: self.child,
            stdin: self.stdin,
            stdout: self.stdout,
            stderr: self.stderr,
        }
    }
}

#[async_trait]
pub trait TmuxTransport: Send + Sync {
    async fn run_tmux(
        &self,
        args: &[String],
        deadline: Duration,
        output_limit: usize,
    ) -> Result<TmuxCommandResult, TmuxTransportError>;

    async fn open_control(&self, session_name: &str) -> Result<ControlClient, TmuxTransportError>;

    fn home_dir(&self) -> Option<&str>;

    fn tmux_bin(&self) -> &str;

    fn parking_command(&self) -> &str {
        "sleep 30"
    }

    async fn ensure_ghostty_terminfo(&self) -> bool {
        false
    }

    async fn close(&self) -> Result<(), TmuxTransportError> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct LocalTmuxTransport {
    config: LocalTmuxConfig,
    executor: SpawnExecutor,
    environment: BTreeMap<String, String>,
    home_dir: Option<String>,
}

impl LocalTmuxTransport {
    pub fn new(
        config: LocalTmuxConfig,
        executor: SpawnExecutor,
        resolved_shell_path: Option<&str>,
    ) -> Self {
        let environment = build_local_tmux_env(
            resolved_shell_path,
            &config.environment,
            HostPlatform::current(),
        );
        let home_dir = environment
            .get(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .cloned();
        Self {
            config,
            executor,
            environment,
            home_dir,
        }
    }

    pub fn build_argv(&self, args: &[String]) -> Vec<String> {
        build_local_tmux_argv(
            args,
            &self.config.tmux_bin,
            self.config.socket_name.as_deref(),
        )
    }

    fn command_spec(&self, args: &[String], purpose: SpawnPurpose) -> CommandSpec {
        let argv = self.build_argv(args);
        CommandSpec::new(purpose, argv[0].clone())
            .args(argv[1..].iter().cloned())
            .with_env(self.environment.clone(), true)
    }
}

#[async_trait]
impl TmuxTransport for LocalTmuxTransport {
    async fn run_tmux(
        &self,
        args: &[String],
        deadline: Duration,
        output_limit: usize,
    ) -> Result<TmuxCommandResult, TmuxTransportError> {
        let output = self
            .executor
            .run_bounded(
                self.command_spec(args, SpawnPurpose::TmuxClientMayStartServer),
                deadline,
                output_limit,
                output_limit,
            )
            .await?;
        Ok(command_result(output))
    }

    async fn open_control(&self, session_name: &str) -> Result<ControlClient, TmuxTransportError> {
        let args = [
            "-C".to_owned(),
            "attach-session".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
        ];
        control_from_child(
            self.executor.spawn(
                self.command_spec(&args, SpawnPurpose::TmuxControlClient)
                    .piped_stdin(),
            )?,
        )
    }

    fn home_dir(&self) -> Option<&str> {
        self.home_dir.as_deref()
    }

    fn tmux_bin(&self) -> &str {
        &self.config.tmux_bin
    }

    fn parking_command(&self) -> &str {
        super::get_local_parking_command(HostPlatform::current())
    }

    async fn ensure_ghostty_terminfo(&self) -> bool {
        #[cfg(windows)]
        {
            false
        }
        #[cfg(not(windows))]
        {
            let spec = CommandSpec::new(SpawnPurpose::LocalEnvironmentProbe, "/bin/sh")
                .args(["-c", &super::build_ensure_ghostty_terminfo_script()])
                .with_env(self.environment.clone(), true);
            self.executor
                .run_bounded(spec, Duration::from_secs(15), 1024, 1024)
                .await
                .is_ok_and(|output| output.exit_code == 0)
        }
    }
}

pub fn build_local_tmux_argv(
    args: &[String],
    tmux_bin: &str,
    socket_name: Option<&str>,
) -> Vec<String> {
    let mut argv = Vec::with_capacity(args.len() + 3);
    argv.push(tmux_bin.to_owned());
    if let Some(socket) = socket_name.map(str::trim).filter(|value| !value.is_empty()) {
        argv.extend(["-L".to_owned(), socket.to_owned()]);
    }
    argv.extend_from_slice(args);
    argv
}

pub trait SshInvocationBuilder: Send + Sync + 'static {
    fn build(
        &self,
        config: &SshConnectConfig,
        purpose: SpawnPurpose,
        remote_command: &str,
    ) -> Result<CommandSpec, TmuxTransportError>;
}

pub const TMEX_SSH_ASKPASS_MODE_ENV: &str = "TMEX_SSH_ASKPASS_MODE";
pub const TMEX_SSH_ASKPASS_SECRET_FILE_ENV: &str = "TMEX_SSH_ASKPASS_SECRET_FILE";

pub fn is_openssh_askpass_helper_request() -> bool {
    std::env::var_os(TMEX_SSH_ASKPASS_MODE_ENV).is_some_and(|value| value == "1")
}

pub fn run_openssh_askpass_helper() -> io::Result<()> {
    if !is_openssh_askpass_helper_request() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "OpenSSH askpass helper mode was not requested",
        ));
    }
    let path = std::env::var_os(TMEX_SSH_ASKPASS_SECRET_FILE_ENV).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "OpenSSH askpass secret file was not provided",
        )
    })?;
    let mut secret = std::fs::read(path)?;
    let result = io::stdout()
        .write_all(&secret)
        .and_then(|_| io::stdout().flush());
    secret.fill(0);
    result
}

#[derive(Clone)]
pub struct OpenSshAskpassExecutable {
    executable: PathBuf,
    environment: BTreeMap<String, String>,
}

impl OpenSshAskpassExecutable {
    pub fn new(executable: impl Into<PathBuf>, environment: BTreeMap<String, String>) -> Self {
        Self {
            executable: executable.into(),
            environment,
        }
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn environment(&self) -> &BTreeMap<String, String> {
        &self.environment
    }
}

impl fmt::Debug for OpenSshAskpassExecutable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenSshAskpassExecutable")
            .field("executable", &self.executable)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenSshCredentialFileKind {
    PrivateKey,
    AskpassSecret,
}

pub trait OpenSshCredentialFileWriter: Send + Sync + 'static {
    /// Creates a new file whose contents are readable only by the current user.
    /// The restriction must be in place before any credential bytes are written.
    fn write_restricted(
        &self,
        path: &Path,
        contents: &[u8],
        kind: OpenSshCredentialFileKind,
    ) -> io::Result<()>;

    fn cleanup_temp_dir(&self, directory: tempfile::TempDir) {
        drop(directory);
    }
}

#[derive(Clone, Debug, Default)]
pub struct SystemOpenSshCredentialFileWriter;

#[cfg(unix)]
impl OpenSshCredentialFileWriter for SystemOpenSshCredentialFileWriter {
    fn write_restricted(
        &self,
        path: &Path,
        contents: &[u8],
        _kind: OpenSshCredentialFileKind,
    ) -> io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents)?;
        file.flush()
    }
}

#[cfg(not(unix))]
impl OpenSshCredentialFileWriter for SystemOpenSshCredentialFileWriter {
    fn write_restricted(
        &self,
        _path: &Path,
        _contents: &[u8],
        _kind: OpenSshCredentialFileKind,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "a host-provided restricted credential file writer is required on this platform",
        ))
    }
}

#[derive(Clone)]
pub struct OpenSshCredentialLease {
    args: Vec<String>,
    environment: BTreeMap<String, String>,
    retained_temp_dirs: Vec<Arc<RetainedTempDir>>,
}

impl OpenSshCredentialLease {
    pub fn apply(&self, args: &mut Vec<String>, environment: &mut BTreeMap<String, String>) {
        args.extend(self.args.iter().cloned());
        environment.extend(self.environment.clone());
    }

    pub fn retain_for_command(self, mut spec: CommandSpec) -> CommandSpec {
        for directory in self.retained_temp_dirs {
            spec = spec.retain_temp_dir(directory);
        }
        spec
    }
}

impl fmt::Debug for OpenSshCredentialLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenSshCredentialLease")
            .field("args", &self.args)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("retained_temp_dir_count", &self.retained_temp_dirs.len())
            .finish()
    }
}

#[derive(Clone)]
pub struct SystemOpenSshInvocationBuilder {
    askpass_executable: Option<OpenSshAskpassExecutable>,
    credential_file_writer: Arc<dyn OpenSshCredentialFileWriter>,
}

impl Default for SystemOpenSshInvocationBuilder {
    fn default() -> Self {
        Self {
            askpass_executable: None,
            credential_file_writer: Arc::new(SystemOpenSshCredentialFileWriter),
        }
    }
}

impl fmt::Debug for SystemOpenSshInvocationBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemOpenSshInvocationBuilder")
            .field("askpass_executable", &self.askpass_executable)
            .finish_non_exhaustive()
    }
}

impl SystemOpenSshInvocationBuilder {
    pub fn with_askpass_executable(mut self, executable: OpenSshAskpassExecutable) -> Self {
        self.askpass_executable = Some(executable);
        self
    }

    pub fn with_credential_file_writer(
        mut self,
        writer: Arc<dyn OpenSshCredentialFileWriter>,
    ) -> Self {
        self.credential_file_writer = writer;
        self
    }

    pub fn prepare_credentials(
        &self,
        auth: &ResolvedSshAuth,
    ) -> Result<OpenSshCredentialLease, TmuxTransportError> {
        let mut args = Vec::new();
        let mut environment = BTreeMap::new();
        let mut workspace = None;
        match auth {
            ResolvedSshAuth::Password(password) => {
                configure_password_auth(
                    &mut args,
                    &mut environment,
                    &mut workspace,
                    password,
                    self,
                )?;
            }
            ResolvedSshAuth::Key {
                private_key,
                passphrase,
            } => {
                configure_private_key_auth(
                    &mut args,
                    &mut environment,
                    &mut workspace,
                    private_key,
                    passphrase.as_ref(),
                    None,
                    self,
                )?;
            }
            ResolvedSshAuth::Agent {
                socket,
                fallback_identity_files,
            } => {
                environment.insert("SSH_AUTH_SOCK".to_owned(), socket.clone());
                append_identity_files(&mut args, fallback_identity_files);
                append_batch_mode(&mut args);
            }
            ResolvedSshAuth::Config {
                agent_socket,
                identity_file,
            } => {
                if let Some(socket) = agent_socket {
                    environment.insert("SSH_AUTH_SOCK".to_owned(), socket.clone());
                }
                if let Some(path) = identity_file {
                    append_identity_files(&mut args, std::slice::from_ref(path));
                }
                append_batch_mode(&mut args);
            }
            ResolvedSshAuth::Auto {
                agent_socket,
                private_key,
                password,
                identity_file,
            } => {
                if let Some(private_key) = private_key {
                    configure_private_key_auth(
                        &mut args,
                        &mut environment,
                        &mut workspace,
                        private_key,
                        None,
                        agent_socket.as_deref(),
                        self,
                    )?;
                } else if let Some(path) = identity_file {
                    if let Some(socket) = agent_socket {
                        environment.insert("SSH_AUTH_SOCK".to_owned(), socket.clone());
                    }
                    append_identity_files(&mut args, std::slice::from_ref(path));
                    append_identities_only(&mut args);
                    append_batch_mode(&mut args);
                } else if let (Some(socket), Some(password)) = (agent_socket, password) {
                    configure_auto_agent_password_auth(
                        &mut args,
                        &mut environment,
                        &mut workspace,
                        socket,
                        password,
                        self,
                    )?;
                } else if let Some(socket) = agent_socket {
                    environment.insert("SSH_AUTH_SOCK".to_owned(), socket.clone());
                    append_batch_mode(&mut args);
                } else if let Some(password) = password {
                    configure_password_auth(
                        &mut args,
                        &mut environment,
                        &mut workspace,
                        password,
                        self,
                    )?;
                } else {
                    return Err(TmuxTransportError::CredentialAdapterRequired(
                        "auto authentication without a usable credential",
                    ));
                }
            }
        }
        Ok(OpenSshCredentialLease {
            args,
            environment,
            retained_temp_dirs: workspace.into_iter().collect(),
        })
    }
}

impl SshInvocationBuilder for SystemOpenSshInvocationBuilder {
    fn build(
        &self,
        config: &SshConnectConfig,
        purpose: SpawnPurpose,
        remote_command: &str,
    ) -> Result<CommandSpec, TmuxTransportError> {
        let mut args = vec!["-T".to_owned(), "-p".to_owned(), config.port.to_string()];
        append_option(&mut args, "StrictHostKeyChecking=no");
        append_option(&mut args, "UserKnownHostsFile=/dev/null");
        append_option(&mut args, "ConnectTimeout=20");
        let credentials = self.prepare_credentials(&config.auth)?;
        let mut environment = BTreeMap::new();
        credentials.apply(&mut args, &mut environment);
        let environment =
            build_openssh_subprocess_environment(&config.subprocess_environment, environment);
        args.push(openssh_target(config));
        args.push(remote_command.to_owned());
        let spec = CommandSpec::new(purpose, "ssh")
            .args(args)
            .with_env(environment, true)
            .piped_stdin();
        Ok(credentials.retain_for_command(spec))
    }
}

fn configure_password_auth(
    args: &mut Vec<String>,
    environment: &mut BTreeMap<String, String>,
    workspace: &mut Option<Arc<RetainedTempDir>>,
    password: &super::SecretString,
    builder: &SystemOpenSshInvocationBuilder,
) -> Result<(), TmuxTransportError> {
    configure_askpass(environment, workspace, password, builder)?;
    append_option(
        args,
        "PreferredAuthentications=password,keyboard-interactive",
    );
    append_option(args, "NumberOfPasswordPrompts=1");
    Ok(())
}

fn configure_auto_agent_password_auth(
    args: &mut Vec<String>,
    environment: &mut BTreeMap<String, String>,
    workspace: &mut Option<Arc<RetainedTempDir>>,
    agent_socket: &str,
    password: &super::SecretString,
    builder: &SystemOpenSshInvocationBuilder,
) -> Result<(), TmuxTransportError> {
    configure_askpass(environment, workspace, password, builder)?;
    environment.insert("SSH_AUTH_SOCK".to_owned(), agent_socket.to_owned());
    append_option(
        args,
        "PreferredAuthentications=password,keyboard-interactive,publickey",
    );
    append_option(args, "NumberOfPasswordPrompts=1");
    Ok(())
}

fn configure_private_key_auth(
    args: &mut Vec<String>,
    environment: &mut BTreeMap<String, String>,
    workspace: &mut Option<Arc<RetainedTempDir>>,
    private_key: &super::SecretString,
    passphrase: Option<&super::SecretString>,
    agent_socket: Option<&str>,
    builder: &SystemOpenSshInvocationBuilder,
) -> Result<(), TmuxTransportError> {
    let directory = credential_workspace(workspace, &builder.credential_file_writer)?;
    let key_path = directory.path().join("identity");
    builder
        .credential_file_writer
        .write_restricted(
            &key_path,
            private_key.expose().as_bytes(),
            OpenSshCredentialFileKind::PrivateKey,
        )
        .map_err(|source| TmuxTransportError::CredentialSetup {
            operation: "private key",
            source,
        })?;
    append_identity_files(args, std::slice::from_ref(&key_path));
    append_identities_only(args);
    if let Some(socket) = agent_socket {
        environment.insert("SSH_AUTH_SOCK".to_owned(), socket.to_owned());
        append_batch_mode(args);
    } else if let Some(passphrase) = passphrase {
        configure_askpass(environment, workspace, passphrase, builder)?;
    } else {
        append_batch_mode(args);
    }
    Ok(())
}

fn configure_askpass(
    environment: &mut BTreeMap<String, String>,
    workspace: &mut Option<Arc<RetainedTempDir>>,
    secret: &super::SecretString,
    builder: &SystemOpenSshInvocationBuilder,
) -> Result<(), TmuxTransportError> {
    let directory = credential_workspace(workspace, &builder.credential_file_writer)?;
    let askpass = match &builder.askpass_executable {
        Some(askpass) => askpass.clone(),
        None => default_askpass_executable(&directory)?,
    };
    let secret_path = directory.path().join("askpass-secret");
    builder
        .credential_file_writer
        .write_restricted(
            &secret_path,
            secret.expose().as_bytes(),
            OpenSshCredentialFileKind::AskpassSecret,
        )
        .map_err(|source| TmuxTransportError::CredentialSetup {
            operation: "askpass secret",
            source,
        })?;
    for (key, value) in askpass.environment {
        environment.entry(key).or_insert(value);
    }
    environment.insert(
        "SSH_ASKPASS".to_owned(),
        askpass.executable.to_string_lossy().into_owned(),
    );
    environment.insert("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned());
    environment.insert(TMEX_SSH_ASKPASS_MODE_ENV.to_owned(), "1".to_owned());
    environment.insert(
        TMEX_SSH_ASKPASS_SECRET_FILE_ENV.to_owned(),
        secret_path.to_string_lossy().into_owned(),
    );
    environment
        .entry("DISPLAY".to_owned())
        .or_insert_with(|| std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_owned()));
    Ok(())
}

fn credential_workspace(
    workspace: &mut Option<Arc<RetainedTempDir>>,
    writer: &Arc<dyn OpenSshCredentialFileWriter>,
) -> Result<Arc<RetainedTempDir>, TmuxTransportError> {
    if let Some(directory) = workspace {
        return Ok(directory.clone());
    }
    let directory = tempfile::Builder::new()
        .prefix("tmex-ssh-")
        .tempdir()
        .map_err(|source| TmuxTransportError::CredentialSetup {
            operation: "temporary directory",
            source,
        })?;
    secure_temp_directory(&directory)?;
    let cleanup_writer = writer.clone();
    let directory = Arc::new(RetainedTempDir::new(directory, move |directory| {
        cleanup_writer.cleanup_temp_dir(directory);
    }));
    *workspace = Some(directory.clone());
    Ok(directory)
}

#[cfg(unix)]
fn secure_temp_directory(directory: &tempfile::TempDir) -> Result<(), TmuxTransportError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).map_err(
        |source| TmuxTransportError::CredentialSetup {
            operation: "temporary directory permissions",
            source,
        },
    )
}

#[cfg(not(unix))]
fn secure_temp_directory(_directory: &tempfile::TempDir) -> Result<(), TmuxTransportError> {
    Ok(())
}

#[cfg(unix)]
fn default_askpass_executable(
    directory: &RetainedTempDir,
) -> Result<OpenSshAskpassExecutable, TmuxTransportError> {
    use std::os::unix::fs::OpenOptionsExt;

    let script_path = directory.path().join("askpass.sh");
    let mut script = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&script_path)
        .map_err(|source| TmuxTransportError::CredentialSetup {
            operation: "askpass executable",
            source,
        })?;
    script
        .write_all(
            b"#!/bin/sh\n[ \"${TMEX_SSH_ASKPASS_MODE-}\" = 1 ] || exit 1\n[ -n \"${TMEX_SSH_ASKPASS_SECRET_FILE-}\" ] || exit 1\nexec /bin/cat \"$TMEX_SSH_ASKPASS_SECRET_FILE\"\n",
        )
        .and_then(|_| script.flush())
        .map_err(|source| TmuxTransportError::CredentialSetup {
            operation: "askpass executable",
            source,
        })?;
    Ok(OpenSshAskpassExecutable::new(script_path, BTreeMap::new()))
}

#[cfg(not(unix))]
fn default_askpass_executable(
    _directory: &RetainedTempDir,
) -> Result<OpenSshAskpassExecutable, TmuxTransportError> {
    Err(TmuxTransportError::CredentialAdapterRequired(
        "password or private-key passphrase without a host-provided askpass executable",
    ))
}

fn append_option(args: &mut Vec<String>, option: &str) {
    args.push("-o".to_owned());
    args.push(option.to_owned());
}

fn append_batch_mode(args: &mut Vec<String>) {
    append_option(args, "BatchMode=yes");
}

fn append_identities_only(args: &mut Vec<String>) {
    append_option(args, "IdentitiesOnly=yes");
}

fn append_identity_files(args: &mut Vec<String>, paths: &[PathBuf]) {
    for path in paths {
        args.push("-i".to_owned());
        args.push(path.to_string_lossy().into_owned());
    }
}

fn openssh_target(config: &SshConnectConfig) -> String {
    let host = if matches!(config.auth, ResolvedSshAuth::Config { .. }) {
        config
            .config_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&config.host)
    } else {
        &config.host
    };
    format!("{}@{host}", config.username)
}

pub struct SshTmuxTransport {
    config: SshConnectConfig,
    executor: SpawnExecutor,
    invocation_builder: Arc<dyn SshInvocationBuilder>,
    command_session: Mutex<Option<SshCommandSession>>,
    tmux_bin: String,
    home_dir: String,
    tmux_version: String,
}

impl fmt::Debug for SshTmuxTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshTmuxTransport")
            .field("host", &self.config.host)
            .field("port", &self.config.port)
            .field("username", &self.config.username)
            .field("tmux_bin", &self.tmux_bin)
            .field("home_dir", &self.home_dir)
            .field("tmux_version", &self.tmux_version)
            .finish_non_exhaustive()
    }
}

impl SshTmuxTransport {
    pub async fn connect(
        config: SshConnectConfig,
        executor: SpawnExecutor,
        invocation_builder: Arc<dyn SshInvocationBuilder>,
    ) -> Result<Self, TmuxTransportError> {
        let spec =
            invocation_builder.build(&config, SpawnPurpose::SshCommandClient, "/bin/sh -s")?;
        let mut session = SshCommandSession::spawn(&executor, spec, &config.auth)?;
        let bootstrap = session
            .run_shell(
                build_ssh_bootstrap_script(),
                Duration::from_secs(10),
                DEFAULT_OUTPUT_LIMIT,
            )
            .await?;
        let (tmux_bin, tmux_version, home_dir) = match parse_ssh_bootstrap_output(&bootstrap.stdout)
        {
            ParsedSshBootstrap::Success {
                tmux_bin,
                tmux_version,
                home_dir,
            } => (tmux_bin, tmux_version, home_dir),
            ParsedSshBootstrap::Failure { reason } => {
                let reason = append_ssh_diagnostic(reason, &session.stderr_diagnostic().await);
                session.close().await;
                return Err(TmuxTransportError::Bootstrap(reason));
            }
        };
        Ok(Self {
            config,
            executor,
            invocation_builder,
            command_session: Mutex::new(Some(session)),
            tmux_bin,
            home_dir,
            tmux_version,
        })
    }

    pub fn tmux_version(&self) -> &str {
        &self.tmux_version
    }

    pub async fn probe(
        config: &SshConnectConfig,
        executor: &SpawnExecutor,
        invocation_builder: &dyn SshInvocationBuilder,
    ) -> Result<ParsedSshBootstrap, TmuxTransportError> {
        let spec = invocation_builder.build(config, SpawnPurpose::SshProbe, "/bin/sh -s")?;
        let output = executor
            .run_bounded_with_input(
                spec,
                Duration::from_secs(10),
                DEFAULT_OUTPUT_LIMIT,
                DEFAULT_OUTPUT_LIMIT,
                Some(format!("{}\n", build_ssh_bootstrap_script()).as_bytes()),
            )
            .await?;
        if output.exit_code != 0 {
            let redactor = SshDiagnosticRedactor::from_auth(&config.auth);
            let stderr = redactor.redact(&output.stderr);
            let detail = if stderr.is_empty() {
                redactor.redact(&output.stdout)
            } else {
                stderr
            };
            return Err(TmuxTransportError::Bootstrap(detail));
        }
        Ok(parse_ssh_bootstrap_output(&output.stdout_text()))
    }

    async fn ensure_command_session(
        &self,
        slot: &mut Option<SshCommandSession>,
    ) -> Result<(), TmuxTransportError> {
        if slot.is_some() {
            return Ok(());
        }
        let spec = self.invocation_builder.build(
            &self.config,
            SpawnPurpose::SshCommandClient,
            "/bin/sh -s",
        )?;
        *slot = Some(SshCommandSession::spawn(
            &self.executor,
            spec,
            &self.config.auth,
        )?);
        Ok(())
    }
}

#[async_trait]
impl TmuxTransport for SshTmuxTransport {
    async fn run_tmux(
        &self,
        args: &[String],
        deadline: Duration,
        output_limit: usize,
    ) -> Result<TmuxCommandResult, TmuxTransportError> {
        let command = format!(
            "{} {}",
            super::quote_shell_arg(&self.tmux_bin),
            join_shell_args(args)
        );
        let mut slot = self.command_session.lock().await;
        self.ensure_command_session(&mut slot).await?;
        let result = slot
            .as_mut()
            .ok_or(TmuxTransportError::Closed)?
            .run_shell(&command, deadline, output_limit)
            .await;
        if result.is_err() && !matches!(result, Err(TmuxTransportError::CommandTimedOut(_))) {
            if let Some(mut session) = slot.take() {
                session.close().await;
            }
        }
        result
    }

    async fn open_control(&self, session_name: &str) -> Result<ControlClient, TmuxTransportError> {
        let spec = self.invocation_builder.build(
            &self.config,
            SpawnPurpose::SshControlClient,
            "/bin/sh -s",
        )?;
        let mut control = control_from_child(self.executor.spawn(spec)?)?;
        let command = format!(
            "exec {} {}\n",
            super::quote_shell_arg(&self.tmux_bin),
            join_shell_args(["-C", "attach-session", "-t", session_name])
        );
        control.stdin.write_all(command.as_bytes()).await?;
        control.stdin.flush().await?;
        Ok(control)
    }

    fn home_dir(&self) -> Option<&str> {
        Some(&self.home_dir)
    }

    fn tmux_bin(&self) -> &str {
        &self.tmux_bin
    }

    async fn ensure_ghostty_terminfo(&self) -> bool {
        let mut slot = self.command_session.lock().await;
        if self.ensure_command_session(&mut slot).await.is_err() {
            return false;
        }
        let Some(session) = slot.as_mut() else {
            return false;
        };
        let result = session
            .run_shell(
                &super::build_ensure_ghostty_terminfo_script(),
                Duration::from_secs(15),
                1024,
            )
            .await;
        match result {
            Ok(result) => result.exit_code == 0,
            Err(TmuxTransportError::CommandTimedOut(_)) => false,
            Err(_) => {
                if let Some(mut session) = slot.take() {
                    session.close().await;
                }
                false
            }
        }
    }

    async fn close(&self) -> Result<(), TmuxTransportError> {
        if let Some(mut session) = self.command_session.lock().await.take() {
            session.close().await;
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
struct SshDiagnosticRedactor {
    secrets: Vec<super::SecretString>,
}

impl SshDiagnosticRedactor {
    fn from_auth(auth: &ResolvedSshAuth) -> Self {
        let mut secrets = Vec::new();
        match auth {
            ResolvedSshAuth::Password(password) => secrets.push(password.clone()),
            ResolvedSshAuth::Key {
                private_key,
                passphrase,
            } => {
                secrets.push(private_key.clone());
                secrets.extend(passphrase.iter().cloned());
            }
            ResolvedSshAuth::Auto {
                private_key,
                password,
                ..
            } => {
                secrets.extend(private_key.iter().cloned());
                secrets.extend(password.iter().cloned());
            }
            ResolvedSshAuth::Agent { .. } | ResolvedSshAuth::Config { .. } => {}
        }
        Self { secrets }
    }

    fn redact(&self, bytes: &[u8]) -> String {
        let start = bytes.len().saturating_sub(SSH_STDERR_TAIL_LIMIT);
        let mut diagnostic = String::from_utf8_lossy(&bytes[start..]).into_owned();
        for secret in &self.secrets {
            if !secret.expose().is_empty() {
                diagnostic = diagnostic.replace(secret.expose(), "[REDACTED:ssh-credential]");
            }
        }
        diagnostic = crate::agent::redact_secrets(&diagnostic).text;
        diagnostic
            .retain(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'));
        bounded_utf8_tail(diagnostic.trim(), SSH_STDERR_TAIL_LIMIT)
    }
}

fn bounded_utf8_tail(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn append_ssh_diagnostic(mut message: String, stderr_tail: &str) -> String {
    if !stderr_tail.is_empty() {
        message.push_str("; ssh stderr: ");
        message.push_str(stderr_tail);
    }
    message
}

struct SshCommandSession {
    child: SpawnedChild,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stdout_buffer: Vec<u8>,
    stderr_tail: Arc<StdMutex<Vec<u8>>>,
    stderr_task: JoinHandle<()>,
    diagnostic_redactor: SshDiagnosticRedactor,
}

impl SshCommandSession {
    fn spawn(
        executor: &SpawnExecutor,
        spec: CommandSpec,
        auth: &ResolvedSshAuth,
    ) -> Result<Self, TmuxTransportError> {
        let mut child = executor.spawn(spec)?;
        let stdin = child.take_stdin().ok_or(SpawnError::MissingPipe("stdin"))?;
        let stdout = child
            .take_stdout()
            .ok_or(SpawnError::MissingPipe("stdout"))?;
        let stderr = child
            .take_stderr()
            .ok_or(SpawnError::MissingPipe("stderr"))?;
        let stderr_tail = Arc::new(StdMutex::new(Vec::new()));
        let stderr_task = tokio::spawn(pump_stderr_tail(stderr, stderr_tail.clone()));
        Ok(Self {
            child,
            stdin,
            stdout,
            stdout_buffer: Vec::new(),
            stderr_tail,
            stderr_task,
            diagnostic_redactor: SshDiagnosticRedactor::from_auth(auth),
        })
    }

    async fn run_shell(
        &mut self,
        command: &str,
        deadline: Duration,
        output_limit: usize,
    ) -> Result<TmuxCommandResult, TmuxTransportError> {
        let command_id = Uuid::new_v4().to_string();
        let payload = build_ssh_shell_command_frame(command, &command_id);
        self.stdin.write_all(payload.as_bytes()).await?;
        self.stdin.flush().await?;
        let result = match timeout(
            deadline,
            read_command_frame(
                &mut self.stdout,
                &mut self.stdout_buffer,
                &command_id,
                output_limit,
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(TmuxTransportError::CommandTimedOut(deadline)),
        };
        if result.is_err() {
            let stderr_tail = self.stderr_diagnostic().await;
            return result.map_err(|error| error.with_ssh_stderr(stderr_tail));
        }
        result
    }

    async fn stderr_diagnostic(&self) -> String {
        tokio::task::yield_now().await;
        let tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.diagnostic_redactor.redact(&tail)
    }

    async fn close(&mut self) {
        self.stdin.shutdown().await.ok();
        self.child.kill().await.ok();
        self.child.wait().await.ok();
        self.stderr_task.abort();
    }
}

async fn read_command_frame(
    stdout: &mut ChildStdout,
    buffer: &mut Vec<u8>,
    command_id: &str,
    output_limit: usize,
) -> Result<TmuxCommandResult, TmuxTransportError> {
    let mut marker = COMMAND_SENTINEL.to_vec();
    marker.extend_from_slice(command_id.as_bytes());
    marker.push(b' ');
    loop {
        if let Some(()) = drain_orphan_frame(buffer, &marker, output_limit)? {
            continue;
        }
        if let Some(result) = take_command_frame(buffer, &marker, output_limit)? {
            return Ok(result);
        }
        if buffer.len() > output_limit.saturating_add(marker.len()).saturating_add(64) {
            return Err(TmuxTransportError::CommandOutputTooLarge(output_limit));
        }
        let mut chunk = [0_u8; 8192];
        let read = stdout.read(&mut chunk).await?;
        if read == 0 {
            return Err(TmuxTransportError::Closed);
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

pub fn build_ssh_shell_command_frame(command: &str, command_id: &str) -> String {
    format!(
        "{{ {command}; }} 2>&1\nprintf '\\036TMEX_END %s %d\\036\\n' {} $?\n",
        super::quote_shell_arg(command_id)
    )
}

fn take_command_frame(
    buffer: &mut Vec<u8>,
    marker: &[u8],
    output_limit: usize,
) -> Result<Option<TmuxCommandResult>, TmuxTransportError> {
    let Some(marker_start) = find_bytes(buffer, marker) else {
        return Ok(None);
    };
    if marker_start > output_limit {
        return Err(TmuxTransportError::CommandOutputTooLarge(output_limit));
    }
    let status_start = marker_start + marker.len();
    let Some(relative_end) = buffer[status_start..].iter().position(|byte| *byte == 0x1e) else {
        return Ok(None);
    };
    let frame_end = status_start + relative_end;
    let status = std::str::from_utf8(&buffer[status_start..frame_end])
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .ok_or(TmuxTransportError::InvalidCommandFrame)?;
    let output = String::from_utf8_lossy(&buffer[..marker_start]).into_owned();
    let mut drain_end = frame_end + 1;
    while buffer
        .get(drain_end)
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        drain_end += 1;
    }
    buffer.drain(..drain_end);
    Ok(Some(TmuxCommandResult {
        exit_code: status,
        stdout: output,
        stderr: String::new(),
    }))
}

fn drain_orphan_frame(
    buffer: &mut Vec<u8>,
    own_marker: &[u8],
    output_limit: usize,
) -> Result<Option<()>, TmuxTransportError> {
    let Some(sentinel_at) = find_bytes(buffer, COMMAND_SENTINEL) else {
        return Ok(None);
    };
    if buffer[sentinel_at..].starts_with(own_marker) {
        return Ok(None);
    }
    if sentinel_at > output_limit {
        return Err(TmuxTransportError::CommandOutputTooLarge(output_limit));
    }
    let status_start = sentinel_at + COMMAND_SENTINEL.len();
    let Some(relative_end) = buffer[status_start..].iter().position(|byte| *byte == 0x1e) else {
        return Ok(None);
    };
    let mut drain_end = status_start + relative_end + 1;
    while buffer
        .get(drain_end)
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        drain_end += 1;
    }
    buffer.drain(..drain_end);
    Ok(Some(()))
}

async fn pump_stderr_tail(mut stderr: ChildStderr, tail: Arc<StdMutex<Vec<u8>>>) {
    let mut chunk = [0_u8; 1024];
    loop {
        let Ok(read) = stderr.read(&mut chunk).await else {
            break;
        };
        if read == 0 {
            break;
        }
        let mut tail = tail
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        tail.extend_from_slice(&chunk[..read]);
        let overflow = tail.len().saturating_sub(SSH_STDERR_TAIL_LIMIT);
        if overflow > 0 {
            tail.drain(..overflow);
        }
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    (!needle.is_empty())
        .then(|| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        })
        .flatten()
}

fn control_from_child(mut child: SpawnedChild) -> Result<ControlClient, TmuxTransportError> {
    let stdin = child.take_stdin().ok_or(SpawnError::MissingPipe("stdin"))?;
    let stdout = child
        .take_stdout()
        .ok_or(SpawnError::MissingPipe("stdout"))?;
    let stderr = child
        .take_stderr()
        .ok_or(SpawnError::MissingPipe("stderr"))?;
    Ok(ControlClient {
        child,
        stdin,
        stdout,
        stderr,
    })
}

fn command_result(output: CommandOutput) -> TmuxCommandResult {
    TmuxCommandResult {
        exit_code: output.exit_code,
        stdout: output.stdout_text(),
        stderr: output.stderr_text(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::tmux::SecretString;

    struct TestCredentialFileWriter {
        cleanup_called: Arc<AtomicBool>,
    }

    impl OpenSshCredentialFileWriter for TestCredentialFileWriter {
        fn write_restricted(
            &self,
            path: &Path,
            contents: &[u8],
            _kind: OpenSshCredentialFileKind,
        ) -> io::Result<()> {
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(contents)
        }

        fn cleanup_temp_dir(&self, directory: tempfile::TempDir) {
            self.cleanup_called.store(true, Ordering::Release);
            drop(directory);
        }
    }

    fn ssh_config(auth: ResolvedSshAuth) -> SshConnectConfig {
        SshConnectConfig {
            host: "example.com".to_owned(),
            port: 22,
            username: "alice".to_owned(),
            config_ref: None,
            auth,
            subprocess_environment: BTreeMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), "/Users/alice".to_owned()),
            ]),
        }
    }

    fn option_value<'a>(args: &'a [String], option: &str) -> Option<&'a str> {
        args.windows(2)
            .find(|window| window[0] == option)
            .map(|window| window[1].as_str())
    }

    #[test]
    fn local_socket_is_always_inserted_before_tmux_command() {
        assert_eq!(
            build_local_tmux_argv(
                &[
                    "has-session".to_owned(),
                    "-t".to_owned(),
                    "safe-test".to_owned()
                ],
                "/opt/tmux",
                Some("tmex-e2e"),
            ),
            [
                "/opt/tmux",
                "-L",
                "tmex-e2e",
                "has-session",
                "-t",
                "safe-test",
            ]
        );
    }

    #[test]
    fn openssh_builder_is_noninteractive_and_preserves_config_alias() {
        let mut config = ssh_config(ResolvedSshAuth::Config {
            agent_socket: Some("/tmp/config-agent.sock".to_owned()),
            identity_file: None,
        });
        config.host = "resolved.internal".to_owned();
        config.port = 2202;
        config.config_ref = Some("  jump-alias  ".to_owned());
        config
            .subprocess_environment
            .insert("TMEX_MASTER_KEY".to_owned(), "must-not-leak".to_owned());
        config
            .subprocess_environment
            .insert("DATABASE_URL".to_owned(), "must-not-leak.db".to_owned());
        let spec = SystemOpenSshInvocationBuilder::default()
            .build(&config, SpawnPurpose::SshProbe, "true")
            .unwrap();

        assert!(spec
            .args
            .iter()
            .any(|arg| arg == "StrictHostKeyChecking=no"));
        assert!(spec
            .args
            .iter()
            .any(|arg| arg == "UserKnownHostsFile=/dev/null"));
        assert!(spec.args.iter().any(|arg| arg == "ConnectTimeout=20"));
        assert!(spec.args.iter().any(|arg| arg == "BatchMode=yes"));
        assert!(spec.args.iter().any(|arg| arg == "alice@jump-alias"));
        assert!(spec.clear_env);
        assert!(!spec.env.contains_key("TMEX_MASTER_KEY"));
        assert!(!spec.env.contains_key("DATABASE_URL"));
        assert!(!spec
            .args
            .iter()
            .any(|arg| arg.contains("resolved.internal")));
    }

    #[test]
    fn injected_askpass_and_opaque_lease_are_reusable_without_secret_exposure() {
        let secret = "injected-helper-secret-marker";
        let cleanup_called = Arc::new(AtomicBool::new(false));
        let builder = SystemOpenSshInvocationBuilder::default()
            .with_askpass_executable(OpenSshAskpassExecutable::new(
                PathBuf::from("host-current-exe"),
                BTreeMap::from([("TMEX_GATEWAY_HELPER".to_owned(), "askpass".to_owned())]),
            ))
            .with_credential_file_writer(Arc::new(TestCredentialFileWriter {
                cleanup_called: cleanup_called.clone(),
            }));
        let lease = builder
            .prepare_credentials(&ResolvedSshAuth::Password(SecretString::new(secret)))
            .unwrap();
        let debug = format!("{lease:?}");
        let mut args = vec!["-T".to_owned()];
        let mut environment = BTreeMap::new();
        lease.apply(&mut args, &mut environment);

        let secret_path = PathBuf::from(&environment[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]);
        let workspace = secret_path.parent().unwrap().to_path_buf();
        assert_eq!(environment["SSH_ASKPASS"], "host-current-exe");
        assert_eq!(environment["TMEX_GATEWAY_HELPER"], "askpass");
        assert_eq!(environment[TMEX_SSH_ASKPASS_MODE_ENV], "1");
        assert_eq!(fs::read_to_string(&secret_path).unwrap(), secret);
        assert!(!args.join(" ").contains(secret));
        assert!(!debug.contains(secret));

        drop(lease);
        assert!(cleanup_called.load(Ordering::Acquire));
        assert!(!workspace.exists());
    }

    #[test]
    #[cfg(unix)]
    fn system_openssh_builder_uses_restricted_files_without_leaking_credentials() {
        use std::os::unix::fs::PermissionsExt;

        let private_key = "private-key-plaintext-marker";
        let passphrase = "passphrase-plaintext-marker";
        let builder = SystemOpenSshInvocationBuilder::default();
        let spec = builder
            .build(
                &ssh_config(ResolvedSshAuth::Key {
                    private_key: SecretString::new(private_key),
                    passphrase: Some(SecretString::new(passphrase)),
                }),
                SpawnPurpose::SshProbe,
                "/bin/sh -s",
            )
            .unwrap();

        let key_path = PathBuf::from(option_value(&spec.args, "-i").unwrap());
        let secret_path = PathBuf::from(&spec.env[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]);
        let askpass_path = PathBuf::from(&spec.env["SSH_ASKPASS"]);
        let workspace = key_path.parent().unwrap().to_path_buf();
        assert_eq!(fs::read_to_string(&key_path).unwrap(), private_key);
        assert_eq!(fs::read_to_string(&secret_path).unwrap(), passphrase);
        assert_eq!(
            fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&askpass_path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(spec.args.iter().any(|arg| arg == "IdentitiesOnly=yes"));
        assert!(!spec.args.iter().any(|arg| arg == "BatchMode=yes"));
        assert_eq!(spec.env["SSH_ASKPASS_REQUIRE"], "force");
        assert_eq!(spec.env[TMEX_SSH_ASKPASS_MODE_ENV], "1");

        let debug = format!("{spec:?}");
        let argv = spec.args.join(" ");
        for secret in [private_key, passphrase] {
            assert!(!debug.contains(secret));
            assert!(!argv.contains(secret));
        }
        drop(spec);
        assert!(!workspace.exists());
    }

    #[test]
    #[cfg(unix)]
    fn auto_auth_preserves_password_fallback_with_agent() {
        let builder = SystemOpenSshInvocationBuilder::default();
        let ignored_identity = PathBuf::from("/tmp/ignored-identity");
        let key_spec = builder
            .build(
                &ssh_config(ResolvedSshAuth::Auto {
                    agent_socket: Some("/tmp/agent.sock".to_owned()),
                    private_key: Some(SecretString::new("preferred-key")),
                    password: Some(SecretString::new("ignored-password")),
                    identity_file: Some(ignored_identity.clone()),
                }),
                SpawnPurpose::SshProbe,
                "true",
            )
            .unwrap();
        let key_path = PathBuf::from(option_value(&key_spec.args, "-i").unwrap());
        assert_eq!(fs::read_to_string(&key_path).unwrap(), "preferred-key");
        assert!(!key_spec
            .args
            .contains(&ignored_identity.display().to_string()));
        assert_eq!(key_spec.env["SSH_AUTH_SOCK"], "/tmp/agent.sock");
        assert!(!key_spec.env.contains_key(TMEX_SSH_ASKPASS_SECRET_FILE_ENV));
        assert!(key_spec.args.iter().any(|arg| arg == "BatchMode=yes"));

        let agent_spec = builder
            .build(
                &ssh_config(ResolvedSshAuth::Auto {
                    agent_socket: Some("/tmp/agent.sock".to_owned()),
                    private_key: None,
                    password: Some(SecretString::new("password-fallback")),
                    identity_file: None,
                }),
                SpawnPurpose::SshProbe,
                "true",
            )
            .unwrap();
        assert_eq!(agent_spec.env["SSH_AUTH_SOCK"], "/tmp/agent.sock");
        assert_eq!(
            fs::read_to_string(&agent_spec.env[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]).unwrap(),
            "password-fallback"
        );
        assert!(!agent_spec.args.iter().any(|arg| arg == "BatchMode=yes"));
        assert!(agent_spec.args.iter().any(|arg| {
            arg == "PreferredAuthentications=password,keyboard-interactive,publickey"
        }));

        let password_spec = builder
            .build(
                &ssh_config(ResolvedSshAuth::Auto {
                    agent_socket: None,
                    private_key: None,
                    password: Some(SecretString::new("password-fallback")),
                    identity_file: None,
                }),
                SpawnPurpose::SshProbe,
                "true",
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(&password_spec.env[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]).unwrap(),
            "password-fallback"
        );
        assert!(password_spec
            .args
            .iter()
            .any(|arg| arg == "PreferredAuthentications=password,keyboard-interactive"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn credential_workspace_follows_spawned_child_lifetime() {
        let builder = SystemOpenSshInvocationBuilder::default();
        let mut spec = builder
            .build(
                &ssh_config(ResolvedSshAuth::Password(SecretString::new(
                    "child-lifetime-secret",
                ))),
                SpawnPurpose::SshProbe,
                "true",
            )
            .unwrap();
        let secret_path = PathBuf::from(&spec.env[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]);
        let workspace = secret_path.parent().unwrap().to_path_buf();
        spec.program = "/bin/sh".to_owned();
        spec.args = vec!["-c".to_owned(), "sleep 30".to_owned()];
        let child = SpawnExecutor::standalone().spawn(spec).unwrap();
        assert!(workspace.exists());
        drop(child);
        timeout(Duration::from_secs(1), async {
            while workspace.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn ssh_shell_frame_is_quoted_and_incrementally_decoded_by_exact_id() {
        assert_eq!(
            build_ssh_shell_command_frame("printf hello", "id-1"),
            "{ printf hello; } 2>&1\nprintf '\\036TMEX_END %s %d\\036\\n' 'id-1' $?\n"
        );
        let mut marker = COMMAND_SENTINEL.to_vec();
        marker.extend_from_slice(b"id-1 ");
        let mut bytes = b"prefix\x1eTMEX_END other 0\x1e\nhello".to_vec();
        assert!(take_command_frame(&mut bytes, &marker, 1024)
            .unwrap()
            .is_none());
        bytes.extend_from_slice(b"\x1eTMEX_END id-1 7\x1e\r\nnext");
        let decoded = take_command_frame(&mut bytes, &marker, 1024)
            .unwrap()
            .unwrap();
        assert_eq!(decoded.exit_code, 7);
        assert_eq!(decoded.stdout, "prefix\x1eTMEX_END other 0\x1e\nhello");
        assert_eq!(bytes, b"next");
    }

    #[test]
    fn ssh_shell_frame_rejects_output_over_limit_when_marker_arrives_in_same_chunk() {
        let mut marker = COMMAND_SENTINEL.to_vec();
        marker.extend_from_slice(b"id-1 ");
        let mut bytes = vec![b'x'; 9];
        bytes.extend_from_slice(b"\x1eTMEX_END id-1 0\x1e\n");

        assert!(matches!(
            take_command_frame(&mut bytes, &marker, 8),
            Err(TmuxTransportError::CommandOutputTooLarge(8))
        ));
    }

    #[test]
    fn ssh_diagnostics_are_bounded_and_redact_known_and_structured_secrets() {
        let password = "plain-password-marker";
        let token = "sk-1234567890abcdefghijklmnop";
        let redactor = SshDiagnosticRedactor::from_auth(&ResolvedSshAuth::Password(
            SecretString::new(password),
        ));
        let raw = format!(
            "{}permission denied for {password}; Authorization: Bearer {token}",
            "x".repeat(SSH_STDERR_TAIL_LIMIT)
        );
        let diagnostic = redactor.redact(raw.as_bytes());

        assert!(diagnostic.len() <= SSH_STDERR_TAIL_LIMIT);
        assert!(diagnostic.contains("permission denied"));
        assert!(!diagnostic.contains(password));
        assert!(!diagnostic.contains(token));
        for error in [
            TmuxTransportError::Closed,
            TmuxTransportError::CommandTimedOut(Duration::from_secs(1)),
            TmuxTransportError::InvalidCommandFrame,
        ] {
            let rendered = error.with_ssh_stderr(diagnostic.clone()).to_string();
            assert!(rendered.contains("ssh stderr"));
            assert!(!rendered.contains(password));
            assert!(!rendered.contains(token));
        }
        let bootstrap = TmuxTransportError::Bootstrap(append_ssh_diagnostic(
            "tmux unavailable".to_owned(),
            &diagnostic,
        ))
        .to_string();
        assert!(bootstrap.contains("ssh stderr"));
        assert!(!bootstrap.contains(password));
        assert!(!bootstrap.contains(token));
    }
}
