use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::process::{ExitStatus, Stdio};

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use crate::crypto::{CryptoContext, MasterKey};
use crate::entity::devices;
use crate::tmux::{
    resolve_ssh_agent_socket, resolve_ssh_username, ResolvedSshAuth, SecretString, SshAuthMode,
    SystemOpenSshInvocationBuilder,
};

use super::{
    parse_rsync_progress, FileErrorCode, FileRuntime, FileRuntimeError, PreparedRsyncDevice,
    RsyncProgress, RsyncRequest, RsyncResult, RsyncTimeout,
};

const RSYNC_TIMEOUT_MARKER: &str = "\n[tmex] rsync timed out";

#[derive(Clone)]
pub struct SystemFileRuntime {
    master_key: MasterKey,
    credentials: SystemOpenSshInvocationBuilder,
    environment: BTreeMap<String, String>,
}

impl SystemFileRuntime {
    pub fn new(master_key: MasterKey) -> Self {
        Self::with_credential_builder(master_key, SystemOpenSshInvocationBuilder::default())
    }

    pub fn with_credential_builder(
        master_key: MasterKey,
        credentials: SystemOpenSshInvocationBuilder,
    ) -> Self {
        Self {
            master_key,
            credentials,
            environment: std::env::vars().collect(),
        }
    }

    fn prepare_ssh(
        &self,
        device: &devices::Model,
    ) -> Result<PreparedRsyncDevice, FileRuntimeError> {
        let mode = parse_auth_mode(device)?;
        if mode == SshAuthMode::ConfigRef {
            let alias = normalized(device.ssh_config_ref.as_deref()).ok_or_else(|| {
                FileRuntimeError::new(FileErrorCode::AuthUnsupported, "SSH Config 引用不能为空")
            })?;
            return Ok(PreparedRsyncDevice::new(
                format!("{alias}:"),
                Some(
                    [
                        "ssh",
                        "-o",
                        "StrictHostKeyChecking=accept-new",
                        "-o",
                        "ConnectTimeout=10",
                        "-o",
                        "BatchMode=yes",
                    ]
                    .join(" "),
                ),
                BTreeMap::new(),
                || {},
            ));
        }

        let host = normalized(device.host.as_deref()).ok_or_else(|| {
            FileRuntimeError::new(FileErrorCode::ConnectionFailed, "SSH 设备缺少 host")
        })?;
        let port = device
            .port
            .map(u16::try_from)
            .transpose()
            .map_err(|_| {
                FileRuntimeError::new(FileErrorCode::ConnectionFailed, "SSH 设备端口超出有效范围")
            })?
            .unwrap_or(22);
        let username = resolve_ssh_username(device.username.as_deref(), mode, &self.environment);
        let auth = self.resolve_auth(device, mode)?;
        let lease = self
            .credentials
            .prepare_credentials(&auth)
            .map_err(|error| {
                FileRuntimeError::new(FileErrorCode::AuthUnsupported, error.to_string())
            })?;
        let mut ssh_args = vec![
            "ssh".to_owned(),
            "-p".to_owned(),
            port.to_string(),
            "-o".to_owned(),
            "StrictHostKeyChecking=accept-new".to_owned(),
            "-o".to_owned(),
            "ConnectTimeout=10".to_owned(),
        ];
        let mut environment = BTreeMap::new();
        lease.apply(&mut ssh_args, &mut environment);
        Ok(PreparedRsyncDevice::new(
            format!("{username}@{host}:"),
            Some(ssh_args.join(" ")),
            environment,
            move || drop(lease),
        ))
    }

    fn resolve_auth(
        &self,
        device: &devices::Model,
        mode: SshAuthMode,
    ) -> Result<ResolvedSshAuth, FileRuntimeError> {
        match mode {
            SshAuthMode::Password => Ok(ResolvedSshAuth::Password(self.required_secret(
                device,
                "password_enc",
                device.password_enc.as_deref(),
            )?)),
            SshAuthMode::Key => Ok(ResolvedSshAuth::Key {
                private_key: self.required_secret(
                    device,
                    "private_key_enc",
                    device.private_key_enc.as_deref(),
                )?,
                passphrase: self.optional_secret(
                    device,
                    "private_key_passphrase_enc",
                    device.private_key_passphrase_enc.as_deref(),
                )?,
            }),
            SshAuthMode::Agent => {
                let socket = resolve_ssh_agent_socket(mode, &self.environment)
                    .map_err(|error| {
                        FileRuntimeError::new(FileErrorCode::AuthUnsupported, error.to_string())
                    })?
                    .ok_or_else(|| {
                        FileRuntimeError::new(
                            FileErrorCode::AuthUnsupported,
                            "SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证",
                        )
                    })?;
                Ok(ResolvedSshAuth::Agent {
                    socket,
                    fallback_identity_files: Vec::new(),
                })
            }
            SshAuthMode::Auto => self.resolve_auto_auth(device),
            SshAuthMode::ConfigRef => Err(FileRuntimeError::new(
                FileErrorCode::AuthUnsupported,
                "SSH Config 认证未提供可用引用",
            )),
        }
    }

    fn resolve_auto_auth(
        &self,
        device: &devices::Model,
    ) -> Result<ResolvedSshAuth, FileRuntimeError> {
        let agent_socket =
            resolve_ssh_agent_socket(SshAuthMode::Auto, &self.environment).map_err(|error| {
                FileRuntimeError::new(FileErrorCode::AuthUnsupported, error.to_string())
            })?;
        if let Some(private_key) =
            self.optional_secret(device, "private_key_enc", device.private_key_enc.as_deref())?
        {
            return Ok(ResolvedSshAuth::Auto {
                agent_socket,
                private_key: Some(private_key),
                password: None,
                identity_file: None,
            });
        }
        if agent_socket.is_some() {
            return Ok(ResolvedSshAuth::Auto {
                agent_socket,
                private_key: None,
                password: None,
                identity_file: None,
            });
        }
        if let Some(password) =
            self.optional_secret(device, "password_enc", device.password_enc.as_deref())?
        {
            return Ok(ResolvedSshAuth::Auto {
                agent_socket: None,
                private_key: None,
                password: Some(password),
                identity_file: None,
            });
        }
        Err(FileRuntimeError::new(
            FileErrorCode::AuthUnsupported,
            "未找到可用于 rsync 的认证方式（密钥 / ssh-agent / 密码）",
        ))
    }

    fn required_secret(
        &self,
        device: &devices::Model,
        field: &'static str,
        ciphertext: Option<&str>,
    ) -> Result<SecretString, FileRuntimeError> {
        self.optional_secret(device, field, ciphertext)?
            .ok_or_else(|| {
                FileRuntimeError::new(
                    FileErrorCode::AuthUnsupported,
                    format!("认证字段 {field} 未提供"),
                )
            })
    }

    fn optional_secret(
        &self,
        device: &devices::Model,
        field: &'static str,
        ciphertext: Option<&str>,
    ) -> Result<Option<SecretString>, FileRuntimeError> {
        let Some(ciphertext) = ciphertext.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        self.master_key
            .decrypt_with_context(
                ciphertext,
                CryptoContext::new("device")
                    .entity_id(device.id.clone())
                    .field(field),
            )
            .map(SecretString::new)
            .map(Some)
            .map_err(|error| FileRuntimeError::new(FileErrorCode::Unknown, error.to_string()))
    }
}

impl fmt::Debug for SystemFileRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemFileRuntime")
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl FileRuntime for SystemFileRuntime {
    async fn prepare_rsync(
        &self,
        device: &devices::Model,
    ) -> Result<PreparedRsyncDevice, FileRuntimeError> {
        if device.r#type == "local" {
            return Ok(PreparedRsyncDevice::local());
        }
        self.prepare_ssh(device)
    }

    async fn run_rsync(&self, request: RsyncRequest) -> Result<RsyncResult, FileRuntimeError> {
        run_rsync_process(request).await
    }
}

fn parse_auth_mode(device: &devices::Model) -> Result<SshAuthMode, FileRuntimeError> {
    match device.auth_mode.as_str() {
        "password" => Ok(SshAuthMode::Password),
        "key" => Ok(SshAuthMode::Key),
        "agent" => Ok(SshAuthMode::Agent),
        "configRef" => Ok(SshAuthMode::ConfigRef),
        "auto" => Ok(SshAuthMode::Auto),
        mode => Err(FileRuntimeError::new(
            FileErrorCode::AuthUnsupported,
            format!("不支持的 SSH 认证模式：{mode}"),
        )),
    }
}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

enum WaitOutcome {
    Exited(io::Result<ExitStatus>),
    Cancelled,
    TimedOut,
}

async fn run_rsync_process(request: RsyncRequest) -> Result<RsyncResult, FileRuntimeError> {
    let RsyncRequest {
        argv,
        env,
        timeout,
        cancellation,
        progress,
    } = request;
    let mut command = Command::new("rsync");
    command
        .args(argv)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(spawn_error)?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = terminate_and_wait(&mut child).await;
            return Err(runtime_error("rsync stdout pipe is unavailable"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = terminate_and_wait(&mut child).await;
            return Err(runtime_error("rsync stderr pipe is unavailable"));
        }
    };

    let (activity_tx, mut activity_rx) = watch::channel(Instant::now());
    let stdout_task = tokio::spawn(read_stdout(stdout, activity_tx, progress));
    let stderr_task = tokio::spawn(read_all(stderr));
    let outcome = {
        let wait = child.wait();
        tokio::pin!(wait);
        match timeout {
            RsyncTimeout::Fixed(duration) => {
                tokio::select! {
                    status = &mut wait => WaitOutcome::Exited(status),
                    _ = cancellation.cancelled() => WaitOutcome::Cancelled,
                    _ = time::sleep(duration) => WaitOutcome::TimedOut,
                }
            }
            RsyncTimeout::Idle(duration) => {
                let idle = time::sleep_until(Instant::now() + duration);
                tokio::pin!(idle);
                let mut activity_open = true;
                loop {
                    tokio::select! {
                        status = &mut wait => break WaitOutcome::Exited(status),
                        _ = cancellation.cancelled() => break WaitOutcome::Cancelled,
                        _ = &mut idle => break WaitOutcome::TimedOut,
                        activity = activity_rx.changed(), if activity_open => {
                            match activity {
                                Ok(()) => idle.as_mut().reset(*activity_rx.borrow() + duration),
                                Err(_) => activity_open = false,
                            }
                        }
                    }
                }
            }
        }
    };

    let timed_out = matches!(outcome, WaitOutcome::TimedOut);
    let status = match outcome {
        WaitOutcome::Exited(status) => status,
        WaitOutcome::Cancelled | WaitOutcome::TimedOut => terminate_and_wait(&mut child).await,
    };
    let stdout = join_reader(stdout_task, "stdout").await;
    let stderr = join_reader(stderr_task, "stderr").await;
    let status = status.map_err(|error| {
        FileRuntimeError::new(
            FileErrorCode::Unknown,
            format!("failed to wait for rsync: {error}"),
        )
    })?;
    let stdout = stdout?;
    let mut stderr = String::from_utf8_lossy(&stderr?).into_owned();
    if timed_out {
        stderr.push_str(RSYNC_TIMEOUT_MARKER);
    }
    Ok(RsyncResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr,
        exit_code: if timed_out {
            124
        } else {
            status.code().unwrap_or(-1)
        },
    })
}

async fn terminate_and_wait(child: &mut Child) -> io::Result<ExitStatus> {
    let kill_error = child.start_kill().err();
    match child.wait().await {
        Ok(status) => Ok(status),
        Err(wait_error) => Err(kill_error.unwrap_or(wait_error)),
    }
}

async fn read_stdout<R>(
    mut reader: R,
    activity: watch::Sender<Instant>,
    progress: Option<mpsc::Sender<RsyncProgress>>,
) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut pending_line = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        activity.send_replace(Instant::now());
        output.extend_from_slice(&chunk[..read]);
        for byte in &chunk[..read] {
            if matches!(byte, b'\r' | b'\n') {
                send_progress(&pending_line, progress.as_ref());
                pending_line.clear();
            } else {
                pending_line.push(*byte);
            }
        }
    }
    send_progress(&pending_line, progress.as_ref());
    Ok(output)
}

async fn read_all<R>(mut reader: R) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    reader.read_to_end(&mut output).await?;
    Ok(output)
}

fn send_progress(line: &[u8], progress: Option<&mpsc::Sender<RsyncProgress>>) {
    let Some(progress) = progress else {
        return;
    };
    if let Some(parsed) = parse_rsync_progress(&String::from_utf8_lossy(line)) {
        let _ = progress.try_send(parsed);
    }
}

async fn join_reader(
    task: JoinHandle<io::Result<Vec<u8>>>,
    stream: &'static str,
) -> Result<Vec<u8>, FileRuntimeError> {
    task.await
        .map_err(|error| {
            FileRuntimeError::new(
                FileErrorCode::Unknown,
                format!("rsync {stream} reader stopped unexpectedly: {error}"),
            )
        })?
        .map_err(|error| {
            FileRuntimeError::new(
                FileErrorCode::Unknown,
                format!("failed to read rsync {stream}: {error}"),
            )
        })
}

fn spawn_error(error: io::Error) -> FileRuntimeError {
    if error.kind() == io::ErrorKind::NotFound {
        FileRuntimeError::new(FileErrorCode::RsyncMissingLocal, error.to_string())
    } else {
        FileRuntimeError::new(
            FileErrorCode::Unknown,
            format!("failed to start rsync: {error}"),
        )
    }
}

fn runtime_error(message: impl Into<String>) -> FileRuntimeError {
    FileRuntimeError::new(FileErrorCode::Unknown, message)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Stdio as StdStdio;
    use std::time::Duration;

    use tempfile::TempDir;

    use crate::tmux::TMEX_SSH_ASKPASS_SECRET_FILE_ENV;

    use super::*;

    fn device(overrides: impl FnOnce(&mut devices::Model)) -> devices::Model {
        let mut device = devices::Model {
            id: "device-1".to_owned(),
            name: "Device".to_owned(),
            r#type: "ssh".to_owned(),
            host: Some("host.example".to_owned()),
            port: Some(22),
            username: Some("alice".to_owned()),
            ssh_config_ref: None,
            session: None,
            auth_mode: "auto".to_owned(),
            password_enc: None,
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: None,
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        overrides(&mut device);
        device
    }

    #[tokio::test]
    async fn config_ref_preserves_the_exact_trimmed_alias() {
        let runtime = SystemFileRuntime::new(MasterKey::development_default());
        let spec = runtime
            .prepare_rsync(&device(|device| {
                device.auth_mode = "configRef".to_owned();
                device.ssh_config_ref = Some("  jump-prod  ".to_owned());
            }))
            .await
            .unwrap();
        assert_eq!(spec.target_prefix, "jump-prod:");
        assert_eq!(
            spec.rsh.as_deref(),
            Some("ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes")
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn credential_lease_outlives_the_prepared_spec_without_exposing_secrets() {
        use std::os::unix::fs::PermissionsExt;

        let master_key = MasterKey::development_default();
        let private_key = "private-key-plaintext-marker";
        let passphrase = "passphrase-plaintext-marker";
        let spec = SystemFileRuntime::new(master_key.clone())
            .prepare_rsync(&device(|device| {
                device.auth_mode = "key".to_owned();
                device.private_key_enc = Some(master_key.encrypt(private_key).unwrap());
                device.private_key_passphrase_enc = Some(master_key.encrypt(passphrase).unwrap());
            }))
            .await
            .unwrap();
        let rsh = spec.rsh.as_deref().unwrap();
        let key_path = option_value(rsh, "-i").unwrap();
        let secret_path = PathBuf::from(&spec.env[TMEX_SSH_ASKPASS_SECRET_FILE_ENV]);
        let workspace = key_path.parent().unwrap().to_path_buf();
        assert_eq!(fs::read_to_string(&key_path).unwrap(), private_key);
        assert_eq!(fs::read_to_string(&secret_path).unwrap(), passphrase);
        assert_eq!(
            fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let debug = format!("{spec:?}");
        for secret in [private_key, passphrase] {
            assert!(!rsh.contains(secret));
            assert!(!debug.contains(secret));
            assert!(!spec.env.values().any(|value| value.contains(secret)));
        }
        drop(spec);
        assert!(!workspace.exists());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cancellation_and_timeout_kill_and_reap_rsync() {
        let fixture = fake_rsync();
        let runtime = SystemFileRuntime::new(MasterKey::development_default());

        let cancelled_pid = fixture.path().join("cancelled.pid");
        let cancellation = super::super::FileCancellation::new();
        let trigger = cancellation.clone();
        let pid_path = cancelled_pid.clone();
        let cancellation_task = tokio::spawn(async move {
            for _ in 0..100 {
                if pid_path.exists() {
                    trigger.cancel();
                    return;
                }
                time::sleep(Duration::from_millis(5)).await;
            }
            panic!("fake rsync did not start");
        });
        let cancelled = runtime
            .run_rsync(request(
                &fixture,
                &cancelled_pid,
                RsyncTimeout::Fixed(Duration::from_secs(5)),
                cancellation,
            ))
            .await
            .unwrap();
        cancellation_task.await.unwrap();
        assert_ne!(cancelled.exit_code, 0);
        assert_reaped(&cancelled_pid);

        let timed_out_pid = fixture.path().join("timed-out.pid");
        let timed_out = runtime
            .run_rsync(request(
                &fixture,
                &timed_out_pid,
                RsyncTimeout::Fixed(Duration::from_millis(40)),
                super::super::FileCancellation::new(),
            ))
            .await
            .unwrap();
        assert_eq!(timed_out.exit_code, 124);
        assert!(timed_out.stderr.ends_with(RSYNC_TIMEOUT_MARKER));
        assert_reaped(&timed_out_pid);
    }

    #[cfg(unix)]
    fn fake_rsync() -> TempDir {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("rsync");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nprintf 'started'\nprintf 'fixture stderr' >&2\nexec /bin/sleep 30\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    #[cfg(unix)]
    fn request(
        fixture: &TempDir,
        pid_path: &Path,
        timeout: RsyncTimeout,
        cancellation: super::super::FileCancellation,
    ) -> RsyncRequest {
        RsyncRequest {
            argv: vec![pid_path.to_string_lossy().into_owned()],
            env: BTreeMap::from([(
                "PATH".to_owned(),
                fixture.path().to_string_lossy().into_owned(),
            )]),
            timeout,
            cancellation,
            progress: None,
        }
    }

    #[cfg(unix)]
    fn assert_reaped(pid_path: &Path) {
        let pid = fs::read_to_string(pid_path).unwrap();
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(StdStdio::null())
            .stderr(StdStdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "process {pid} is still alive");
    }

    #[cfg(unix)]
    fn option_value(command: &str, option: &str) -> Option<PathBuf> {
        let mut tokens = command.split_whitespace();
        while let Some(token) = tokens.next() {
            if token == option {
                return tokens.next().map(PathBuf::from);
            }
        }
        None
    }
}
