import { describe, expect, test } from 'bun:test';

import { createRuntimeFsPaths, toSafePathSegment } from './fs-paths';

describe('fs paths', () => {
  test('encodes unsafe path characters into a single safe segment', () => {
    expect(toSafePathSegment('device 1/%1')).toBe('device_20_1_2f__25_1');
  });

  test('builds runtime paths with device id, gateway runtime id and gateway pid', () => {
    const paths = createRuntimeFsPaths({
      deviceId: 'device 1',
      sessionName: 'tmux main',
      gatewayPid: 4321,
      gatewayRuntimeId: 'gw/abc',
    } as any);

    expect(paths.rootDir).toBe('/tmp/tmex/device_20_1-gw_2f_abc-4321');
    expect(paths.panesDir).toBe('/tmp/tmex/device_20_1-gw_2f_abc-4321/panes');
    expect(paths.hooksDir).toBe('/tmp/tmex/device_20_1-gw_2f_abc-4321/hooks');
    expect(paths.hookFifoPath).toBe('/tmp/tmex/device_20_1-gw_2f_abc-4321/hooks/events.fifo');
  });

  test('builds pane fifo path from session and pane scope', () => {
    const paths = createRuntimeFsPaths({
      deviceId: 'device-a',
      sessionName: 'tmux work',
      gatewayPid: 99,
      gatewayRuntimeId: 'gw-1234',
      rootDir: '/var/tmp/tmex',
    } as any);

    expect(paths.paneFifoPath('%1')).toBe(
      '/var/tmp/tmex/device-a-gw-1234-99/panes/tmux_20_work-_25_1.fifo'
    );
  });
});
