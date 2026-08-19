# Prompt Archive

Date: 2026-08-19

Vibe X production on Windows reproducibly fails to start its companion after reboot. Read-only production evidence shows that psmux connects and authenticates successfully, then immediately emits `%window-add`, `%sessions-changed`, and `%session-changed`. Gateway nevertheless times out after three seconds because the subscription defers the structure event by 50ms and the control runtime never schedules `next_deadline_ms()`; `advance()` only runs when another chunk arrives.

Implement the runtime deadline path properly. Do not extend the attach timeout or treat arbitrary raw bytes as readiness. Preserve tmex's host-neutral/open-source behavior and add a focused regression test for the real silent-after-initial-notifications sequence.

