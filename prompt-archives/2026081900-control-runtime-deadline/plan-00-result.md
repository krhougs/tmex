# Control Runtime Subscription Deadline Result

Date: 2026-08-19

The control runtime now schedules the subscription's explicit deadline and calls `advance()` when it expires. This closes the cold-start gap where psmux emitted only initial structure notifications: the coalesced `StructureChanged` event is delivered without requiring a later output chunk, and the existing readiness gate completes before its attach timeout.

Validation:

- `cargo test -p tmex-gateway control_runtime`: 2 passed.
- `cargo test -p tmex-gateway tmux::`: 74 passed.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy -p tmex-gateway --lib --tests -- -D warnings`: passed.

No timeout, parser contract, transport protocol, or host-specific behavior was changed.

