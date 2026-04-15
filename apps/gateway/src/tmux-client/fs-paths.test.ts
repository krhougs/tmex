import { describe, expect, test } from 'bun:test';

import { createRuntimeFsPaths, toSafePathSegment } from './fs-paths';

describe('fs paths', () => {
  test('encodes unsafe path characters into a single safe segment', () => {
    expect(toSafePathSegment('device 1/%1')).toBe('device_20_1_2f__25_1');
  });

  test('builds runtime paths with device id and gateway pid', () => {
    const paths = createRuntimeFsPaths({
      deviceId: 'device 1',
      gatewayPid: 4321,
    });

    expect(paths.rootDir).toBe('/tmp/tmex/device_20_1-4321');
    expect(paths.panesDir).toBe('/tmp/tmex/device_20_1-4321/panes');
    expect(paths.hooksDir).toBe('/tmp/tmex/device_20_1-4321/hooks');
    expect(paths.hookFifoPath).toBe('/tmp/tmex/device_20_1-4321/hooks/events.fifo');
  });

  test('builds pane fifo path from a safe pane id segment', () => {
    const paths = createRuntimeFsPaths({
      deviceId: 'device-a',
      gatewayPid: 99,
      rootDir: '/var/tmp/tmex',
    });

    expect(paths.paneFifoPath('%1')).toBe('/var/tmp/tmex/device-a-99/panes/_25_1.fifo');
  });
});
