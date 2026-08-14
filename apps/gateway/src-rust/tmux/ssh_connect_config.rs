use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use super::{
    resolve_ssh_agent_socket, resolve_ssh_username, CommandSpec, SecretString, SpawnError,
    SpawnExecutor, SpawnPurpose, SshAuthError, SshAuthMode,
};

const SSH_CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_CONFIG_OUTPUT_LIMIT: usize = 1024 * 1024;

pub(crate) fn build_openssh_subprocess_environment(
    inherited: &BTreeMap<String, String>,
    overrides: BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = inherited
        .iter()
        .filter(|(key, _)| is_allowed_openssh_environment_key(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    environment.extend(overrides);
    environment
}

fn is_allowed_openssh_environment_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.starts_with("LC_")
        || matches!(
            key.as_str(),
            "PATH"
                | "HOME"
                | "USER"
                | "LOGNAME"
                | "SHELL"
                | "LANG"
                | "LANGUAGE"
                | "TERM"
                | "SSH_AUTH_SOCK"
                | "SYSTEMROOT"
                | "WINDIR"
                | "COMSPEC"
                | "PATHEXT"
                | "USERPROFILE"
                | "HOMEDRIVE"
                | "HOMEPATH"
        )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshDeviceConfig {
    pub device_id: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub config_ref: Option<String>,
    pub auth_mode: SshAuthMode,
    pub password: Option<SecretString>,
    pub private_key: Option<SecretString>,
    pub private_key_passphrase: Option<SecretString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolvedSshAuth {
    Password(SecretString),
    Key {
        private_key: SecretString,
        passphrase: Option<SecretString>,
    },
    Agent {
        socket: String,
        fallback_identity_files: Vec<PathBuf>,
    },
    Config {
        agent_socket: Option<String>,
        identity_file: Option<PathBuf>,
    },
    Auto {
        agent_socket: Option<String>,
        private_key: Option<SecretString>,
        password: Option<SecretString>,
        identity_file: Option<PathBuf>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub config_ref: Option<String>,
    pub auth: ResolvedSshAuth,
    pub subprocess_environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolvedSshConfigRef {
    pub host: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub identity_agent: Option<String>,
    pub identity_files: Vec<PathBuf>,
}

#[derive(Debug)]
pub enum SshConfigError {
    Spawn(SpawnError),
    Auth(SshAuthError),
    MissingHost,
    PasswordMissing,
    KeyMissing,
    ConfigRefMissing,
    ConfigRefResolve(String),
    ConfigRefInvalid,
    ConfigRefAuthMissing,
    AutoAuthMissing,
}

impl fmt::Display for SshConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => error.fmt(formatter),
            Self::Auth(error) => error.fmt(formatter),
            Self::MissingHost => formatter.write_str("SSH device missing host"),
            Self::PasswordMissing => formatter.write_str("auth_password_missing: 密码认证未提供密码"),
            Self::KeyMissing => formatter.write_str("auth_key_missing: 私钥认证未提供私钥"),
            Self::ConfigRefMissing => {
                formatter.write_str("ssh_config_ref_missing: SSH Config 引用不能为空")
            }
            Self::ConfigRefResolve(detail) => {
                write!(formatter, "ssh_config_ref_resolve_failed: {detail}")
            }
            Self::ConfigRefInvalid => {
                formatter.write_str("ssh_config_ref_invalid: SSH Config 引用未解析到 hostname")
            }
            Self::ConfigRefAuthMissing => formatter.write_str(
                "ssh_config_ref_auth_missing: SSH Config 引用未解析到可用认证方式（IdentityAgent / IdentityFile / SSH_AUTH_SOCK）",
            ),
            Self::AutoAuthMissing => formatter.write_str(
                "auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）",
            ),
        }
    }
}

impl std::error::Error for SshConfigError {}

impl From<SpawnError> for SshConfigError {
    fn from(value: SpawnError) -> Self {
        Self::Spawn(value)
    }
}

impl From<SshAuthError> for SshConfigError {
    fn from(value: SshAuthError) -> Self {
        Self::Auth(value)
    }
}

#[async_trait]
pub trait SshConfigLookup: Send + Sync {
    async fn lookup(&self, args: Vec<String>) -> Result<String, SshConfigError>;
}

#[derive(Clone)]
pub struct ProcessSshConfigLookup {
    executor: SpawnExecutor,
    environment: BTreeMap<String, String>,
}

impl ProcessSshConfigLookup {
    pub fn new(executor: SpawnExecutor, environment: BTreeMap<String, String>) -> Self {
        Self {
            executor,
            environment,
        }
    }
}

#[async_trait]
impl SshConfigLookup for ProcessSshConfigLookup {
    async fn lookup(&self, args: Vec<String>) -> Result<String, SshConfigError> {
        let output = self
            .executor
            .run_bounded(
                CommandSpec::new(SpawnPurpose::SshProbe, "ssh")
                    .args(args)
                    .with_env(
                        build_openssh_subprocess_environment(&self.environment, BTreeMap::new()),
                        true,
                    ),
                SSH_CONFIG_TIMEOUT,
                SSH_CONFIG_OUTPUT_LIMIT,
                SSH_CONFIG_OUTPUT_LIMIT,
            )
            .await?;
        if output.exit_code != 0 {
            let detail = output.stderr_text().trim().to_owned();
            return Err(SshConfigError::ConfigRefResolve(if detail.is_empty() {
                output.stdout_text().trim().to_owned()
            } else {
                detail
            }));
        }
        Ok(output.stdout_text())
    }
}

pub async fn resolve_ssh_connect_config(
    device: &SshDeviceConfig,
    environment: &BTreeMap<String, String>,
    lookup: Arc<dyn SshConfigLookup>,
) -> Result<SshConnectConfig, SshConfigError> {
    let config_ref = if device.auth_mode == SshAuthMode::ConfigRef {
        let reference = device
            .config_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(SshConfigError::ConfigRefMissing)?;
        let output = lookup
            .lookup(vec!["-G".to_owned(), reference.to_owned()])
            .await?;
        Some(parse_ssh_config_output(&output, environment)?)
    } else {
        None
    };
    let host = config_ref
        .as_ref()
        .map(|config| config.host.clone())
        .or_else(|| nonempty(device.host.as_deref()).map(str::to_owned))
        .ok_or(SshConfigError::MissingHost)?;
    let port = config_ref
        .as_ref()
        .and_then(|config| config.port)
        .or(device.port)
        .unwrap_or(22);
    let username = config_ref
        .as_ref()
        .and_then(|config| config.username.clone())
        .unwrap_or_else(|| {
            resolve_ssh_username(device.username.as_deref(), device.auth_mode, environment)
        });
    let config_agent = config_ref
        .as_ref()
        .and_then(|config| resolve_config_agent(config.identity_agent.as_deref(), environment));
    let env_agent = resolve_ssh_agent_socket(SshAuthMode::Auto, environment)?;
    let config_identity = config_ref.as_ref().and_then(|config| {
        config
            .identity_files
            .iter()
            .find(|path| path.exists())
            .cloned()
    });

    let auth = match device.auth_mode {
        SshAuthMode::Password => ResolvedSshAuth::Password(
            device
                .password
                .clone()
                .ok_or(SshConfigError::PasswordMissing)?,
        ),
        SshAuthMode::Key => ResolvedSshAuth::Key {
            private_key: device
                .private_key
                .clone()
                .ok_or(SshConfigError::KeyMissing)?,
            passphrase: device.private_key_passphrase.clone(),
        },
        SshAuthMode::Agent => {
            let socket = config_agent
                .or(resolve_ssh_agent_socket(SshAuthMode::Agent, environment)?)
                .ok_or(SshAuthError::AgentSocketMissing)?;
            let target = format!("{username}@{host}");
            let implicit = lookup
                .lookup(vec![
                    "-G".to_owned(),
                    "-p".to_owned(),
                    port.to_string(),
                    target,
                ])
                .await
                .ok()
                .and_then(|output| parse_ssh_config_output(&output, environment).ok())
                .map(|config| {
                    config
                        .identity_files
                        .into_iter()
                        .filter(|path| path.exists())
                        .collect()
                })
                .unwrap_or_default();
            ResolvedSshAuth::Agent {
                socket,
                fallback_identity_files: implicit,
            }
        }
        SshAuthMode::ConfigRef => {
            if config_agent.is_none() && env_agent.is_none() && config_identity.is_none() {
                return Err(SshConfigError::ConfigRefAuthMissing);
            }
            ResolvedSshAuth::Config {
                agent_socket: config_agent.or(env_agent),
                identity_file: config_identity,
            }
        }
        SshAuthMode::Auto => {
            if env_agent.is_none()
                && device.private_key.is_none()
                && device.password.is_none()
                && config_identity.is_none()
            {
                return Err(SshConfigError::AutoAuthMissing);
            }
            ResolvedSshAuth::Auto {
                agent_socket: env_agent,
                private_key: device.private_key.clone(),
                password: device.password.clone(),
                identity_file: config_identity,
            }
        }
    };
    Ok(SshConnectConfig {
        host,
        port,
        username,
        config_ref: device.config_ref.clone(),
        auth,
        subprocess_environment: build_openssh_subprocess_environment(environment, BTreeMap::new()),
    })
}

pub fn parse_ssh_config_output(
    output: &str,
    environment: &BTreeMap<String, String>,
) -> Result<ResolvedSshConfigRef, SshConfigError> {
    let mut resolved = ResolvedSshConfigRef::default();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "hostname" => resolved.host = value.to_owned(),
            "port" => resolved.port = value.parse().ok(),
            "user" => resolved.username = Some(value.to_owned()),
            "identityagent" => resolved.identity_agent = Some(value.to_owned()),
            "identityfile" => resolved
                .identity_files
                .push(expand_home(value, environment)),
            _ => {}
        }
    }
    if resolved.host.is_empty() {
        return Err(SshConfigError::ConfigRefInvalid);
    }
    Ok(resolved)
}

fn resolve_config_agent(
    value: Option<&str>,
    environment: &BTreeMap<String, String>,
) -> Option<String> {
    let value = nonempty(value)?;
    if value.eq_ignore_ascii_case("none") {
        return None;
    }
    if matches!(value, "SSH_AUTH_SOCK" | "$SSH_AUTH_SOCK") {
        return environment
            .get("SSH_AUTH_SOCK")
            .and_then(|value| nonempty(Some(value)))
            .map(str::to_owned);
    }
    let expanded = expand_home(value, environment);
    expanded
        .exists()
        .then(|| expanded.to_string_lossy().into_owned())
}

fn expand_home(value: &str, environment: &BTreeMap<String, String>) -> PathBuf {
    let value = value.trim();
    let home = environment.get("HOME").map(String::as_str).map(str::trim);
    if value == "~" {
        return home
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = home.filter(|value| !value.is_empty()) {
            return Path::new(home).join(rest);
        }
    }
    PathBuf::from(value)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh_environment_keeps_only_allowlisted_and_explicit_values() {
        let inherited = BTreeMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("HOME".to_owned(), "/Users/tester".to_owned()),
            ("LC_CTYPE".to_owned(), "en_US.UTF-8".to_owned()),
            ("TERM".to_owned(), "xterm-256color".to_owned()),
            ("SSH_AUTH_SOCK".to_owned(), "/tmp/inherited.sock".to_owned()),
            ("DATABASE_URL".to_owned(), "secret.db".to_owned()),
            ("TMEX_MASTER_KEY".to_owned(), "master-secret".to_owned()),
            ("TMEX_OTHER".to_owned(), "internal".to_owned()),
        ]);
        let filtered = build_openssh_subprocess_environment(
            &inherited,
            BTreeMap::from([
                ("SSH_AUTH_SOCK".to_owned(), "/tmp/selected.sock".to_owned()),
                ("SSH_ASKPASS".to_owned(), "/opt/tmex".to_owned()),
                ("TMEX_SSH_ASKPASS_MODE".to_owned(), "1".to_owned()),
            ]),
        );

        assert_eq!(filtered["PATH"], "/usr/bin:/bin");
        assert_eq!(filtered["HOME"], "/Users/tester");
        assert_eq!(filtered["LC_CTYPE"], "en_US.UTF-8");
        assert_eq!(filtered["TERM"], "xterm-256color");
        assert_eq!(filtered["SSH_AUTH_SOCK"], "/tmp/selected.sock");
        assert_eq!(filtered["SSH_ASKPASS"], "/opt/tmex");
        assert_eq!(filtered["TMEX_SSH_ASKPASS_MODE"], "1");
        assert!(!filtered.contains_key("DATABASE_URL"));
        assert!(!filtered.contains_key("TMEX_MASTER_KEY"));
        assert!(!filtered.contains_key("TMEX_OTHER"));
    }

    #[test]
    fn config_output_preserves_identity_order_and_expands_home() {
        let env = BTreeMap::from([("HOME".to_owned(), "/Users/tester".to_owned())]);
        let parsed = parse_ssh_config_output(
            "host prod\nuser alice\nhostname 10.0.0.5\nport 2200\nidentityfile ~/.ssh/id_rsa\nidentityfile /keys/id_ed25519\n",
            &env,
        )
        .unwrap();
        assert_eq!(parsed.host, "10.0.0.5");
        assert_eq!(parsed.port, Some(2200));
        assert_eq!(
            parsed.identity_files,
            vec![
                PathBuf::from("/Users/tester/.ssh/id_rsa"),
                PathBuf::from("/keys/id_ed25519"),
            ]
        );
    }
}
