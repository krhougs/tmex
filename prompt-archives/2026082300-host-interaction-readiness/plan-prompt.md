# Optional host interaction readiness for DeviceConsole

Date: 2026-08-23

Add an optional host interaction-readiness input to DeviceConsole, page actions, shortcuts, and terminal input/paste. When omitted, existing interact and in-terminal reconnect-indicator behavior stays unchanged. When the host reports not-ready, input, paste, shortcuts, and page actions all refuse together. Hosts may also hide the in-terminal reconnect overlay.
