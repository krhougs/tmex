export interface ParsedSshBootstrapSuccess {
  ok: true;
  tmuxBin: string;
  tmuxVersion: string;
  homeDir: string;
}

export interface ParsedSshBootstrapFailure {
  ok: false;
  reason: string;
}

export type ParsedSshBootstrap = ParsedSshBootstrapSuccess | ParsedSshBootstrapFailure;

export function buildSshBootstrapScript(): string {
  return [
    '. /etc/profile 2>/dev/null || true',
    '[ -f "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true',
    '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null || true',
    'TMUX_BIN="$(command -v tmux 2>/dev/null || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/local/bin/tmux /opt/homebrew/bin/tmux /usr/bin/tmux /bin/tmux; do',
    '    [ -x "$p" ] && TMUX_BIN="$p" && break',
    '  done',
    'fi',
    'HOME_DIR="${HOME:-$(pwd)}"',
    'if [ -z "$TMUX_BIN" ]; then',
    "  printf 'TMEX_BOOT_FAIL\\ttmux_not_found\\n'",
    'else',
    `  printf 'TMEX_BOOT_OK\\t%s\\t%s\\t%s\\n' "$TMUX_BIN" "$("$TMUX_BIN" -V 2>/dev/null)" "$HOME_DIR"`,
    'fi',
  ].join('\n');
}

export function parseSshBootstrapOutput(output: string): ParsedSshBootstrap {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('TMEX_BOOT_OK\t')) {
      const [, tmuxBin = '', tmuxVersion = '', homeDir = ''] = line.split('\t');
      if (!tmuxBin || !homeDir) {
        return { ok: false, reason: 'invalid_bootstrap_payload' };
      }
      return { ok: true, tmuxBin, tmuxVersion, homeDir };
    }

    if (line.startsWith('TMEX_BOOT_FAIL\t')) {
      const [, reason = 'tmux_bootstrap_failed'] = line.split('\t');
      return { ok: false, reason };
    }
  }

  return { ok: false, reason: 'missing_bootstrap_marker' };
}
