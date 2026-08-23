# PaneSink attachment readiness follow-up

1. Add `onPaneSinkChange` to `PaneSinkRegistry`, notifying only when a pane key changes between absent and present.
2. Expose `hasPaneSink` and `onPaneSinkChange` through `PaneSinkRouting` for default and per-connection runtimes.
3. Cover registration, replacement, unregister, and reset with the existing PaneSink registry tests.
4. Run the ws-client and stores package tests/type checks; keep the API optional only where compatibility with injected test runtimes requires it.
