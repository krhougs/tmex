#[cfg(unix)]
use std::path::Path;
#[cfg(any(unix, windows))]
use std::process::Command;

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};

use crate::entity::devices;

use super::{AgentEnvironment, AgentEnvironmentSource, AgentPortError};

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemAgentEnvironmentSource;

#[async_trait]
impl AgentEnvironmentSource for SystemAgentEnvironmentSource {
    async fn collect(
        &self,
        device: Option<&devices::Model>,
    ) -> Result<AgentEnvironment, AgentPortError> {
        let is_local = device.is_some_and(|device| device.r#type == "local");
        let facts = tokio::task::spawn_blocking(move || collect_system_facts(is_local))
            .await
            .map_err(|error| {
                AgentPortError::new(format!("failed to collect agent host environment: {error}"))
            })?;

        Ok(AgentEnvironment {
            device_name: device.map(|device| device.name.clone()),
            device_type: device.map(|device| device.r#type.clone()),
            host: device.and_then(|device| device.host.clone()),
            username: device.and_then(|device| device.username.clone()),
            port: device.and_then(|device| device.port),
            tmux_session: device.and_then(|device| device.session.clone()),
            timezone: facts.timezone,
            now_iso: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            gateway_os: facts.gateway_os,
            gateway_shell: is_local.then(|| nonempty_environment("SHELL")).flatten(),
            term: is_local.then(|| nonempty_environment("TERM")).flatten(),
            term_program: is_local
                .then(|| nonempty_environment("TERM_PROGRAM"))
                .flatten(),
            locale: is_local
                .then(|| nonempty_environment("LANG").or_else(|| nonempty_environment("LC_ALL")))
                .flatten(),
            encoding: is_local.then(|| "utf-8".to_owned()),
        })
    }
}

struct SystemFacts {
    timezone: String,
    gateway_os: Option<String>,
}

fn collect_system_facts(include_gateway_os: bool) -> SystemFacts {
    SystemFacts {
        timezone: system_timezone(),
        gateway_os: include_gateway_os.then(|| {
            format!(
                "{} {} ({})",
                node_platform(),
                operating_system_release(),
                node_architecture()
            )
        }),
    }
}

fn nonempty_environment(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        platform => platform,
    }
}

fn node_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        "powerpc64" => "ppc64",
        architecture => architecture,
    }
}

#[cfg(unix)]
fn operating_system_release() -> String {
    ["/usr/bin/uname", "/bin/uname"]
        .into_iter()
        .find_map(|program| command_stdout(program, &["-r"]))
        .unwrap_or_else(|| "unknown".to_owned())
}

#[cfg(windows)]
fn operating_system_release() -> String {
    command_stdout("cmd.exe", &["/D", "/C", "ver"])
        .and_then(|output| {
            let version = output.split("[Version ").nth(1)?.split(']').next()?;
            Some(version.split('.').take(3).collect::<Vec<_>>().join("."))
        })
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
}

#[cfg(not(any(unix, windows)))]
fn operating_system_release() -> String {
    "unknown".to_owned()
}

fn system_timezone() -> String {
    if let Some(timezone) = nonempty_environment("TZ").and_then(normalize_timezone) {
        return timezone;
    }

    #[cfg(unix)]
    {
        for path in ["/etc/localtime", "/var/db/timezone/localtime"] {
            if let Ok(target) = std::fs::read_link(path) {
                if let Some(timezone) = timezone_from_path(&target) {
                    return timezone;
                }
            }
        }
        if let Ok(timezone) = std::fs::read_to_string("/etc/timezone") {
            if let Some(timezone) = normalize_timezone(timezone) {
                return timezone;
            }
        }
    }

    #[cfg(windows)]
    if let Some(timezone) = command_stdout("tzutil.exe", &["/g"]).and_then(normalize_timezone) {
        return timezone;
    }

    "UTC".to_owned()
}

#[cfg(unix)]
fn timezone_from_path(path: &Path) -> Option<String> {
    let path = path.to_string_lossy();
    path.split("zoneinfo/").nth(1).and_then(normalize_timezone)
}

fn normalize_timezone(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim().trim_start_matches(':');
    if value.is_empty() {
        return None;
    }
    if let Some((_, timezone)) = value.split_once("zoneinfo/") {
        return normalize_timezone(timezone);
    }
    Some(value.to_owned())
}

#[cfg(any(unix, windows))]
fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let stdout = stdout.trim();
    (!stdout.is_empty()).then(|| stdout.to_owned())
}
