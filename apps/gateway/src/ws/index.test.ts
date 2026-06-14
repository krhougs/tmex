import { beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { WebSocketServer } from './index';

// 快照下发路径会同步读 device_tree_order 表，确保所有用例前已建表
beforeAll(() => {
  runMigrations();
});

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

describe('WebSocketServer tmux select guards', () => {
  function makeSnapshot(): StateSnapshotPayload {
    return {
      deviceId: 'device-a',
      session: {
        id: '$1',
        name: 'tmex',
        windows: [
          {
            id: '@1',
            name: 'one',
            index: 0,
            active: true,
            panes: [
              {
                id: '%1',
                windowId: '@1',
                index: 0,
                title: 'one-pane',
                active: true,
                width: 80,
                height: 24,
              },
            ],
          },
          {
            id: '@2',
            name: 'two',
            index: 1,
            active: false,
            panes: [
              {
                id: '%2',
                windowId: '@2',
                index: 0,
                title: 'two-pane',
                active: true,
                width: 80,
                height: 24,
              },
            ],
          },
        ],
      },
    };
  }

  function createBorshWs() {
    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
    sessionStateStore.create(ws);
    return ws;
  }

  function createRuntimeRecorder() {
    const recorder = {
      requestSnapshotCalls: 0,
      selectWindowCalls: [] as string[],
      selectPaneCalls: [] as Array<{ windowId: string; paneId: string; size?: { cols: number; rows: number } }>,
      runtime: {
        requestSnapshot() {
          recorder.requestSnapshotCalls += 1;
        },
        selectWindow(windowId: string) {
          recorder.selectWindowCalls.push(windowId);
        },
        selectPane(windowId: string, paneId: string) {
          recorder.selectPaneCalls.push({ windowId, paneId });
        },
        selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number) {
          recorder.selectPaneCalls.push({ windowId, paneId, size: { cols, rows } });
        },
      },
    };
    return recorder;
  }

  function setupEntry(
    server: any,
    ws: any,
    runtime: ReturnType<typeof createRuntimeRecorder>['runtime'],
    snapshot: StateSnapshotPayload | null = makeSnapshot()
  ) {
    const entry = {
      runtime,
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: snapshot,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    server.connections.set('device-a', entry);
    return entry;
  }

  function clearPolling(entry: { snapshotPollTimer: ReturnType<typeof setInterval> | null }) {
    if (entry.snapshotPollTimer) {
      clearInterval(entry.snapshotPollTimer);
      entry.snapshotPollTimer = null;
    }
  }

  test('rejects invalid select-window ids before calling runtime', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@0_0_bash_1');

    expect(recorder.selectWindowCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
  });

  test('rejects select-window ids missing from current snapshot', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@99');

    expect(recorder.selectWindowCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
  });

  test('allows select-window ids present in current snapshot', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@1');

    expect(recorder.selectWindowCalls).toEqual(['@1']);
    expect(recorder.requestSnapshotCalls).toBe(0);
  });

  test('rejects invalid pane selects without mutating selected panes', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    ws.data.borshState.selectedPanes['device-a'] = '%1';
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1_bad',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: null,
      rows: null,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
    expect(ws.data.borshState.selectedPanes['device-a']).toBe('%1');
    expect(ws.sent).toHaveLength(0);
  });

  test('rejects pane ids that are not inside the requested window', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%2',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: null,
      rows: null,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
    expect(ws.data.borshState.selectedPanes['device-a']).toBeUndefined();
    expect(ws.sent).toHaveLength(0);
  });

  test('allows pane selects that exist in the requested window', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: 100,
      rows: 30,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([
      { windowId: '@1', paneId: '%1', size: { cols: 100, rows: 30 } },
    ]);
    expect(recorder.requestSnapshotCalls).toBe(0);
    expect(ws.data.borshState.selectedPanes['device-a']).toBe('%1');
    expect(ws.sent).toHaveLength(1);
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

describe('WebSocketServer window custom names', () => {
  function makeSnapshot(windowIds: string[]): StateSnapshotPayload {
    return {
      deviceId: 'device-a',
      session: {
        id: '$1',
        name: 'tmex',
        windows: windowIds.map((id, index) => ({
          id,
          name: `win-${index}`,
          index,
          active: index === 0,
          panes: [
            {
              id: `%${index}`,
              windowId: id,
              index: 0,
              title: `title-${index}`,
              active: true,
              width: 80,
              height: 24,
            },
          ],
        })),
      },
    };
  }

  function createBorshWs() {
    return {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
  }

  function decodeLastSnapshot(ws: any): StateSnapshotPayload {
    const envelope = wsBorsh.decodeEnvelope(ws.sent[ws.sent.length - 1]);
    expect(envelope.kind).toBe(wsBorsh.KIND_STATE_SNAPSHOT);
    return wsBorsh.decodeStateSnapshot(envelope.payload);
  }

  function setupEntry(server: any, snapshot: StateSnapshotPayload | null, ws: any) {
    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: snapshot,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
  }

  test('rename stores overlay and rebroadcasts snapshot with customName', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1', '@2']), ws);

    server.handleRenameWindow('device-a', '@1', '  My Window  ');

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('My Window');
    expect(snapshot.session?.windows[1].customName).toBeUndefined();
    // lastSnapshot 保持原始数据，不被 overlay 污染
    expect(server.connections.get('device-a').lastSnapshot.session.windows[0].customName)
      .toBeUndefined();
  });

  test('empty name clears the overlay', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.handleRenameWindow('device-a', '@1', 'Custom');
    server.handleRenameWindow('device-a', '@1', '   ');

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBeUndefined();
    expect(server.windowCustomNames.get('device-a')?.has('@1')).toBe(false);
  });

  test('overlay name is truncated to 64 characters', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.handleRenameWindow('device-a', '@1', 'x'.repeat(100));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('x'.repeat(64));
  });

  test('stale window entries are pruned when snapshot no longer contains them', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1', '@2']), ws);

    server.handleRenameWindow('device-a', '@1', 'Keep');
    server.handleRenameWindow('device-a', '@2', 'Gone');

    server.broadcastStateSnapshot('device-a', makeSnapshot(['@1']));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows).toHaveLength(1);
    expect(snapshot.session?.windows[0].customName).toBe('Keep');
    expect(server.windowCustomNames.get('device-a')?.has('@2')).toBe(false);
  });

  test('overlay survives connection entry recreation and applies on device connect', async () => {
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
        releaseRuntime: () => {},
      },
    }) as any;
    const ws = createBorshWs();
    sessionStateStore.create(ws);
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.handleRenameWindow('device-a', '@1', 'Persisted');

    // 模拟所有 client 断开后 entry 销毁、随后重连
    server.connections.delete('device-a');
    await server.handleDeviceConnect(ws, 'device-a');
    server.broadcastStateSnapshot('device-a', makeSnapshot(['@1']));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('Persisted');
  });
});
