use std::collections::BTreeMap;
use std::env;
use std::path::Path;
use std::time::Duration;

use super::{CommandSpec, SpawnError, SpawnExecutor, SpawnPurpose};

pub const SHELL_ENV_BEGIN_MARKER: &str = "__TMEX_SHELL_ENV_BEGIN__";
pub const SHELL_ENV_END_MARKER: &str = "__TMEX_SHELL_ENV_END__";
pub const SHELL_ENV_PROBE_COMMAND: &str =
    "printf '__TMEX_SHELL_ENV_BEGIN__\\n'; /usr/bin/env; printf '__TMEX_SHELL_ENV_END__\\n'";

const ENV_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const ENV_PROBE_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostPlatform {
    Unix,
    Windows,
    MacOs,
}

impl HostPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Unix
        }
    }
}

pub fn get_local_parking_command(platform: HostPlatform) -> &'static str {
    if platform == HostPlatform::Windows {
        "ping.exe -n 31 127.0.0.1"
    } else {
        "sleep 30"
    }
}

pub fn inherited_environment() -> BTreeMap<String, String> {
    env::vars().collect()
}

pub fn build_local_tmux_env(
    resolved_path: Option<&str>,
    base_env: &BTreeMap<String, String>,
    platform: HostPlatform,
) -> BTreeMap<String, String> {
    let case_insensitive = platform == HostPlatform::Windows;
    let mut next = base_env
        .iter()
        .filter(|(key, _)| !is_tmex_injected_env_key(key, case_insensitive))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    if let Some(path) = resolved_path.filter(|path| !path.is_empty()) {
        set_env_value(&mut next, "PATH", path.to_owned(), case_insensitive);
    }

    let lc_all = get_env_value(&next, "LC_ALL", case_insensitive);
    let lc_ctype = get_env_value(&next, "LC_CTYPE", case_insensitive);
    let lang = get_env_value(&next, "LANG", case_insensitive);
    if !is_utf8_locale(lc_all)
        && (lc_all.is_some() || (!is_utf8_locale(lc_ctype) && !is_utf8_locale(lang)))
    {
        set_env_value(&mut next, "LC_ALL", "C.UTF-8".to_owned(), case_insensitive);
    }
    next
}

pub fn extract_path_from_shell_env(stdout: &str) -> Option<String> {
    let begin = stdout.rfind(SHELL_ENV_BEGIN_MARKER)?;
    let body_start = begin + SHELL_ENV_BEGIN_MARKER.len();
    let relative_end = stdout[body_start..].find(SHELL_ENV_END_MARKER)?;
    stdout[body_start..body_start + relative_end]
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("PATH="))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[derive(Clone)]
pub struct LocalShellPathResolver {
    executor: SpawnExecutor,
    platform: HostPlatform,
    environment: BTreeMap<String, String>,
}

impl LocalShellPathResolver {
    pub fn new(
        executor: SpawnExecutor,
        platform: HostPlatform,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            executor,
            platform,
            environment,
        }
    }

    pub async fn resolve(&self) -> Result<Option<String>, SpawnError> {
        if self.platform == HostPlatform::Windows {
            return Ok(get_env_value(&self.environment, "PATH", true)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned));
        }
        let Some(shell) = self.resolve_default_shell().await? else {
            return Ok(None);
        };
        let mut fallback = None;
        for args in [
            vec!["-l", "-c", SHELL_ENV_PROBE_COMMAND],
            vec!["-l", "-i", "-c", SHELL_ENV_PROBE_COMMAND],
            vec!["-c", SHELL_ENV_PROBE_COMMAND],
        ] {
            let output = self
                .executor
                .run_bounded(
                    CommandSpec::new(SpawnPurpose::LocalEnvironmentProbe, &shell)
                        .args(args)
                        .with_env(self.environment.clone(), true),
                    ENV_PROBE_TIMEOUT,
                    ENV_PROBE_OUTPUT_LIMIT,
                    ENV_PROBE_OUTPUT_LIMIT,
                )
                .await?;
            if output.exit_code != 0 {
                continue;
            }
            let Some(path) = extract_path_from_shell_env(&output.stdout_text()) else {
                continue;
            };
            fallback.get_or_insert_with(|| path.clone());
            if executable_in_path(&path, "tmux", self.platform) {
                return Ok(Some(path));
            }
        }
        Ok(fallback)
    }

    async fn resolve_default_shell(&self) -> Result<Option<String>, SpawnError> {
        if let Some(shell) = self
            .environment
            .get("SHELL")
            .map(String::as_str)
            .map(str::trim)
            .filter(|shell| Path::new(shell).exists())
        {
            return Ok(Some(shell.to_owned()));
        }
        if self.platform == HostPlatform::MacOs {
            let username = self
                .environment
                .get("USER")
                .or_else(|| self.environment.get("LOGNAME"))
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(username) = username {
                let output = self
                    .executor
                    .run_bounded(
                        CommandSpec::new(SpawnPurpose::LocalEnvironmentProbe, "/usr/bin/dscl")
                            .args([".", "-read", &format!("/Users/{username}"), "UserShell"])
                            .with_env(self.environment.clone(), true),
                        ENV_PROBE_TIMEOUT,
                        16 * 1024,
                        16 * 1024,
                    )
                    .await?;
                if output.exit_code == 0 {
                    if let Some(shell) = output
                        .stdout_text()
                        .split_once("UserShell:")
                        .map(|(_, value)| value.trim())
                        .filter(|value| Path::new(value).exists())
                    {
                        return Ok(Some(shell.to_owned()));
                    }
                }
            }
        }
        let fallback = if self.platform == HostPlatform::MacOs {
            "/bin/zsh"
        } else {
            "/bin/bash"
        };
        Ok(Path::new(fallback).exists().then(|| fallback.to_owned()))
    }
}

fn executable_in_path(path: &str, executable: &str, platform: HostPlatform) -> bool {
    let separator = if platform == HostPlatform::Windows {
        ';'
    } else {
        ':'
    };
    path.split(separator)
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .any(|part| Path::new(part).join(executable).exists())
}

fn is_tmex_injected_env_key(key: &str, case_insensitive: bool) -> bool {
    let normalized = if case_insensitive {
        key.to_ascii_uppercase()
    } else {
        key.to_owned()
    };
    normalized.starts_with("TMEX_")
        || matches!(
            normalized.as_str(),
            "NODE_ENV" | "DATABASE_URL" | "GATEWAY_PORT" | "FE_PORT"
        )
}

fn get_env_value<'a>(
    environment: &'a BTreeMap<String, String>,
    key: &str,
    case_insensitive: bool,
) -> Option<&'a str> {
    environment
        .iter()
        .find(|(candidate, _)| {
            if case_insensitive {
                candidate.eq_ignore_ascii_case(key)
            } else {
                candidate.as_str() == key
            }
        })
        .map(|(_, value)| value.as_str())
}

fn set_env_value(
    environment: &mut BTreeMap<String, String>,
    key: &str,
    value: String,
    case_insensitive: bool,
) {
    let existing = environment
        .keys()
        .find(|candidate| {
            case_insensitive && candidate.as_str().eq_ignore_ascii_case(key)
                || !case_insensitive && candidate.as_str() == key
        })
        .cloned();
    environment.insert(existing.unwrap_or_else(|| key.to_owned()), value);
}

fn is_utf8_locale(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.to_ascii_lowercase().replace('-', "").contains("utf8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_tmux_environment_does_not_leak_gateway_configuration() {
        let environment = BTreeMap::from([
            ("HOME".to_owned(), "/Users/alice".to_owned()),
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("SSH_AUTH_SOCK".to_owned(), "/tmp/agent".to_owned()),
            ("NODE_ENV".to_owned(), "production".to_owned()),
            ("DATABASE_URL".to_owned(), "secret.db".to_owned()),
            ("TMEX_MASTER_KEY".to_owned(), "secret".to_owned()),
        ]);
        assert_eq!(
            build_local_tmux_env(
                Some("/opt/homebrew/bin:/usr/bin:/bin"),
                &environment,
                HostPlatform::MacOs,
            ),
            BTreeMap::from([
                ("HOME".to_owned(), "/Users/alice".to_owned()),
                (
                    "PATH".to_owned(),
                    "/opt/homebrew/bin:/usr/bin:/bin".to_owned(),
                ),
                ("SSH_AUTH_SOCK".to_owned(), "/tmp/agent".to_owned()),
                ("LC_ALL".to_owned(), "C.UTF-8".to_owned()),
            ])
        );
    }

    #[test]
    fn shell_output_uses_the_last_complete_marked_environment() {
        assert_eq!(
            extract_path_from_shell_env(
                "PATH=/wrong\n__TMEX_SHELL_ENV_BEGIN__\nPATH=/first\n__TMEX_SHELL_ENV_END__\nnoise\n__TMEX_SHELL_ENV_BEGIN__\nPATH=/right\n__TMEX_SHELL_ENV_END__\n"
            ),
            Some("/right".to_owned())
        );
    }
}
