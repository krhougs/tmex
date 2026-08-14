#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TmuxVersion {
    pub major: u32,
    pub minor: u32,
}

pub const MIN_CONTROL_MODE_VERSION: TmuxVersion = TmuxVersion { major: 3, minor: 0 };

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TmuxVersionOutput {
    pub version_line: Option<String>,
    pub provenance: Option<String>,
}

pub fn normalize_tmux_version_output(output: &str) -> TmuxVersionOutput {
    let mut lines = output
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}').to_owned())
        .filter(|line| !line.is_empty());
    let version_line = lines.next();
    let provenance = {
        let rest = lines.collect::<Vec<_>>();
        (!rest.is_empty()).then(|| rest.join("\n"))
    };
    TmuxVersionOutput {
        version_line,
        provenance,
    }
}

pub fn parse_tmux_version(version_output: &str) -> Option<TmuxVersion> {
    let normalized = normalize_tmux_version_output(version_output);
    let bytes = normalized.version_line?.into_bytes();
    for dot in 1..bytes.len().saturating_sub(1) {
        if bytes[dot] != b'.'
            || !bytes[dot - 1].is_ascii_digit()
            || !bytes[dot + 1].is_ascii_digit()
        {
            continue;
        }
        let major_start = bytes[..dot]
            .iter()
            .rposition(|byte| !byte.is_ascii_digit())
            .map_or(0, |index| index + 1);
        let minor_end = bytes[dot + 1..]
            .iter()
            .position(|byte| !byte.is_ascii_digit())
            .map_or(bytes.len(), |index| dot + 1 + index);
        let major = std::str::from_utf8(&bytes[major_start..dot])
            .ok()?
            .parse()
            .ok()?;
        let minor = std::str::from_utf8(&bytes[dot + 1..minor_end])
            .ok()?
            .parse()
            .ok()?;
        return Some(TmuxVersion { major, minor });
    }
    None
}

pub fn is_control_mode_supported(version: Option<TmuxVersion>) -> bool {
    let Some(version) = version else {
        return true;
    };
    version.major >= MIN_CONTROL_MODE_VERSION.major
}

pub fn tmux_version_identity(output: &str) -> Option<String> {
    let line = normalize_tmux_version_output(output).version_line?;
    let without_prefix = line
        .get(..4)
        .filter(|prefix| prefix.eq_ignore_ascii_case("tmux"))
        .and_then(|_| line.get(4..))
        .filter(|suffix| suffix.chars().next().is_some_and(char::is_whitespace))
        .map_or(line.as_str(), str::trim_start);
    let identity = without_prefix.trim();
    (!identity.is_empty()).then(|| identity.to_owned())
}

pub fn tmux_client_matches_server(client_output: &str, server_output: &str) -> bool {
    matches!(
        (
            tmux_version_identity(client_output),
            tmux_version_identity(server_output)
        ),
        (Some(client), Some(server)) if client == server
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_dev_and_psmux_identity_without_provenance() {
        assert_eq!(
            parse_tmux_version("tmux 3.3a"),
            Some(TmuxVersion { major: 3, minor: 3 })
        );
        assert_eq!(
            parse_tmux_version("tmux next-3.6"),
            Some(TmuxVersion { major: 3, minor: 6 })
        );
        let psmux = "tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n";
        assert_eq!(tmux_version_identity(psmux).as_deref(), Some("3.3.7"));
        assert!(tmux_client_matches_server(psmux, "3.3.7\r\n"));
        assert!(!tmux_client_matches_server("tmux 3.5a", "3.7b"));
    }

    #[test]
    fn enforces_control_mode_floor_but_allows_unversioned_builds() {
        assert!(is_control_mode_supported(None));
        assert!(!is_control_mode_supported(Some(TmuxVersion {
            major: 2,
            minor: 9,
        })));
        assert!(is_control_mode_supported(Some(MIN_CONTROL_MODE_VERSION)));
    }
}
