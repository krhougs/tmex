use std::fmt;
use std::future::Future;

use tmex_protocol::WireToken;

pub const TMEX_SERVER_EPOCH_OPTION: &str = "@tmex-server-epoch";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TmuxCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerEpochError {
    InvalidValue,
    Command(String),
    EstablishFailed(String),
}

impl fmt::Display for ServerEpochError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue => write!(formatter, "invalid {TMEX_SERVER_EPOCH_OPTION} value"),
            Self::Command(message) => formatter.write_str(message),
            Self::EstablishFailed(detail) => write!(
                formatter,
                "failed to establish {TMEX_SERVER_EPOCH_OPTION}: {detail}"
            ),
        }
    }
}

impl std::error::Error for ServerEpochError {}

pub fn new_server_epoch() -> WireToken {
    rand::random()
}

pub fn decode_server_epoch(value: &str) -> Result<WireToken, ServerEpochError> {
    let normalized = value.trim();
    if normalized.len() != 32
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ServerEpochError::InvalidValue);
    }
    let mut epoch = [0_u8; 16];
    for (index, slot) in epoch.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&normalized[index * 2..index * 2 + 2], 16)
            .map_err(|_| ServerEpochError::InvalidValue)?;
    }
    Ok(epoch)
}

pub fn encode_server_epoch(epoch: WireToken) -> String {
    epoch.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub async fn ensure_stable_server_epoch<Run, RunFuture>(
    run_tmux: Run,
) -> Result<WireToken, ServerEpochError>
where
    Run: FnMut(Vec<String>) -> RunFuture,
    RunFuture: Future<Output = Result<TmuxCommandResult, ServerEpochError>>,
{
    ensure_stable_server_epoch_with_candidate(run_tmux, new_server_epoch()).await
}

pub async fn ensure_stable_server_epoch_with_candidate<Run, RunFuture>(
    mut run_tmux: Run,
    candidate: WireToken,
) -> Result<WireToken, ServerEpochError>
where
    Run: FnMut(Vec<String>) -> RunFuture,
    RunFuture: Future<Output = Result<TmuxCommandResult, ServerEpochError>>,
{
    let candidate = encode_server_epoch(candidate);
    let existing = run_tmux(vec![
        "show-options".to_owned(),
        "-gqv".to_owned(),
        TMEX_SERVER_EPOCH_OPTION.to_owned(),
    ])
    .await?;
    if existing.exit_code == 0 && !existing.stdout.trim().is_empty() {
        return decode_server_epoch(&existing.stdout);
    }

    run_tmux(vec![
        "set-option".to_owned(),
        "-gq".to_owned(),
        "-o".to_owned(),
        TMEX_SERVER_EPOCH_OPTION.to_owned(),
        candidate,
    ])
    .await?;

    let resolved = run_tmux(vec![
        "show-options".to_owned(),
        "-gqv".to_owned(),
        TMEX_SERVER_EPOCH_OPTION.to_owned(),
    ])
    .await?;
    if resolved.exit_code != 0 || resolved.stdout.trim().is_empty() {
        let detail = if resolved.stderr.trim().is_empty() {
            "option remained unset"
        } else {
            resolved.stderr.trim()
        };
        return Err(ServerEpochError::EstablishFailed(detail.to_owned()));
    }
    decode_server_epoch(&resolved.stdout)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    const FIRST: WireToken = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ];
    const SECOND: WireToken = [
        0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        0x00,
    ];

    #[tokio::test]
    async fn create_once_rereads_the_atomic_winner() {
        let mut results = VecDeque::from([
            TmuxCommandResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            TmuxCommandResult {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            TmuxCommandResult {
                exit_code: 0,
                stdout: encode_server_epoch(SECOND),
                stderr: String::new(),
            },
        ]);
        let resolved = ensure_stable_server_epoch_with_candidate(
            |_| {
                let result = results.pop_front().unwrap();
                async move { Ok(result) }
            },
            FIRST,
        )
        .await
        .unwrap();
        assert_eq!(resolved, SECOND);
    }

    #[test]
    fn representation_is_lowercase_bytes16_only() {
        assert_eq!(decode_server_epoch(&encode_server_epoch(FIRST)), Ok(FIRST));
        assert_eq!(
            decode_server_epoch("00112233445566778899AABBCCDDEEFF"),
            Err(ServerEpochError::InvalidValue)
        );
    }
}
