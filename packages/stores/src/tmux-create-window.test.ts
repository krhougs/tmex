// create-window pending → 失败态的状态机测试：
// - createWindow 置 pending（queued 或直发）并启动超时 watcher
// - 超时仍无新窗口 → pending 清除并置 windowCreateFailed（显式失败反馈的依据）
// - ack + 跟随清除（clearPendingCreateWindow）→ 取消 watcher，不置失败
// - queued 补发（metadata-snapshot）→ 超时窗口重新起算
// - 重试（再次 createWindow）→ 清除既有失败态

import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { type GatewayTransportCommand, createSharedGatewayTransport } from '@tmex/ws-client';
import { createAppRuntime } from './app-runtime';

const CREATE_TIMEOUT_MS = 25;
const SLEEP_MS = 60;

class MemStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
  });
}

const initialSnapshot: StateSnapshotPayload = {
  deviceId: 'device-a',
  session: {
    id: '$1',
    name: 'main',
    windows: [
      {
        id: '@1',
        name: 'shell',
        index: 0,
        active: true,
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            title: 'before',
            active: true,
            width: 80,
            height: 24,
          },
        ],
      },
    ],
  },
};

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const transport = createSharedGatewayTransport({
    initialState: 'READY',
    onCommand: (command) => {
      commands.push(command);
    },
  });
  const runtime = createAppRuntime({ transport, createWindowTimeoutMs: CREATE_TIMEOUT_MS });
  runtime.stores.tmux.getState().ensureSocketConnected();
  commands.length = 0;
  return { runtime, transport, commands };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('create-window pending lifecycle', () => {
  test('queued create expires into an explicit failure state instead of lingering pending', async () => {
    const { runtime, commands } = createHarness();
    const tmux = runtime.stores.tmux.getState();

    // 无快照 → 不能直发，入队
    tmux.createWindow('device-a');
    let state = runtime.stores.tmux.getState();
    expect(state.pendingCreateWindow['device-a']?.queued).toBeDefined();
    expect(commands.some((c) => c.type === 'create-window')).toBe(false);

    await sleep(SLEEP_MS);
    state = runtime.stores.tmux.getState();
    expect(state.pendingCreateWindow['device-a']).toBeUndefined();
    expect(state.windowCreateFailed['device-a']).toBeDefined();
  });

  test('queued create resends on first snapshot and restarts the timeout window', async () => {
    const { runtime, transport, commands } = createHarness();
    const tmux = runtime.stores.tmux.getState();

    tmux.createWindow('device-a');
    transport.publish({ type: 'metadata-snapshot', snapshot: initialSnapshot });
    const sent = commands.filter((c) => c.type === 'create-window');
    expect(sent).toHaveLength(1);
    expect(runtime.stores.tmux.getState().pendingCreateWindow['device-a']?.queued).toBeUndefined();

    // 快照已到但窗口一直未出现 → 仍会超时失败
    await sleep(SLEEP_MS);
    const state = runtime.stores.tmux.getState();
    expect(state.pendingCreateWindow['device-a']).toBeUndefined();
    expect(state.windowCreateFailed['device-a']).toBeDefined();
  });

  test('ack then follow-clear cancels the watcher without a failure state', async () => {
    const { runtime, transport } = createHarness();
    const tmux = runtime.stores.tmux.getState();

    transport.publish({ type: 'metadata-snapshot', snapshot: initialSnapshot });
    tmux.createWindow('device-a');
    expect(runtime.stores.tmux.getState().pendingCreateWindow['device-a']?.queued).toBeUndefined();

    transport.publish({ type: 'window-created', deviceId: 'device-a', windowId: '@2' });
    expect(runtime.stores.tmux.getState().pendingCreateWindow['device-a']?.createdWindowId).toBe(
      '@2'
    );

    // 前端 follow 成功后的清理路径
    tmux.clearPendingCreateWindow('device-a');

    await sleep(SLEEP_MS);
    const state = runtime.stores.tmux.getState();
    expect(state.pendingCreateWindow['device-a']).toBeUndefined();
    expect(state.windowCreateFailed['device-a']).toBeUndefined();
  });

  test('retry clears the failure state and re-arms pending', async () => {
    const { runtime } = createHarness();
    const tmux = runtime.stores.tmux.getState();

    tmux.createWindow('device-a');
    await sleep(SLEEP_MS);
    expect(runtime.stores.tmux.getState().windowCreateFailed['device-a']).toBeDefined();

    tmux.createWindow('device-a');
    const state = runtime.stores.tmux.getState();
    expect(state.windowCreateFailed['device-a']).toBeUndefined();
    expect(state.pendingCreateWindow['device-a']).toBeDefined();

    // 重试后仍未成功 → 再次失败
    await sleep(SLEEP_MS);
    expect(runtime.stores.tmux.getState().windowCreateFailed['device-a']).toBeDefined();
  });

  test('snapshot-ready create sends immediately and still expires without an ack', async () => {
    const { runtime, transport, commands } = createHarness();
    const tmux = runtime.stores.tmux.getState();

    transport.publish({ type: 'metadata-snapshot', snapshot: initialSnapshot });
    tmux.createWindow('device-a');
    const sent = commands.filter((c) => c.type === 'create-window');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'create-window', deviceId: 'device-a' });
    expect(runtime.stores.tmux.getState().pendingCreateWindow['device-a']?.queued).toBeUndefined();

    await sleep(SLEEP_MS);
    const state = runtime.stores.tmux.getState();
    expect(state.pendingCreateWindow['device-a']).toBeUndefined();
    expect(state.windowCreateFailed['device-a']).toBeDefined();
  });
});
