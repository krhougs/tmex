import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { resolveBellContext } from './bell-context';

function createSnapshot(): StateSnapshotPayload {
  return {
    deviceId: 'device-1',
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'dev',
          index: 0,
          active: false,
          panes: [
            {
              id: '%11',
              windowId: '@1',
              index: 0,
              title: 'first',
              active: false,
              width: 80,
              height: 24,
            },
            {
              id: '%12',
              windowId: '@1',
              index: 1,
              title: 'second',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
        {
          id: '@2',
          name: 'ops',
          index: 1,
          active: true,
          panes: [
            {
              id: '%21',
              windowId: '@2',
              index: 0,
              title: 'ops-1',
              active: true,
              width: 120,
              height: 30,
            },
          ],
        },
      ],
    },
  };
}

describe('resolveBellContext', () => {
  test('resolves by paneId first and builds pane url', () => {
    const bell = resolveBellContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com/',
      snapshot: createSnapshot(),
      rawData: {
        paneId: '%12',
      },
    });

    expect(bell).toEqual({
      windowId: '@1',
      paneId: '%12',
      windowIndex: 0,
      paneIndex: 1,
      paneUrl: 'https://tmex.example.com/devices/device-1/windows/@1/panes/%2512',
    });
  });

  test('falls back to active window/pane when raw data is empty', () => {
    const bell = resolveBellContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: createSnapshot(),
      rawData: {},
    });

    expect(bell).toEqual({
      windowId: '@2',
      paneId: '%21',
      windowIndex: 1,
      paneIndex: 0,
      paneUrl: 'https://tmex.example.com/devices/device-1/windows/@2/panes/%2521',
    });
  });

  test('returns raw ids when snapshot is unavailable', () => {
    const bell = resolveBellContext({
      deviceId: 'device-1',
      siteUrl: 'https://tmex.example.com',
      snapshot: null,
      rawData: {
        windowId: '@1',
        paneId: '%12',
      },
    });

    expect(bell).toEqual({
      windowId: '@1',
      paneId: '%12',
    });
  });
});

