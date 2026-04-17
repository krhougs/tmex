import { describe, expect, test } from 'bun:test';

import { formatTerminalNotificationToast } from './tmux-notification-format';

describe('formatTerminalNotificationToast', () => {
  test('includes window and pane in notification description', () => {
    const result = formatTerminalNotificationToast({
      title: 'Build finished',
      body: 'All tests passed',
      source: 'osc777',
      windowIndex: 7,
      paneIndex: 3,
    });

    expect(result.title).toBe('Build finished');
    expect(result.description).toContain('Window 7 · Pane 3');
    expect(result.description).toContain('All tests passed');
  });
});
