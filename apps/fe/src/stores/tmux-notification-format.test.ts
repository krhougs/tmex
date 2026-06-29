import { describe, expect, mock, test } from 'bun:test';

mock.module('../i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) => {
    if (!params || Object.keys(params).length === 0) return key;
    const values = Object.values(params).join(', ');
    return `${key}[${values}]`;
  };
  return { default: { t } };
});

const { buildPaneLocationLabel, formatTerminalNotificationToast } = await import(
  './tmux-notification-format'
);

describe('buildPaneLocationLabel', () => {
  test('uses paneTitle when available', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 0,
      paneIndex: 1,
      paneTitle: 'build monitor',
      paneCurrentCommand: 'make',
    });
    expect(label).toContain('build monitor');
    expect(label).toContain('0');
  });

  test('uses paneCurrentCommand as fallback when paneTitle is absent', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 2,
      paneIndex: 0,
      paneCurrentCommand: 'vim',
    });
    expect(label).toContain('vim');
    expect(label).toContain('2');
  });

  test('falls back to pane index when no title or command', () => {
    const label = buildPaneLocationLabel({
      windowIndex: 1,
      paneIndex: 3,
    });
    expect(label).toContain('3');
    expect(label).toContain('1');
  });

  test('returns empty string when no data', () => {
    const label = buildPaneLocationLabel({});
    expect(label).toBe('');
  });
});

describe('formatTerminalNotificationToast', () => {
  test('includes window and pane info in notification description', () => {
    const result = formatTerminalNotificationToast({
      title: 'Build finished',
      body: 'All tests passed',
      source: 'osc777',
      windowIndex: 7,
      paneIndex: 3,
    });

    expect(result.title).toBe('Build finished');
    expect(result.description).toContain('7');
    expect(result.description).toContain('3');
    expect(result.description).toContain('All tests passed');
  });

  test('uses paneTitle when available in notification', () => {
    const result = formatTerminalNotificationToast({
      title: 'Build finished',
      body: 'OK',
      windowIndex: 0,
      paneTitle: 'build monitor',
    });

    expect(result.title).toBe('Build finished');
    expect(result.description).toContain('build monitor');
  });

  test('uses paneCurrentCommand as fallback in notification', () => {
    const result = formatTerminalNotificationToast({
      body: 'Done',
      windowIndex: 1,
      paneCurrentCommand: 'make',
    });

    expect(result.description).toContain('make');
    expect(result.description).toContain('Done');
  });

  test('falls back to pane index when no title or command', () => {
    const result = formatTerminalNotificationToast({
      body: 'Something happened',
      windowIndex: 0,
      paneIndex: 2,
    });

    expect(result.description).toContain('2');
    expect(result.description).toContain('Something happened');
  });

  test('uses fallback title when title is missing', () => {
    const result = formatTerminalNotificationToast({
      body: 'Alert',
    });

    expect(result.title).toBe('terminal.notificationFallbackTitle');
    expect(result.description).toBe('Alert');
  });

  test('uses source fallback when body is empty', () => {
    const result = formatTerminalNotificationToast({
      source: 'osc777',
    });

    expect(result.description).toContain('osc777');
  });

  test('uses fallback detail when both body and source are missing', () => {
    const result = formatTerminalNotificationToast({});

    expect(result.title).toBe('terminal.notificationFallbackTitle');
    expect(result.description).toBe('terminal.notificationFallbackDetail');
  });
});
