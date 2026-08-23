import { describe, expect, test } from 'bun:test';
import {
  resolveCanInteractWithPane,
  shouldShowTerminalReconnectOverlay,
} from './interaction';

describe('host interaction readiness', () => {
  test('omitting the host flag keeps existing interact and overlay defaults', () => {
    expect(
      resolveCanInteractWithPane({
        deviceConnected: true,
        resolvedPaneId: 'pane-1',
      })
    ).toBe(true);
    expect(
      shouldShowTerminalReconnectOverlay({
        isReconnecting: true,
      })
    ).toBe(true);
  });

  test('host not-ready disables interact together and can hide the overlay', () => {
    expect(
      resolveCanInteractWithPane({
        deviceConnected: true,
        resolvedPaneId: 'pane-1',
        hostInteractionReady: false,
      })
    ).toBe(false);
    expect(
      shouldShowTerminalReconnectOverlay({
        isReconnecting: true,
        showReconnectOverlay: false,
      })
    ).toBe(false);
  });
});
