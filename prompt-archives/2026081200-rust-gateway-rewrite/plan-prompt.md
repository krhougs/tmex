# Rust Gateway rewrite

## 2026-08-12 task

Replace the existing Bun/TypeScript Gateway with a Tokio-based Rust implementation while preserving the complete public behavior:

- Preserve CLI behavior, environment variables, HTTP routes, WebSocket wire protocols, terminal/tmux semantics, background services, database behavior, packaging, and frontend compatibility.
- Keep the npm CLI wrapper as the installation and command surface.
- Replace the Gateway-side Ghostty terminal parser with `alacritty_terminal` or `wezterm-term` based on repository evidence.
- Provide both standalone serving and an embeddable Rust crate API. The embedded API uses in-process channels and requires no TCP, UDS, or named pipe.
- Separate database preparation/migration from the Gateway runtime so an embedding host can own lifecycle ordering.
- Use Turso/libSQL or DuckDB through an ORM. Existing Drizzle migrations remain authoritative for upgrades and run before new Rust ORM migrations.
- Keep modules independently testable and keep the binary main limited to composition, lifecycle, and signal handling.
- Verify compatibility against the existing frontend and the current TypeScript implementation before removing the old runtime from production artifacts.

The implementation must follow `AGENTS.md`, must not access the installed production service or database, and must never interact with the default tmux socket or the session named `tmex`.

## 2026-08-12 additional requirement

The complete legacy Drizzle migration set and all new Rust ORM migrations must be compiled into the final Gateway binary. Database creation and upgrade must work from that single binary without reading a migration directory from the runtime filesystem. The embedding host must likewise be able to compile its complete migration set into its own binary.
