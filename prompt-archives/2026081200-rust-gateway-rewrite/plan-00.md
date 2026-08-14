# Tokio Gateway rewrite plan

## Goal

Replace the Bun/TypeScript Gateway with one Tokio/Rust implementation while preserving the existing `tmex-cli` package, both `tmex` and `tmex-cli` binaries, all HTTP and WebSocket protocols, tmux/SSH behavior, background services, standalone SPA hosting, and upgrade compatibility.

The Rust Gateway is both a standalone binary and an embeddable crate. The embedded API uses bounded in-process channels for streaming HTTP requests/responses and independent duplex WebSocket-frame sessions. The core crate never opens a listener; only the standalone adapter binds TCP.

All 18 legacy Drizzle migrations and every new Rust migration are compiled into the final Gateway binary. Runtime startup must create or upgrade a database without a migration directory.

## Decisions

- Terminal parser: pin `alacritty_terminal = 0.26.0`; preserve the existing tmux TERM/terminfo command contract while removing the Ghostty WASM parser asset.
- Database: stable Turso Rust engine with unrelated default features disabled.
- ORM: SeaORM entity/query APIs and SeaQuery schema builders for all Gateway repositories.
- Transactions: a `tmex-db` actor owns the Turso connection. A project transaction handle holds an exclusive gate and propagates BEGIN/COMMIT/ROLLBACK errors. SeaORM Proxy transaction callbacks are not used because they cannot propagate transaction errors safely.
- Migration tracking: retain `__drizzle_migrations` exactly for legacy history and use a separate `tmex_gateway_migrations` table for compiled Rust migrations.
- Package identity: retain the actual published package name `tmex-cli`; do not introduce a package rename while preserving the wrapper role.

## Crate layout

```text
Cargo.toml
crates/
  tmex-db/          Turso actor, SeaORM adapter, transaction and migration runner
  tmex-protocol/    Borsh and canonical wire types/codecs
  tmex-terminal/    control/OSC parsers and alacritty headless terminal
apps/gateway/
  Cargo.toml
  drizzle/          authoritative 0000..0017 legacy migrations
  src-rust/
    database/
    domain/
    http/
    ipc/
    services/
    tmux/
    ws/
    lib.rs
    main.rs
```

`apps/gateway` owns the legacy migration files so Cargo can compile them into the crate. A compile-time generator validates `_journal.json`, migration order and SQL hashes, then emits a static migration table. No generated path is opened at runtime.

## Phases

### 1. Contract baseline and workspace

- Add the Cargo workspace and pinned shared dependencies.
- Record the complete route/method matrix, environment variables, CLI behavior, Borsh kinds/errors and the three existing entry-mode differences.
- Generate stable JSON/Borsh fixtures from the TypeScript implementation while it is still available as the oracle.
- Add `fmt`, `clippy`, test and supported target checks. All tmux tests use an isolated socket and a session name other than `tmex`.

Acceptance: all public surfaces are represented in the compatibility manifest and the Rust workspace checks on the macOS/Linux/Windows target matrix.

### 2. Database, ORM and compiled migrations

- Implement the Turso actor, SeaORM statement/value/row adapter, explicit transaction gate, PRAGMAs and file permissions.
- Port Drizzle's journal `when`, SHA-256, statement-breakpoint, latest-created-at and single-transaction behavior exactly.
- Add compiled SeaQuery migrations, Gateway entities/repositories and the existing seed order.
- Port the existing AES-256-GCM `base64(iv || ciphertext || tag)` format without changing stored values.
- Protect the migration/transaction/security boundary with fresh and historical database fixtures, repeat-run, rollback/commit-error, foreign-key, AUTOINCREMENT, last-id and value round-trip tests.

Acceptance: empty and 0007/0011/0015/0017-era databases upgrade to the same schema/data/journal as the TypeScript runtime, and the binary succeeds outside the repository with no migration resources.

### 3. Terminal and tmux/SSH state machines

- Port control-mode parsing, octal unescape, command blocks, OSC/DCS/CSI side-channel parsing, epochs, retention, history cursors and metadata projection.
- Replace only the Ghostty headless emulator with the alacritty adapter, matching viewport text, alternate screen, bounded scrollback and OSC 133 taps.
- Port local and SSH connection actors, version/provenance checks, parking window, server epoch, snapshots, exact-byte input, resize/layout/split/move/break and reconnect behavior.

Acceptance: existing byte corpora and snapshot/history fixtures match; real tmux integration passes on an isolated socket.

### 4. WebSocket core and embedded IPC

- Implement every legacy Borsh envelope/kind/error, HELLO/PING/PONG/CHUNK, select barrier, history, subscriptions, output/backpressure and Agent/Watch/Theme/Settings/Notify events.
- Implement canonical-state-v1 byte-canonical validation, epochs/sequences/gaps, Begin/Chunk/Commit, retention and cursor history.
- Keep the session core transport-neutral. Add the standalone Axum upgrade adapter and the bounded in-process request/session channel adapter.

Acceptance: JavaScript/Rust golden bytes are identical, the unchanged browser legacy transport and host canonical transport both pass, and embedded tests bind no listener.

### 5. HTTP and complete service port

Port in dependency order:

1. devices, tree, settings, theme, terminal shortcuts, capabilities, health and system;
2. file roots/path safety/list/content/raw, strict 8 MiB uploads, NDJSON transfers and GC;
3. webhook, Telegram and Weixin configuration/authorization/long-poll channels;
4. OpenAI Chat/Responses providers, streaming, model refresh and secret redaction;
5. Agent sessions/messages/tools/queue/confirmations/recovery;
6. Watch scheduling/evaluation/sample ring/automatic disable;
7. push supervisor, device acquisition/retry and notification throttling.

Preserve method-mismatch 404s, HTTP-200 connection failures, Files error envelopes/statuses, managed-system 403s, manifest HEAD, health owner proof, webhook HMAC headers and current startup/shutdown ordering.

Acceptance: the full method/status/body/header matrix matches the TypeScript oracle and all background services retain behavior without a browser connection.

### 6. Standalone binary and npm wrapper

- Compose configuration, database bootstrap, runtime, Axum listener and SPA service in the binary entry point; keep business logic out of `main`.
- Preserve `--version`, `--tmux-namespace`, all current environment variables and the distinct restart semantics of repository standalone, npm service and embedded modes.
- Keep `tmex-cli`, both command bins, init/doctor/upgrade/uninstall, install metadata, app.env, services and the hidden upgrade handoff.
- Package signed target binaries in the existing npm package and copy only the matching artifact into the installation. Service scripts execute the Rust binary.
- Remove the production TypeScript Gateway, Ghostty WASM, runtime migration directory/materialization and Bun Gateway build. Keep SPA assets and required terminfo.

Acceptance: upgrade from an existing npm installation succeeds with rollback behavior intact, the unchanged frontend works, and a copied Rust binary can create/upgrade its database without repository files.

### 7. Final removal and compatibility audit

- Run the complete unchanged-frontend REST/legacy-WS/canonical-WS suite, historical DB upgrades, standalone/embedded lifecycle tests and supported platform builds.
- Audit for no production TypeScript Gateway entry, `TMEX_MIGRATIONS_DIR`, migration materialization, Ghostty WASM or Rust-to-JavaScript fallback.
- Remove temporary spikes and generated evidence that is not a stable protocol, migration, security or regression test.

## Final acceptance

- Existing CLI/package/install/update behavior remains compatible.
- Every HTTP route, both WebSocket protocols, tmux/SSH/terminal behavior, background service and outbound webhook contract is implemented in Rust.
- The standalone binary embeds the complete legacy and Rust Gateway migration chain and runs without a migration directory.
- The crate exposes listener-free, bounded in-process HTTP streaming, duplex frame sessions, lifecycle watch, shutdown and join APIs.
- No production JavaScript Gateway or fallback path remains.
