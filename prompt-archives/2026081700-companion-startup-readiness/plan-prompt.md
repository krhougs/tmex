# Optional required local runtime at Gateway startup

Host embeddings can need the first local tmux runtime to be available before the Gateway reports ready. Standalone Gateway and later in-process restarts must keep the current best-effort behavior.

## Requirements

- Add an opt-in `GatewayRuntimeOptions.require_local_tmux_runtime` flag. `Default` is `false`.
- When enabled, acquire the first `type=local` device from `Repository::get_all_devices()` before `RuntimeServices::start()`, hold the lease until Push start completes, then release the temporary reference.
- Missing local device or acquire failure returns `GatewayRuntimeError` with stage `required-local-tmux`. Do not fall back to a remote device or succeed empty.
- Do not retry inside Gateway. The host decides whether to restart the process.
- Existing `GatewayRuntime::start()` and internal restarts stay best-effort.

Cross-repo host behavior is out of scope for this archive.
