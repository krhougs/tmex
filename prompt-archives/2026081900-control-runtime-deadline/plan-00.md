# Control Runtime Subscription Deadline Plan

## Goal

Drive `ControlModeSubscription` deadlines even when the control client emits no subsequent output, so coalesced structure notifications are delivered and a valid cold control attach becomes ready.

## Scope

- Add deadline scheduling to `apps/gateway/src-rust/tmux/control_runtime.rs`.
- Reuse `next_deadline_ms()` and `advance()`; do not change the parser contract or attach timeout.
- Add one regression test matching the observed psmux startup stream.
- Run focused `tmex-gateway` tests and formatting/clippy checks proportional to the change.

## Acceptance

1. `%window-add` followed by silence produces one `StructureChanged` after the existing 50ms debounce.
2. The projected event satisfies the existing control-runtime readiness gate before the three-second attach timeout.
3. Commands, process exit, stop, and later deadline rescheduling remain responsive.

