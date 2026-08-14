use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshAuthMode {
    Password,
    Key,
    Agent,
    ConfigRef,
    Auto,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

pub fn resolve_ssh_username(
    configured: Option<&str>,
    auth_mode: SshAuthMode,
    environment: &BTreeMap<String, String>,
) -> String {
    if let Some(username) = normalized(configured) {
        return username.to_owned();
    }
    if matches!(auth_mode, SshAuthMode::Agent | SshAuthMode::Auto) {
        if let Some(username) = environment
            .get("USER")
            .or_else(|| environment.get("LOGNAME"))
            .and_then(|value| normalized(Some(value)))
        {
            return username.to_owned();
        }
    }
    "root".to_owned()
}

pub fn resolve_ssh_agent_socket(
    auth_mode: SshAuthMode,
    environment: &BTreeMap<String, String>,
) -> Result<Option<String>, SshAuthError> {
    if !matches!(auth_mode, SshAuthMode::Agent | SshAuthMode::Auto) {
        return Ok(None);
    }
    let socket = environment
        .get("SSH_AUTH_SOCK")
        .and_then(|value| normalized(Some(value)))
        .map(str::to_owned);
    if auth_mode == SshAuthMode::Agent && socket.is_none() {
        return Err(SshAuthError::AgentSocketMissing);
    }
    Ok(socket)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SshAuthError {
    AgentSocketMissing,
}

impl fmt::Display for SshAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AgentSocketMissing => {
                formatter.write_str("SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证")
            }
        }
    }
}

impl std::error::Error for SshAuthError {}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_and_auto_use_process_identity_but_other_modes_fall_back_to_root() {
        let env = BTreeMap::from([
            ("USER".to_owned(), " alice ".to_owned()),
            ("SSH_AUTH_SOCK".to_owned(), "/tmp/agent".to_owned()),
        ]);
        assert_eq!(
            resolve_ssh_username(None, SshAuthMode::Agent, &env),
            "alice"
        );
        assert_eq!(resolve_ssh_username(None, SshAuthMode::Auto, &env), "alice");
        assert_eq!(
            resolve_ssh_username(None, SshAuthMode::Password, &env),
            "root"
        );
        assert_eq!(
            resolve_ssh_agent_socket(SshAuthMode::Agent, &env).unwrap(),
            Some("/tmp/agent".to_owned())
        );
    }
}
