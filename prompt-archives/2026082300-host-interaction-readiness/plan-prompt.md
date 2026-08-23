# Optional host interaction readiness for DeviceConsole

Date: 2026-08-23

Add an optional host interaction-readiness input to DeviceConsole, page actions, shortcuts, and terminal input/paste. When omitted, existing interact and in-terminal reconnect-indicator behavior stays unchanged. When the host reports not-ready, input, paste, shortcuts, and page actions all refuse together. Hosts may also hide the in-terminal reconnect overlay.

## 2026-08-24 follow-up

Expose the existing per-runtime PaneSink attachment state as a level-triggered read/subscribe surface. The Vibe X host needs the actual Canvas terminal mount state for its connection-recovery readiness selector; device connection state is not an attachment signal. Keep the change inside PaneSinkRegistry and RuntimeCore without adding a new owner or terminal lifecycle.
