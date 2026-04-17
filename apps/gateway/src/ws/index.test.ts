import { beforeAll, describe, expect, test } from 'bun:test';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
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
    let acquireCalls = 0;

    const releaseRef: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      releaseRef.current = resolve;
    });

    server.deps.acquireRuntime = async () => {
      acquireCalls += 1;
      await gate;
      return {
        async connect() {},
        subscribe() {
          return () => {};
        },
        requestSnapshot() {},
        disconnect() {},
      };
    };

    const p1 = server.getOrCreateConnectionEntry('device-a', ws);
    const p2 = server.getOrCreateConnectionEntry('device-a', ws);
    const p3 = server.getOrCreateConnectionEntry('device-a', ws);

    if (releaseRef.current) {
      releaseRef.current();
    }
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(acquireCalls).toBe(1);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-a')).toBe(r1);
  });

  test('clears pending state on failure and allows retry', async () => {
    const server = new WebSocketServer() as any;
    const ws = createMockWs() as any;
    let acquireCalls = 0;

    const fakeEntry = {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };

    server.createDeviceConnectionEntry = async () => {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        return null;
      }
      return fakeEntry;
    };

    const first = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(first).toBeNull();
    expect(server.pendingConnectionEntries.size).toBe(0);

    const second = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(second).toBe(fakeEntry);
    expect(acquireCalls).toBe(2);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-b')).toBe(fakeEntry);
  });

  test('releases runtime when last websocket client disconnects from device', async () => {
    const released: string[] = [];
    const server = new WebSocketServer({
      deps: {
        acquireRuntime: async () =>
          ({
            async connect() {},
            subscribe() {
              return () => {};
            },
            requestSnapshot() {},
            disconnect() {},
          }) as any,
        releaseRuntime: async (deviceId) => {
          released.push(deviceId);
        },
      },
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      send() {},
    } as any;

    sessionStateStore.create(ws);

    const entry = await server.getOrCreateConnectionEntry('device-c', ws);
    entry.clients.add(ws);
    ws.data.borshState.selectedPanes['device-c'] = '%1';

    server.handleDeviceDisconnect(ws, 'device-c');

    expect(released).toEqual(['device-c']);
  });

  test('reuses the same runtime when a second websocket client connects to the same device', async () => {
    let acquireCalls = 0;
    let connectCalls = 0;
    const server = new WebSocketServer({
      deps: {
        acquireRuntime: async () => {
          acquireCalls += 1;
          return {
            async connect() {
              connectCalls += 1;
            },
            subscribe() {
              return () => {};
            },
            requestSnapshot() {},
            disconnect() {},
          } as any;
        },
      },
    }) as any;

    const ws1 = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
    const ws2 = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws1);
    sessionStateStore.create(ws2);

    await server.handleDeviceConnect(ws1, 'device-shared');
    await server.handleDeviceConnect(ws2, 'device-shared');

    expect(acquireCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(server.connections.get('device-shared')?.clients.size).toBe(2);
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
      runtime: {},
      detachRuntime: () => {},
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
    const baseUrl = getSiteSettings().siteUrl;

    expect(result).toEqual({
      type: 'bell',
      data: {
        windowId: '@1',
        paneId: '%1',
        windowIndex: 0,
        paneIndex: 0,
        paneUrl: `${baseUrl}/devices/device-a/windows/%401/panes/%251`,
      },
    });
  });

  test('throttles bell events per client', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};
    let shouldAllowCalls = 0;
    const originalShouldAllowBell = sessionStateStore.shouldAllowBell.bind(sessionStateStore);
    sessionStateStore.shouldAllowBell = (() => {
      shouldAllowCalls += 1;
      return shouldAllowCalls === 1;
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });
    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });

    expect(ws.sent).toHaveLength(1);

    sessionStateStore.shouldAllowBell = originalShouldAllowBell;
  });

  test('extends notification event with pane context from snapshot', async () => {
    const server = new WebSocketServer() as any;

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
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
      type: 'notification',
      data: {
        paneId: '%1',
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    });
    const baseUrl = getSiteSettings().siteUrl;

    expect(result).toEqual({
      type: 'notification',
      data: {
        windowId: '@1',
        paneId: '%1',
        windowIndex: 0,
        paneIndex: 0,
        paneUrl: `${baseUrl}/devices/device-a/windows/%401/panes/%251`,
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    });
  });

  test('drops empty notification events before broadcast', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { source: 'osc9', body: '' },
    });

    expect(ws.sent).toHaveLength(0);
  });

  test('throttles notification events per client and source', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};
    updateSiteSettings({ notificationThrottleSeconds: 3 });
    let shouldAllowCalls = 0;
    const originalShouldAllowNotification = sessionStateStore.shouldAllowNotification.bind(
      sessionStateStore
    );
    sessionStateStore.shouldAllowNotification = (() => {
      shouldAllowCalls += 1;
      return shouldAllowCalls === 1;
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { paneId: '%1', source: 'osc777', title: 'Build', body: 'OK' },
    });
    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { paneId: '%1', source: 'osc777', title: 'Build', body: 'OK' },
    });

    expect(ws.sent).toHaveLength(1);

    sessionStateStore.shouldAllowNotification = originalShouldAllowNotification;
    updateSiteSettings({ notificationThrottleSeconds: 3 });
  });
});
