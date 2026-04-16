import { describe, expect, test } from 'bun:test';

import type { TmuxConnectionOptions } from './connection-types';
import {
  type DeviceSessionRuntimeConnection,
  createDeviceSessionRuntime,
} from './device-session-runtime';

function createStubConnectionRecorder() {
  const state = {
    connectCalls: 0,
    disconnectCalls: 0,
    requestSnapshotCalls: 0,
    sendInputCalls: [] as Array<[string, string]>,
    resizePaneCalls: [] as Array<[string, number, number]>,
    selectPaneCalls: [] as Array<[string, string]>,
    selectWindowCalls: [] as string[],
    createWindowCalls: [] as Array<[string | undefined]>,
    closeWindowCalls: [] as string[],
    closePaneCalls: [] as string[],
    renameWindowCalls: [] as Array<[string, string]>,
    options: null as TmuxConnectionOptions | null,
  };

  let releaseConnect: (() => void) | null = null;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });

  const connection: DeviceSessionRuntimeConnection = {
    async connect() {
      state.connectCalls += 1;
      await connectGate;
    },
    disconnect() {
      state.disconnectCalls += 1;
    },
    requestSnapshot() {
      state.requestSnapshotCalls += 1;
    },
    sendInput(paneId, data) {
      state.sendInputCalls.push([paneId, data]);
    },
    resizePane(paneId, cols, rows) {
      state.resizePaneCalls.push([paneId, cols, rows]);
    },
    selectPane(windowId, paneId) {
      state.selectPaneCalls.push([windowId, paneId]);
    },
    selectPaneWithSize(windowId, paneId, cols, rows) {
      state.selectPaneCalls.push([windowId, paneId]);
      state.resizePaneCalls.push([paneId, cols, rows]);
    },
    selectWindow(windowId) {
      state.selectWindowCalls.push(windowId);
    },
    createWindow(name) {
      state.createWindowCalls.push([name]);
    },
    closeWindow(windowId) {
      state.closeWindowCalls.push(windowId);
    },
    closePane(paneId) {
      state.closePaneCalls.push(paneId);
    },
    renameWindow(windowId, name) {
      state.renameWindowCalls.push([windowId, name]);
    },
  };

  return {
    state,
    releaseConnect: () => {
      releaseConnect?.();
      releaseConnect = null;
    },
    connection,
  };
}

describe('DeviceSessionRuntime', () => {
  test('deduplicates connect calls for the same runtime instance', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    const first = runtime.connect();
    const second = runtime.connect();

    expect(recorder.state.connectCalls).toBe(1);

    recorder.releaseConnect();
    await Promise.all([first, second]);

    expect(recorder.state.connectCalls).toBe(1);
  });

  test('broadcasts tmux events and payloads to every subscriber', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const firstHistory: string[] = [];
    const secondHistory: string[] = [];
    const firstSnapshots: string[] = [];
    const secondSnapshots: string[] = [];
    const firstErrors: string[] = [];
    const secondErrors: string[] = [];
    let firstClosed = 0;
    let secondClosed = 0;

    runtime.subscribe({
      onEvent(event) {
        firstEvents.push(event.type);
      },
      onTerminalOutput(paneId, data) {
        firstEvents.push(`output:${paneId}:${Array.from(data).join(',')}`);
      },
      onTerminalHistory(paneId, data) {
        firstHistory.push(`${paneId}:${data}`);
      },
      onSnapshot(payload) {
        firstSnapshots.push(payload.deviceId);
      },
      onError(error) {
        firstErrors.push(error.message);
      },
      onClose() {
        firstClosed += 1;
      },
    });

    runtime.subscribe({
      onEvent(event) {
        secondEvents.push(event.type);
      },
      onTerminalOutput(paneId, data) {
        secondEvents.push(`output:${paneId}:${Array.from(data).join(',')}`);
      },
      onTerminalHistory(paneId, data) {
        secondHistory.push(`${paneId}:${data}`);
      },
      onSnapshot(payload) {
        secondSnapshots.push(payload.deviceId);
      },
      onError(error) {
        secondErrors.push(error.message);
      },
      onClose() {
        secondClosed += 1;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    const options = recorder.state.options;
    expect(options).not.toBeNull();

    options?.onEvent({ type: 'bell', data: { paneId: '%1' } });
    options?.onTerminalOutput('%1', new Uint8Array([0x41, 0x42]));
    options?.onTerminalHistory('%1', 'history-data', false);
    options?.onSnapshot({
      deviceId: 'device-a',
      session: null,
    });
    options?.onError(new Error('boom'));
    options?.onClose();

    expect(firstEvents).toEqual(['bell', 'output:%1:65,66']);
    expect(secondEvents).toEqual(['bell', 'output:%1:65,66']);
    expect(firstHistory).toEqual(['%1:history-data']);
    expect(secondHistory).toEqual(['%1:history-data']);
    expect(firstSnapshots).toEqual(['device-a']);
    expect(secondSnapshots).toEqual(['device-a']);
    expect(firstErrors).toEqual(['boom']);
    expect(secondErrors).toEqual(['boom']);
    expect(firstClosed).toBe(1);
    expect(secondClosed).toBe(1);
  });

  test('disconnects the underlying connection only once', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    runtime.disconnect();
    runtime.disconnect();

    expect(recorder.state.disconnectCalls).toBe(1);
  });

  test('rejects reconnect attempts after the runtime has been closed', async () => {
    const recorder = createStubConnectionRecorder();
    const runtime = createDeviceSessionRuntime({
      deviceId: 'device-a',
      createConnection(options) {
        recorder.state.options = options;
        return recorder.connection;
      },
    });

    recorder.releaseConnect();
    await runtime.connect();

    recorder.state.options?.onClose();

    let caught: Error | null = null;
    try {
      await runtime.connect();
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(caught?.message ?? '').toContain('Device session runtime already terminated');
  });
});
