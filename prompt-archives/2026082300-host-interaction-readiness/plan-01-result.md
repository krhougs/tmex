# PaneSink attachment readiness result

- `PaneSinkRegistry` now exposes level-triggered attachment reads and change subscriptions.
- Sink replacement for the same pane does not emit a false detach/attach transition; unregister and reset do.
- `PaneSinkRouting` exposes the same surface for default and per-connection runtimes.
- `bun test packages/ws-client/src/pane-sink-registry.test.ts`: 10 passed.
- The stores standalone TypeScript check still stops at the existing unrelated `host-services.test.ts` mock typing error; the changed runtime surface is covered again by the parent workspace checks.
