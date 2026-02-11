import { beforeAll, describe, expect, test } from 'bun:test';
import { ensureSiteSettingsInitialized } from '../db';
import { runMigrations } from '../db/migrate';
import { WebSocketServer } from './index';

function createMockWs() {
  return {
    data: { selectedPanes: {} as Record<string, string | null> },
    sent: [] as string[],
    send(message: string) {
      this.sent.push(message);
    },
  };
}

describe('WebSocketServer connection entry dedup', () => {
  test('deduplicates concurrent creation for same device', async () => {
    const server = new WebSocketServer() as any;
    const ws = createMockWs() as any;
    let createCalls = 0;

    let release: ((value: unknown) => void) | null = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const fakeEntry = {
      connection: {},
      clients: new Set(),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };

    server.createDeviceConnectionEntry = async () => {
      createCalls += 1;
      await gate;
      return fakeEntry;
    };

    const p1 = server.getOrCreateConnectionEntry('device-a', ws);
    const p2 = server.getOrCreateConnectionEntry('device-a', ws);
    const p3 = server.getOrCreateConnectionEntry('device-a', ws);

    release?.(null);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(createCalls).toBe(1);
    expect(r1).toBe(fakeEntry);
    expect(r2).toBe(fakeEntry);
    expect(r3).toBe(fakeEntry);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-a')).toBe(fakeEntry);
  });

  test('clears pending state on failure and allows retry', async () => {
    const server = new WebSocketServer() as any;
    const ws = createMockWs() as any;
    let createCalls = 0;

    const fakeEntry = {
      connection: {},
      clients: new Set(),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };

    server.createDeviceConnectionEntry = async () => {
      createCalls += 1;
      if (createCalls === 1) {
        return null;
      }
      return fakeEntry;
    };

    const first = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(first).toBeNull();
    expect(server.pendingConnectionEntries.size).toBe(0);

    const second = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(second).toBe(fakeEntry);
    expect(createCalls).toBe(2);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-b')).toBe(fakeEntry);
  });
});

describe('WebSocketServer bell extension', () => {
  beforeAll(() => {
    runMigrations();
    ensureSiteSettingsInitialized();
  });

  test('extends bell event with pane context from snapshot', async () => {
    const server = new WebSocketServer() as any;

    server.connections.set('device-a', {
      connection: {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'main',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    const result = await server.extendTmuxEvent('device-a', {
      type: 'bell',
      data: {
        paneId: '%1',
      },
    });

    expect(result).toEqual({
      type: 'bell',
      data: {
        windowId: '@1',
        paneId: '%1',
        windowIndex: 0,
        paneIndex: 0,
        paneUrl: 'http://127.0.0.1:8085/devices/device-a/windows/%401/panes/%251',
      },
    });
  });
});
