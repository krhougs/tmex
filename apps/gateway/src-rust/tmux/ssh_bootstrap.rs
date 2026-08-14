pub const SSH_BOOTSTRAP_SCRIPT: &str = concat!(
    ". /etc/profile 2>/dev/null || true\n",
    "[ -f \"$HOME/.profile\" ] && . \"$HOME/.profile\" 2>/dev/null || true\n",
    "[ -f \"$HOME/.bash_profile\" ] && . \"$HOME/.bash_profile\" 2>/dev/null || true\n",
    "TMUX_BIN=\"$(command -v tmux 2>/dev/null || true)\"\n",
    "if [ -z \"$TMUX_BIN\" ]; then\n",
    "  for p in /usr/local/bin/tmux /opt/homebrew/bin/tmux /usr/bin/tmux /bin/tmux; do\n",
    "    [ -x \"$p\" ] && TMUX_BIN=\"$p\" && break\n",
    "  done\n",
    "fi\n",
    "HOME_DIR=\"${HOME:-$(pwd)}\"\n",
    "if [ -z \"$TMUX_BIN\" ]; then\n",
    "  printf 'TMEX_BOOT_FAIL\\ttmux_not_found\\n'\n",
    "else\n",
    "  printf 'TMEX_BOOT_OK\\t%s\\t%s\\t%s\\n' \"$TMUX_BIN\" \"$(\"$TMUX_BIN\" -V 2>/dev/null)\" \"$HOME_DIR\"\n",
    "fi",
);

pub fn build_ssh_bootstrap_script() -> &'static str {
    SSH_BOOTSTRAP_SCRIPT
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedSshBootstrap {
    Success {
        tmux_bin: String,
        tmux_version: String,
        home_dir: String,
    },
    Failure {
        reason: String,
    },
}

pub fn parse_ssh_bootstrap_output(output: &str) -> ParsedSshBootstrap {
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(payload) = line.strip_prefix("TMEX_BOOT_OK\t") {
            let mut fields = payload.split('\t');
            let tmux_bin = fields.next().unwrap_or_default();
            let tmux_version = fields.next().unwrap_or_default();
            let home_dir = fields.next().unwrap_or_default();
            if tmux_bin.is_empty() || home_dir.is_empty() {
                return ParsedSshBootstrap::Failure {
                    reason: "invalid_bootstrap_payload".to_owned(),
                };
            }
            return ParsedSshBootstrap::Success {
                tmux_bin: tmux_bin.to_owned(),
                tmux_version: tmux_version.to_owned(),
                home_dir: home_dir.to_owned(),
            };
        }
        if let Some(payload) = line.strip_prefix("TMEX_BOOT_FAIL\t") {
            return ParsedSshBootstrap::Failure {
                reason: payload
                    .split('\t')
                    .next()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("tmux_bootstrap_failed")
                    .to_owned(),
            };
        }
    }
    ParsedSshBootstrap::Failure {
        reason: "missing_bootstrap_marker".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_parser_ignores_login_noise_and_requires_complete_marker() {
        assert_eq!(
            parse_ssh_bootstrap_output(
                "motd\r\nTMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t/home/alice\r\n"
            ),
            ParsedSshBootstrap::Success {
                tmux_bin: "/usr/bin/tmux".to_owned(),
                tmux_version: "tmux 3.4".to_owned(),
                home_dir: "/home/alice".to_owned(),
            }
        );
        assert_eq!(
            parse_ssh_bootstrap_output("TMEX_BOOT_OK\t/usr/bin/tmux\ttmux 3.4\t\n"),
            ParsedSshBootstrap::Failure {
                reason: "invalid_bootstrap_payload".to_owned(),
            }
        );
    }
}
