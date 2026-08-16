# Plan 00: optional required local tmux runtime at startup

## Goal

Let a host opt into failing Gateway startup when the first local tmux runtime cannot be acquired. Default Gateway behavior stays best-effort.

## Changes

- `GatewayRuntimeOptions.require_local_tmux_runtime: bool`, default `false`.
- After `RuntimeServices::compose`, if the flag is on:
  1. Select the first `r#type == "local"` device in `get_all_devices()` order.
  2. `TmuxRuntimeRegistry::acquire` that device and hold a `RequiredLocalRuntimeLease`.
  3. Run the existing start sequence so Push reuses the live runtime.
  4. Release the temporary lease.
- No local device or acquire error: stage `required-local-tmux`, same fail/cleanup/ready-oneshot `Err` path as other startup errors.

## Tests

In `runtime::composition::tests`:

- default options do not require a local runtime
- required selection picks the first local device and skips ssh
- no local device is an explicit error
- acquire failure blocks readiness with stage `required-local-tmux`
- a successful lease is not shut down before explicit release

## Verify

```bash
cargo test -p tmex-gateway runtime::composition::tests --lib
cargo test -p tmex-gateway runtime::gateway::tests --lib
cargo check -p tmex-gateway
```
