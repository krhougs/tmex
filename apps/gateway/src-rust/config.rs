use std::collections::HashMap;

use thiserror::Error;

pub const GATEWAY_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const RUNTIME_RESTART_CLOSE_CODE: u16 = 1012;
pub const RUNTIME_RESTART_CLOSE_REASON: &str = "Gateway runtime restarting";
pub const EMBEDDED_DISABLED_NOTIFICATION_CHANNELS: &str = "webhook,telegram,weixin";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayEntryMode {
    Repository,
    NpmManaged,
    Embedded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayPlatform {
    Posix,
    Windows,
}

impl GatewayPlatform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayListener {
    Tcp { bind_host: String, port: u16 },
    InProcess,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SpaAssets {
    Bundled,
    Directory(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayFrontend {
    ApiOnly,
    Spa(SpaAssets),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayRestartPolicy {
    RecreateInProcess,
    ExitProcess {
        code: i32,
    },
    DelegateToHost {
        websocket_close_code: u16,
        websocket_close_reason: &'static str,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagementMode {
    None,
    App,
    CompanionCli,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateOwner {
    SelfManaged,
    App,
    Companion,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayProcessContext {
    pub ssh_auth_sock: Option<String>,
    pub user: Option<String>,
    pub logname: Option<String>,
    pub home: Option<String>,
    pub shell: Option<String>,
    pub display: String,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub locale: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GatewayConfig {
    pub entry_mode: GatewayEntryMode,
    pub listener: GatewayListener,
    pub frontend: GatewayFrontend,
    pub restart_policy: GatewayRestartPolicy,
    pub node_env: String,
    pub master_key: Option<String>,
    pub database_url: String,
    pub base_url: String,
    pub site_name_default: String,
    pub transfer_max_bytes: f64,
    pub bell_throttle_seconds_default: f64,
    pub notification_throttle_seconds_default: f64,
    pub disabled_notification_channels: String,
    pub theme_notify_2031_enabled: bool,
    pub tmux_allow_passthrough: bool,
    pub tmux_term_program: String,
    pub tmux_window_style: String,
    pub tmux_socket: String,
    pub tmux_bin: String,
    pub gateway_owner_token: Option<String>,
    pub ssh_reconnect_max_retries_default: f64,
    pub ssh_reconnect_delay_seconds_default: f64,
    pub language_default: String,
    pub agent_allow_private_fetch: bool,
    pub management_mode: ManagementMode,
    pub update_owner: UpdateOwner,
    pub process: GatewayProcessContext,
}

impl GatewayConfig {
    pub fn from_env(
        entry_mode: GatewayEntryMode,
        platform: GatewayPlatform,
        env: &HashMap<String, String>,
        tmux_namespace: Option<&str>,
    ) -> Result<Self, GatewayConfigError> {
        let (management_mode, update_owner) = if entry_mode == GatewayEntryMode::Embedded {
            (ManagementMode::CompanionCli, UpdateOwner::Companion)
        } else {
            (
                parse_management_mode(env.get("TMEX_MANAGEMENT_MODE").map(String::as_str)),
                parse_update_owner(env.get("TMEX_UPDATE_OWNER").map(String::as_str)),
            )
        };
        let allow_dynamic_port = management_mode == ManagementMode::CompanionCli
            && update_owner == UpdateOwner::Companion;

        let listener = match entry_mode {
            GatewayEntryMode::Repository => GatewayListener::Tcp {
                bind_host: get_env(env, "TMEX_BIND_HOST", "0.0.0.0"),
                port: resolve_gateway_port(env, 9663, allow_dynamic_port)?,
            },
            GatewayEntryMode::NpmManaged => GatewayListener::Tcp {
                bind_host: get_truthy_env(env, "TMEX_BIND_HOST", "127.0.0.1"),
                port: resolve_gateway_port(env, 9883, allow_dynamic_port)?,
            },
            GatewayEntryMode::Embedded => GatewayListener::InProcess,
        };

        let frontend = match entry_mode {
            GatewayEntryMode::NpmManaged => GatewayFrontend::Spa(
                env.get("TMEX_FE_DIST_DIR")
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .map(SpaAssets::Directory)
                    .unwrap_or(SpaAssets::Bundled),
            ),
            GatewayEntryMode::Repository | GatewayEntryMode::Embedded => GatewayFrontend::ApiOnly,
        };
        let restart_policy = match entry_mode {
            GatewayEntryMode::Repository => GatewayRestartPolicy::RecreateInProcess,
            GatewayEntryMode::NpmManaged => GatewayRestartPolicy::ExitProcess { code: 0 },
            GatewayEntryMode::Embedded => GatewayRestartPolicy::DelegateToHost {
                websocket_close_code: RUNTIME_RESTART_CLOSE_CODE,
                websocket_close_reason: RUNTIME_RESTART_CLOSE_REASON,
            },
        };

        let node_env = if entry_mode == GatewayEntryMode::Embedded {
            "production".to_owned()
        } else {
            get_env(env, "NODE_ENV", "development")
        };
        let master_key = env.get("TMEX_MASTER_KEY").cloned();
        if node_env == "production" && master_key.as_ref().is_none_or(String::is_empty) {
            return Err(GatewayConfigError::environment(
                "TMEX_MASTER_KEY is required in production mode",
            ));
        }

        let tmux_socket = match tmux_namespace {
            Some(namespace) => validate_tmux_namespace(namespace)?.to_owned(),
            None if entry_mode == GatewayEntryMode::Embedded => String::new(),
            None => get_env(env, "TMEX_TMUX_SOCKET", ""),
        };
        let disabled_notification_channels = if entry_mode == GatewayEntryMode::Embedded {
            EMBEDDED_DISABLED_NOTIFICATION_CHANNELS.to_owned()
        } else {
            get_env(env, "TMEX_DISABLED_NOTIFICATION_CHANNELS", "")
        };

        Ok(Self {
            entry_mode,
            listener,
            frontend,
            restart_policy,
            node_env,
            master_key,
            database_url: get_env(env, "DATABASE_URL", "./tmex.db"),
            base_url: get_env(env, "TMEX_BASE_URL", "http://127.0.0.1:8085"),
            site_name_default: get_env(env, "TMEX_SITE_NAME", "tmex"),
            transfer_max_bytes: parse_js_integer(&get_env(
                env,
                "TMEX_TRANSFER_MAX_BYTES",
                "2147483648",
            )),
            bell_throttle_seconds_default: parse_js_integer(&get_env(
                env,
                "TMEX_BELL_THROTTLE_SECONDS",
                "6",
            )),
            notification_throttle_seconds_default: parse_js_integer(&get_env(
                env,
                "TMEX_NOTIFICATION_THROTTLE_SECONDS",
                "3",
            )),
            disabled_notification_channels,
            theme_notify_2031_enabled: get_boolean_env(env, "TMEX_THEME_NOTIFY_2031", true),
            tmux_allow_passthrough: get_boolean_env(env, "TMEX_TMUX_ALLOW_PASSTHROUGH", false),
            tmux_term_program: get_env(env, "TMEX_TMUX_TERM_PROGRAM", "ghostty"),
            tmux_window_style: get_env(env, "TMEX_TMUX_WINDOW_STYLE", "fg=#d0d0d0,bg=#262626"),
            tmux_socket,
            tmux_bin: resolve_tmux_bin(env, platform, entry_mode == GatewayEntryMode::Embedded)?,
            gateway_owner_token: resolve_gateway_owner_token(env)?,
            ssh_reconnect_max_retries_default: parse_js_integer(&get_env(
                env,
                "TMEX_SSH_RECONNECT_MAX_RETRIES",
                "2",
            )),
            ssh_reconnect_delay_seconds_default: parse_js_integer(&get_env(
                env,
                "TMEX_SSH_RECONNECT_DELAY_SECONDS",
                "10",
            )),
            language_default: get_env(env, "TMEX_DEFAULT_LANGUAGE", "en_US"),
            agent_allow_private_fetch: env
                .get("TMEX_AGENT_ALLOW_PRIVATE_FETCH")
                .is_some_and(|value| value == "1"),
            management_mode,
            update_owner,
            process: resolve_process_context(env),
        })
    }

    pub fn is_dev(&self) -> bool {
        self.node_env == "development"
    }

    pub fn is_test(&self) -> bool {
        self.node_env == "test"
    }

    pub fn is_prod(&self) -> bool {
        self.node_env == "production"
    }

    pub fn is_api_only(&self) -> bool {
        self.frontend == GatewayFrontend::ApiOnly
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayCliIntent {
    Run { tmux_namespace: Option<String> },
    Version,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayProcessExit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GatewayStartup {
    Run(Box<GatewayConfig>),
    Exit(GatewayProcessExit),
}

pub fn parse_gateway_startup(
    entry_mode: GatewayEntryMode,
    platform: GatewayPlatform,
    argv: &[String],
    env: &HashMap<String, String>,
) -> Result<GatewayStartup, GatewayConfigError> {
    match parse_gateway_args(argv)? {
        GatewayCliIntent::Version => Ok(GatewayStartup::Exit(GatewayProcessExit {
            code: 0,
            stdout: format!("tmex-gateway {GATEWAY_VERSION}\n"),
            stderr: String::new(),
        })),
        GatewayCliIntent::Run { tmux_namespace } => Ok(GatewayStartup::Run(Box::new(
            GatewayConfig::from_env(entry_mode, platform, env, tmux_namespace.as_deref())?,
        ))),
    }
}

pub fn parse_gateway_args(argv: &[String]) -> Result<GatewayCliIntent, GatewayConfigError> {
    let mut version = false;
    let mut tmux_namespace = None;
    let mut index = 0;

    while index < argv.len() {
        let argument = &argv[index];
        if argument == "--version" {
            if version {
                return Err(GatewayConfigError::argument(
                    "--version may only be specified once",
                ));
            }
            version = true;
            index += 1;
            continue;
        }
        if argument == "--tmux-namespace" {
            if tmux_namespace.is_some() {
                return Err(GatewayConfigError::argument(
                    "--tmux-namespace may only be specified once",
                ));
            }
            let Some(value) = argv.get(index + 1) else {
                return Err(GatewayConfigError::argument(
                    "--tmux-namespace requires a value",
                ));
            };
            if value.starts_with("--") {
                return Err(GatewayConfigError::argument(
                    "--tmux-namespace requires a value",
                ));
            }
            tmux_namespace = Some(validate_tmux_namespace(value)?.to_owned());
            index += 2;
            continue;
        }
        return Err(GatewayConfigError::argument(format!(
            "unknown managed Gateway argument: {argument}"
        )));
    }

    if version && tmux_namespace.is_some() {
        return Err(GatewayConfigError::argument(
            "--version cannot be combined with --tmux-namespace",
        ));
    }
    if version {
        Ok(GatewayCliIntent::Version)
    } else {
        Ok(GatewayCliIntent::Run { tmux_namespace })
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum GatewayConfigError {
    #[error("{0}")]
    Argument(String),
    #[error("{0}")]
    Environment(String),
}

impl GatewayConfigError {
    pub const fn exit_code(&self) -> i32 {
        1
    }

    fn argument(message: impl Into<String>) -> Self {
        Self::Argument(message.into())
    }

    fn environment(message: impl Into<String>) -> Self {
        Self::Environment(message.into())
    }
}

fn get_env(env: &HashMap<String, String>, key: &str, default_value: &str) -> String {
    env.get(key)
        .cloned()
        .unwrap_or_else(|| default_value.to_owned())
}

fn get_truthy_env(env: &HashMap<String, String>, key: &str, default_value: &str) -> String {
    env.get(key)
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| default_value.to_owned())
}

fn get_boolean_env(env: &HashMap<String, String>, key: &str, default_value: bool) -> bool {
    let Some(value) = env.get(key) else {
        return default_value;
    };
    value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
}

fn resolve_gateway_port(
    env: &HashMap<String, String>,
    default_port: u16,
    allow_dynamic_port: bool,
) -> Result<u16, GatewayConfigError> {
    let default_port = default_port.to_string();
    let raw = env
        .get("GATEWAY_PORT")
        .map(String::as_str)
        .unwrap_or(&default_port)
        .trim();
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(GatewayConfigError::environment(
            "GATEWAY_PORT must be a decimal integer",
        ));
    }

    let minimum = u16::from(!allow_dynamic_port);
    let port = raw
        .parse::<u32>()
        .ok()
        .filter(|port| *port >= u32::from(minimum) && *port <= u32::from(u16::MAX));
    let Some(port) = port else {
        return Err(GatewayConfigError::environment(format!(
            "GATEWAY_PORT must be an integer in {minimum}..65535"
        )));
    };
    Ok(port as u16)
}

fn resolve_tmux_bin(
    env: &HashMap<String, String>,
    platform: GatewayPlatform,
    managed_build: bool,
) -> Result<String, GatewayConfigError> {
    let value = env.get("TMEX_TMUX_BIN").map(|value| value.trim());
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        if managed_build && platform == GatewayPlatform::Windows {
            return Err(GatewayConfigError::environment(
                "TMEX_TMUX_BIN must be set to an absolute path on managed Windows",
            ));
        }
        return Ok("tmux".to_owned());
    };

    let is_absolute = match platform {
        GatewayPlatform::Posix => value.starts_with('/'),
        GatewayPlatform::Windows => is_windows_absolute(value),
    };
    if !is_absolute {
        return Err(GatewayConfigError::environment(
            "TMEX_TMUX_BIN must be an absolute path",
        ));
    }
    Ok(value.to_owned())
}

fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with(['\\', '/'])
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

fn resolve_gateway_owner_token(
    env: &HashMap<String, String>,
) -> Result<Option<String>, GatewayConfigError> {
    let Some(value) = env
        .get("TMEX_GATEWAY_OWNER_TOKEN")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GatewayConfigError::environment(
            "TMEX_GATEWAY_OWNER_TOKEN must be exactly 32 bytes encoded as hex",
        ));
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn validate_tmux_namespace(value: &str) -> Result<&str, GatewayConfigError> {
    let bytes = value.as_bytes();
    let safe = (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !safe || value.eq_ignore_ascii_case("default") {
        return Err(GatewayConfigError::argument(
            "--tmux-namespace must be a safe, non-default name of at most 64 characters",
        ));
    }
    Ok(value)
}

fn parse_management_mode(raw: Option<&str>) -> ManagementMode {
    match raw {
        Some("app") => ManagementMode::App,
        Some("companion-cli") => ManagementMode::CompanionCli,
        _ => ManagementMode::None,
    }
}

fn parse_update_owner(raw: Option<&str>) -> UpdateOwner {
    match raw {
        Some("app") => UpdateOwner::App,
        Some("companion") => UpdateOwner::Companion,
        _ => UpdateOwner::SelfManaged,
    }
}

fn parse_js_integer(value: &str) -> f64 {
    let value = value.trim_start();
    let bytes = value.as_bytes();
    let (negative, start) = match bytes.first() {
        Some(b'-') => (true, 1),
        Some(b'+') => (false, 1),
        _ => (false, 0),
    };
    let mut end = start;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    if end == start {
        return f64::NAN;
    }

    let number = value[start..end].parse::<f64>().unwrap_or(f64::INFINITY);
    if negative {
        -number
    } else {
        number
    }
}

fn resolve_process_context(env: &HashMap<String, String>) -> GatewayProcessContext {
    GatewayProcessContext {
        ssh_auth_sock: env
            .get("SSH_AUTH_SOCK")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        user: env.get("USER").cloned(),
        logname: env.get("LOGNAME").cloned(),
        home: env.get("HOME").cloned(),
        shell: env.get("SHELL").cloned(),
        display: get_truthy_env(env, "DISPLAY", ":0"),
        term: env.get("TERM").cloned(),
        term_program: env.get("TERM_PROGRAM").cloned(),
        locale: env
            .get("LANG")
            .cloned()
            .or_else(|| env.get("LC_ALL").cloned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(values: &[(&str, &str)]) -> HashMap<String, String> {
        values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn version_is_an_immediate_successful_exit() {
        let env = environment(&[("NODE_ENV", "production"), ("GATEWAY_PORT", "invalid")]);
        let startup = parse_gateway_startup(
            GatewayEntryMode::Embedded,
            GatewayPlatform::Posix,
            &arguments(&["--version"]),
            &env,
        )
        .expect("version must not parse runtime environment");

        assert_eq!(
            startup,
            GatewayStartup::Exit(GatewayProcessExit {
                code: 0,
                stdout: format!("tmex-gateway {GATEWAY_VERSION}\n"),
                stderr: String::new(),
            })
        );
    }

    #[test]
    fn cli_preserves_managed_argument_validation_and_failure_exit_code() {
        assert_eq!(
            parse_gateway_args(&arguments(&["--tmux-namespace", "vibex-dev"]))
                .expect("safe namespace"),
            GatewayCliIntent::Run {
                tmux_namespace: Some("vibex-dev".to_owned())
            }
        );

        let cases = [
            (
                arguments(&["--tmux-namespace"]),
                "--tmux-namespace requires a value",
            ),
            (
                arguments(&["--tmux-namespace=bad"]),
                "unknown managed Gateway argument: --tmux-namespace=bad",
            ),
            (
                arguments(&["--tmux-namespace", "default"]),
                "--tmux-namespace must be a safe, non-default name of at most 64 characters",
            ),
            (
                arguments(&["--version", "--version"]),
                "--version may only be specified once",
            ),
            (
                arguments(&["--version", "--tmux-namespace", "vibex-dev"]),
                "--version cannot be combined with --tmux-namespace",
            ),
            (
                arguments(&["unexpected"]),
                "unknown managed Gateway argument: unexpected",
            ),
        ];
        for (argv, expected) in cases {
            let error = parse_gateway_args(&argv).expect_err("argument must be rejected");
            assert_eq!(error.to_string(), expected);
            assert_eq!(error.exit_code(), 1);
        }
    }

    #[test]
    fn entry_modes_keep_listener_frontend_and_restart_differences() {
        let repository = GatewayConfig::from_env(
            GatewayEntryMode::Repository,
            GatewayPlatform::Posix,
            &HashMap::new(),
            None,
        )
        .expect("repository defaults");
        assert_eq!(
            repository.listener,
            GatewayListener::Tcp {
                bind_host: "0.0.0.0".to_owned(),
                port: 9663
            }
        );
        assert_eq!(repository.frontend, GatewayFrontend::ApiOnly);
        assert_eq!(
            repository.restart_policy,
            GatewayRestartPolicy::RecreateInProcess
        );

        let npm = GatewayConfig::from_env(
            GatewayEntryMode::NpmManaged,
            GatewayPlatform::Posix,
            &HashMap::new(),
            None,
        )
        .expect("npm defaults");
        assert_eq!(
            npm.listener,
            GatewayListener::Tcp {
                bind_host: "127.0.0.1".to_owned(),
                port: 9883
            }
        );
        assert_eq!(npm.frontend, GatewayFrontend::Spa(SpaAssets::Bundled));
        assert_eq!(
            npm.restart_policy,
            GatewayRestartPolicy::ExitProcess { code: 0 }
        );

        let embedded = GatewayConfig::from_env(
            GatewayEntryMode::Embedded,
            GatewayPlatform::Posix,
            &environment(&[
                ("TMEX_MASTER_KEY", "key"),
                ("TMEX_FE_DIST_DIR", "/ignored"),
                ("TMEX_DISABLED_NOTIFICATION_CHANNELS", "caller-value"),
            ]),
            None,
        )
        .expect("embedded config");
        assert_eq!(embedded.listener, GatewayListener::InProcess);
        assert_eq!(embedded.frontend, GatewayFrontend::ApiOnly);
        assert_eq!(
            embedded.restart_policy,
            GatewayRestartPolicy::DelegateToHost {
                websocket_close_code: 1012,
                websocket_close_reason: "Gateway runtime restarting"
            }
        );
        assert!(embedded.is_prod());
        assert_eq!(embedded.management_mode, ManagementMode::CompanionCli);
        assert_eq!(embedded.update_owner, UpdateOwner::Companion);
        assert_eq!(
            embedded.disabled_notification_channels,
            "webhook,telegram,weixin"
        );
    }

    #[test]
    fn shared_environment_matches_gateway_defaults_and_parsing() {
        let env = environment(&[
            ("NODE_ENV", "test"),
            ("DATABASE_URL", ":memory:"),
            ("TMEX_BASE_URL", "http://localhost:4567"),
            ("TMEX_SITE_NAME", "example"),
            ("TMEX_TRANSFER_MAX_BYTES", " 4096bytes"),
            ("TMEX_BELL_THROTTLE_SECONDS", "8"),
            ("TMEX_NOTIFICATION_THROTTLE_SECONDS", "4"),
            ("TMEX_DISABLED_NOTIFICATION_CHANNELS", "webhook"),
            ("TMEX_THEME_NOTIFY_2031", "no"),
            ("TMEX_TMUX_ALLOW_PASSTHROUGH", "YES"),
            ("TMEX_TMUX_TERM_PROGRAM", "ghostty"),
            ("TMEX_TMUX_WINDOW_STYLE", "off"),
            ("TMEX_TMUX_SOCKET", "inherited"),
            ("TMEX_TMUX_BIN", "/opt/tmux"),
            ("TMEX_GATEWAY_OWNER_TOKEN", &"AB".repeat(32)),
            ("TMEX_SSH_RECONNECT_MAX_RETRIES", "5"),
            ("TMEX_SSH_RECONNECT_DELAY_SECONDS", "12"),
            ("TMEX_DEFAULT_LANGUAGE", "zh_CN"),
            ("TMEX_AGENT_ALLOW_PRIVATE_FETCH", "1"),
            ("SSH_AUTH_SOCK", " /tmp/agent.sock "),
            ("DISPLAY", ""),
            ("LANG", "zh_CN.UTF-8"),
        ]);
        let config = GatewayConfig::from_env(
            GatewayEntryMode::Repository,
            GatewayPlatform::Posix,
            &env,
            Some("explicit"),
        )
        .expect("configured repository");

        assert!(config.is_test());
        assert_eq!(config.database_url, ":memory:");
        assert_eq!(config.base_url, "http://localhost:4567");
        assert_eq!(config.site_name_default, "example");
        assert_eq!(config.transfer_max_bytes, 4096.0);
        assert_eq!(config.bell_throttle_seconds_default, 8.0);
        assert_eq!(config.notification_throttle_seconds_default, 4.0);
        assert_eq!(config.disabled_notification_channels, "webhook");
        assert!(!config.theme_notify_2031_enabled);
        assert!(config.tmux_allow_passthrough);
        assert_eq!(config.tmux_window_style, "off");
        assert_eq!(config.tmux_socket, "explicit");
        assert_eq!(config.tmux_bin, "/opt/tmux");
        assert_eq!(config.gateway_owner_token, Some("ab".repeat(32)));
        assert_eq!(config.ssh_reconnect_max_retries_default, 5.0);
        assert_eq!(config.ssh_reconnect_delay_seconds_default, 12.0);
        assert_eq!(config.language_default, "zh_CN");
        assert!(config.agent_allow_private_fetch);
        assert_eq!(
            config.process.ssh_auth_sock.as_deref(),
            Some("/tmp/agent.sock")
        );
        assert_eq!(config.process.display, ":0");
        assert_eq!(config.process.locale.as_deref(), Some("zh_CN.UTF-8"));
    }

    #[test]
    fn stable_environment_validation_matches_the_typescript_gateway() {
        let zero_port = environment(&[("GATEWAY_PORT", "0")]);
        assert_eq!(
            GatewayConfig::from_env(
                GatewayEntryMode::Repository,
                GatewayPlatform::Posix,
                &zero_port,
                None,
            )
            .expect_err("standalone zero port")
            .to_string(),
            "GATEWAY_PORT must be an integer in 1..65535"
        );

        let dynamic_port = environment(&[
            ("GATEWAY_PORT", "0"),
            ("TMEX_MANAGEMENT_MODE", "companion-cli"),
            ("TMEX_UPDATE_OWNER", "companion"),
        ]);
        assert_eq!(
            GatewayConfig::from_env(
                GatewayEntryMode::Repository,
                GatewayPlatform::Posix,
                &dynamic_port,
                None,
            )
            .expect("companion-managed dynamic port")
            .listener,
            GatewayListener::Tcp {
                bind_host: "0.0.0.0".to_owned(),
                port: 0
            }
        );

        let production = environment(&[("NODE_ENV", "production")]);
        assert_eq!(
            GatewayConfig::from_env(
                GatewayEntryMode::Repository,
                GatewayPlatform::Posix,
                &production,
                None,
            )
            .expect_err("production master key")
            .to_string(),
            "TMEX_MASTER_KEY is required in production mode"
        );

        let invalid_owner = environment(&[("TMEX_GATEWAY_OWNER_TOKEN", "not-a-token")]);
        assert_eq!(
            GatewayConfig::from_env(
                GatewayEntryMode::Repository,
                GatewayPlatform::Posix,
                &invalid_owner,
                None,
            )
            .expect_err("invalid owner token")
            .to_string(),
            "TMEX_GATEWAY_OWNER_TOKEN must be exactly 32 bytes encoded as hex"
        );

        let missing_windows_tmux = environment(&[("TMEX_MASTER_KEY", "key")]);
        assert_eq!(
            GatewayConfig::from_env(
                GatewayEntryMode::Embedded,
                GatewayPlatform::Windows,
                &missing_windows_tmux,
                None,
            )
            .expect_err("managed Windows tmux path")
            .to_string(),
            "TMEX_TMUX_BIN must be set to an absolute path on managed Windows"
        );
    }

    #[test]
    fn embedded_namespace_clears_inherited_state_unless_explicitly_set() {
        let env = environment(&[
            ("TMEX_MASTER_KEY", "key"),
            ("TMEX_TMUX_SOCKET", "inherited"),
        ]);
        let default = GatewayConfig::from_env(
            GatewayEntryMode::Embedded,
            GatewayPlatform::Posix,
            &env,
            None,
        )
        .expect("embedded default namespace");
        let explicit = GatewayConfig::from_env(
            GatewayEntryMode::Embedded,
            GatewayPlatform::Posix,
            &env,
            Some("vibex-dev"),
        )
        .expect("embedded explicit namespace");

        assert_eq!(default.tmux_socket, "");
        assert_eq!(explicit.tmux_socket, "vibex-dev");
    }
}
