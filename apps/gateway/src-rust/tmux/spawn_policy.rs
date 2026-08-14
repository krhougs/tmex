use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::time::timeout;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnPurpose {
    LocalEnvironmentProbe,
    TmuxClientMayStartServer,
    TmuxControlClient,
    SshProbe,
    SshCommandClient,
    SshControlClient,
}

impl SpawnPurpose {
    pub fn may_outlive_gateway(self) -> bool {
        matches!(
            self,
            Self::TmuxClientMayStartServer
                | Self::TmuxControlClient
                | Self::SshCommandClient
                | Self::SshControlClient
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnIsolation {
    StandaloneProcessGroup,
    HostManaged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub purpose: SpawnPurpose,
    pub program: String,
}

pub trait SpawnPolicy: Send + Sync + 'static {
    fn isolation(&self) -> SpawnIsolation;

    fn configure(&self, request: &SpawnRequest, command: &mut Command) -> io::Result<()>;
}

#[derive(Clone, Debug, Default)]
pub struct StandaloneSpawnPolicy;

impl SpawnPolicy for StandaloneSpawnPolicy {
    fn isolation(&self) -> SpawnIsolation {
        SpawnIsolation::StandaloneProcessGroup
    }

    fn configure(&self, request: &SpawnRequest, command: &mut Command) -> io::Result<()> {
        if !request.purpose.may_outlive_gateway() {
            return Ok(());
        }
        configure_standalone_process_group(command);
        Ok(())
    }
}

#[cfg(unix)]
fn configure_standalone_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
fn configure_standalone_process_group(command: &mut Command) {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_standalone_process_group(_command: &mut Command) {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandStdin {
    Null,
    Piped,
}

pub(crate) struct RetainedTempDir {
    path: PathBuf,
    directory: Option<tempfile::TempDir>,
    cleanup: Box<dyn Fn(tempfile::TempDir) + Send + Sync>,
}

impl RetainedTempDir {
    pub(crate) fn new(
        directory: tempfile::TempDir,
        cleanup: impl Fn(tempfile::TempDir) + Send + Sync + 'static,
    ) -> Self {
        let path = directory.path().to_path_buf();
        Self {
            path,
            directory: Some(directory),
            cleanup: Box::new(cleanup),
        }
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for RetainedTempDir {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.take() {
            (self.cleanup)(directory);
        }
    }
}

#[derive(Clone)]
pub struct CommandSpec {
    pub purpose: SpawnPurpose,
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub clear_env: bool,
    pub cwd: Option<PathBuf>,
    pub stdin: CommandStdin,
    retained_temp_dirs: Vec<Arc<RetainedTempDir>>,
}

impl fmt::Debug for CommandSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandSpec")
            .field("purpose", &self.purpose)
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .field("clear_env", &self.clear_env)
            .field("cwd", &self.cwd)
            .field("stdin", &self.stdin)
            .field("retained_temp_dir_count", &self.retained_temp_dirs.len())
            .finish()
    }
}

impl PartialEq for CommandSpec {
    fn eq(&self, other: &Self) -> bool {
        self.purpose == other.purpose
            && self.program == other.program
            && self.args == other.args
            && self.env == other.env
            && self.clear_env == other.clear_env
            && self.cwd == other.cwd
            && self.stdin == other.stdin
    }
}

impl Eq for CommandSpec {}

impl CommandSpec {
    pub fn new(purpose: SpawnPurpose, program: impl Into<String>) -> Self {
        Self {
            purpose,
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            clear_env: false,
            cwd: None,
            stdin: CommandStdin::Null,
            retained_temp_dirs: Vec::new(),
        }
    }

    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn piped_stdin(mut self) -> Self {
        self.stdin = CommandStdin::Piped;
        self
    }

    pub fn with_env(mut self, env: BTreeMap<String, String>, clear_env: bool) -> Self {
        self.env = env;
        self.clear_env = clear_env;
        self
    }

    pub(crate) fn retain_temp_dir(mut self, directory: Arc<RetainedTempDir>) -> Self {
        self.retained_temp_dirs.push(directory);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

#[derive(Debug)]
pub enum SpawnError {
    Configure(io::Error),
    Spawn(io::Error),
    Io(io::Error),
    TimedOut(Duration),
    OutputLimitExceeded { stream: &'static str, limit: usize },
    MissingPipe(&'static str),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configure(error) => write!(formatter, "spawn policy rejected command: {error}"),
            Self::Spawn(error) => write!(formatter, "failed to spawn command: {error}"),
            Self::Io(error) => write!(formatter, "child process I/O failed: {error}"),
            Self::TimedOut(duration) => {
                write!(formatter, "child process timed out after {duration:?}")
            }
            Self::OutputLimitExceeded { stream, limit } => {
                write!(formatter, "child {stream} exceeded {limit} bytes")
            }
            Self::MissingPipe(name) => write!(formatter, "child {name} pipe is unavailable"),
        }
    }
}

impl std::error::Error for SpawnError {}

#[derive(Clone)]
pub struct SpawnExecutor {
    policy: Arc<dyn SpawnPolicy>,
}

impl SpawnExecutor {
    pub fn standalone() -> Self {
        Self::new(Arc::new(StandaloneSpawnPolicy))
    }

    pub fn new(policy: Arc<dyn SpawnPolicy>) -> Self {
        Self { policy }
    }

    pub fn isolation(&self) -> SpawnIsolation {
        self.policy.isolation()
    }

    pub fn spawn(&self, spec: CommandSpec) -> Result<SpawnedChild, SpawnError> {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        if spec.clear_env {
            command.env_clear();
        }
        command.envs(&spec.env);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        command.stdin(match spec.stdin {
            CommandStdin::Null => Stdio::null(),
            CommandStdin::Piped => Stdio::piped(),
        });
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let request = SpawnRequest {
            purpose: spec.purpose,
            program: spec.program.clone(),
        };
        self.policy
            .configure(&request, &mut command)
            .map_err(SpawnError::Configure)?;
        command.kill_on_drop(true);
        let child = command.spawn().map_err(SpawnError::Spawn)?;
        Ok(SpawnedChild {
            child: Some(child),
            retained_temp_dirs: spec.retained_temp_dirs,
        })
    }

    pub async fn run_bounded(
        &self,
        spec: CommandSpec,
        deadline: Duration,
        stdout_limit: usize,
        stderr_limit: usize,
    ) -> Result<CommandOutput, SpawnError> {
        self.run_bounded_with_input(spec, deadline, stdout_limit, stderr_limit, None)
            .await
    }

    pub async fn run_bounded_with_input(
        &self,
        mut spec: CommandSpec,
        deadline: Duration,
        stdout_limit: usize,
        stderr_limit: usize,
        input: Option<&[u8]>,
    ) -> Result<CommandOutput, SpawnError> {
        if input.is_some() {
            spec.stdin = CommandStdin::Piped;
        }
        let mut child = self.spawn(spec)?;
        if let Some(input) = input {
            let mut stdin = child.take_stdin().ok_or(SpawnError::MissingPipe("stdin"))?;
            stdin.write_all(input).await.map_err(SpawnError::Io)?;
            stdin.shutdown().await.map_err(SpawnError::Io)?;
        }
        let stdout = child
            .take_stdout()
            .ok_or(SpawnError::MissingPipe("stdout"))?;
        let stderr = child
            .take_stderr()
            .ok_or(SpawnError::MissingPipe("stderr"))?;
        let stdout_task = tokio::spawn(read_bounded(stdout, stdout_limit, "stdout"));
        let stderr_task = tokio::spawn(read_bounded(stderr, stderr_limit, "stderr"));
        let status = match timeout(deadline, child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(SpawnError::TimedOut(deadline));
            }
        };
        let stdout = stdout_task
            .await
            .map_err(|error| SpawnError::Io(io::Error::other(error)))??;
        let stderr = stderr_task
            .await
            .map_err(|error| SpawnError::Io(io::Error::other(error)))??;
        Ok(CommandOutput {
            exit_code: status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    }
}

pub struct SpawnedChild {
    child: Option<Child>,
    retained_temp_dirs: Vec<Arc<RetainedTempDir>>,
}

impl SpawnedChild {
    pub fn id(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.as_mut()?.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.as_mut()?.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.as_mut()?.stderr.take()
    }

    pub async fn wait(&mut self) -> Result<std::process::ExitStatus, SpawnError> {
        self.child
            .as_mut()
            .ok_or(SpawnError::MissingPipe("process"))?
            .wait()
            .await
            .map_err(SpawnError::Io)
    }

    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, SpawnError> {
        self.child
            .as_mut()
            .ok_or(SpawnError::MissingPipe("process"))?
            .try_wait()
            .map_err(SpawnError::Io)
    }

    pub async fn kill(&mut self) -> Result<(), SpawnError> {
        self.child
            .as_mut()
            .ok_or(SpawnError::MissingPipe("process"))?
            .kill()
            .await
            .map_err(SpawnError::Io)
    }
}

impl Drop for SpawnedChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if self.retained_temp_dirs.is_empty() || matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.start_kill();
        let retained_temp_dirs = std::mem::take(&mut self.retained_temp_dirs);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            drop(runtime.spawn(async move {
                let _ = child.wait().await;
                drop(retained_temp_dirs);
            }));
        }
    }
}

async fn read_bounded<R>(
    reader: R,
    limit: usize,
    stream: &'static str,
) -> Result<Vec<u8>, SpawnError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(SpawnError::Io)?;
    if bytes.len() > limit {
        return Err(SpawnError::OutputLimitExceeded { stream, limit });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct RecordingPolicy {
        requests: Arc<Mutex<Vec<SpawnRequest>>>,
    }

    impl SpawnPolicy for RecordingPolicy {
        fn isolation(&self) -> SpawnIsolation {
            SpawnIsolation::HostManaged
        }

        fn configure(&self, request: &SpawnRequest, _command: &mut Command) -> io::Result<()> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(())
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn every_spawn_is_observed_by_the_injected_policy() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executor = SpawnExecutor::new(Arc::new(RecordingPolicy {
            requests: requests.clone(),
        }));
        let output = executor
            .run_bounded(
                CommandSpec::new(SpawnPurpose::TmuxClientMayStartServer, "/bin/sh")
                    .args(["-c", "printf ok"]),
                Duration::from_secs(1),
                16,
                16,
            )
            .await
            .unwrap();
        assert_eq!(output.stdout, b"ok");
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            &[SpawnRequest {
                purpose: SpawnPurpose::TmuxClientMayStartServer,
                program: "/bin/sh".to_owned(),
            }]
        );
    }
}
