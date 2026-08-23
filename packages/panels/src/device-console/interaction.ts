export function resolveCanInteractWithPane(input: {
  deviceConnected: boolean;
  resolvedPaneId?: string | null;
  isSelectionInvalid?: boolean;
  hostInteractionReady?: boolean;
}): boolean {
  const hostReady = input.hostInteractionReady ?? true;
  return Boolean(
    hostReady && input.deviceConnected && input.resolvedPaneId && !input.isSelectionInvalid
  );
}

export function shouldShowTerminalReconnectOverlay(input: {
  isReconnecting: boolean;
  showReconnectOverlay?: boolean;
}): boolean {
  return input.isReconnecting && (input.showReconnectOverlay ?? true);
}
