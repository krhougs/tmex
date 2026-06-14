<div align="right">
  <a href="./README.zh-CN.md">简体中文</a>
</div>

<div align="center">
  <img src="apps/fe/public/logo.png" width="128" height="128" alt="tmex" />
</div>

<h1 align="center">tmex</h1>

<p align="center">
  A terminal workspace for tmux, rebuilt for the agent era.<br/>
  Run agents, watch panes, and manage remote machines from any device.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#install--upgrade">Install & Upgrade</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Quick Start

```bash
npx tmex-cli init
```

The installer generates keys, deploys runtime files, registers a user service (launchd on macOS, systemd on Linux), and starts tmex. Open the URL it prints, add your devices, and you are done.

## Highlights

| | | |
|---|---|---|
| **Open source, with history preserved** | **One-command install, self-updating** | **One sidebar for panes, agents, and files** |
| tmex is built in public with AI agents. Every design decision, iteration, and dead end is archived in `prompt-archives/` and `docs/`, so the engineering process is inspectable and reproducible. | `npx tmex-cli init` installs the service, generates keys, and starts serving. Upgrade in one click from the settings page, or run `npx tmex-cli upgrade`. Rollback is automatic if anything fails. | The left sidebar unites the device tree, AI Agent, and file manager. The Agent is tied to the active tmux pane: switch panes and the Agent context switches with you. |
| **Agent for coding and ops** | **Watch: a sentry for long jobs** | **Access your terminals from anywhere** |
| The server-side AI Agent reads the screen, runs commands, sends keystrokes to interactive programs, searches the web, and fetches pages. Use it for coding, log inspection, service restarts, network gear config, or any step-by-step maintenance task. | Watch monitors any pane on a schedule. Catch a download stuck at 73%, a build that errors out, or a log line that should not appear. Alerts go out through Telegram, webhook, or browser push. | tmex works on laptop, tablet, and phone. Install it as a standalone app and pick up where you left off. Mobile input is deliberately polished: the on-screen keyboard does not break your terminal layout, and editor mode lets you compose long commands comfortably. |
| **Ghostty WASM terminal** | **Local and SSH devices** | **Native tmux Control Mode** |
| The browser-side terminal uses Ghostty’s official VT kernel compiled to WebAssembly. You get native-grade terminal semantics without a hand-rolled ANSI parser. | Manage local machines and remote SSH hosts side by side. Authenticate with password, private key, SSH Agent, or SSH Config. Drag to reorder the device tree. | tmex is built on tmux Control Mode, so pane output, window lifecycle events, and bell notifications arrive in real time. Use the web UI alongside iTerm2 or any native tmux client. |

## Install & Upgrade

```bash
# Interactive install (recommended)
npx tmex-cli init

# Silent install for CI or automation
npx tmex-cli init --no-interactive \
  --install-dir ~/.local/share/tmex \
  --host 127.0.0.1 \
  --port 9883 \
  --db-path ~/.local/share/tmex/data/tmex.db \
  --autostart true

# Environment diagnosis
npx tmex-cli doctor

# Upgrade to the latest version
npx tmex-cli upgrade

# Uninstall
npx tmex-cli uninstall
```

Installation requires [Bun](https://bun.sh). The `doctor` command will check your environment and report any issues.

## Security

> **tmex does not include built-in authentication. Run it inside a trusted network only. Do not expose it directly to the public internet.**
>
> For remote access, protect it with a zero-trust layer such as [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) or Tailscale.

- Passwords and private keys are encrypted at rest with AES-256-GCM.
- Webhook notifications are signed with HMAC-SHA256.
- Agent terminal writes are bound to a single pane and require explicit approval by default.
- `fetch_url` denies loopback, link-local, and private addresses by default to prevent SSRF.

## FAQ

**Q: How do I make agents trigger notifications when they need input?**

Add an instruction to your `AGENTS.md` or system prompt telling the model to output `\a` (the BEL control character) whenever user interaction is needed. tmex captures bell events and routes them through your configured notification channels.

**Q: How do Telegram notifications work?**

Add one or more Telegram bots in Settings, then approve the chats that are allowed to receive alerts. tmex sends notifications for bell events, Agent confirmation requests, Watch triggers, and errors. Each bot can serve multiple chats, and you can revoke access at any time.

**Q: Why are some notifications missed when an SSH host has many panes?**

tmex opens one remote reader channel per pane. OpenSSH defaults `MaxSessions` to 10, which can be exhausted by a large pane count. Increase `MaxSessions` in the target host’s `sshd_config` to at least `pane count + 3`, then restart sshd.

**Q: Why is OSC passthrough disabled by default?**

Disabled passthrough prevents pane processes from forwarding private terminal control sequences to the host terminal, reducing the terminal-escape attack surface. If you need host terminals such as iTerm2 to receive OSC sequences, set `TMEX_TMUX_ALLOW_PASSTHROUGH=true`.

## License

MIT
