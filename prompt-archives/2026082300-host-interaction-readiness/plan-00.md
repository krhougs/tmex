# Host interaction readiness

Optional DeviceConsole props:

- `hostInteractionReady?: boolean` — default true
- `showReconnectOverlay?: boolean` — default true

`canInteractWithPane` and page-action interact gates honor the host flag. Tests cover omitted vs false.
