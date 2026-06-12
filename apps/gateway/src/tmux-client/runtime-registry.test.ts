import { describe, expect, test } from 'bun:test';

import { createTmuxRuntimeRegistry } from './runtime-registry';

interface FakeTerminatableRuntime {
  deviceId: string;
  isTerminated: boolean;
  shutdownCalls: number;
  shutdown(): Promise<void>;
}

function createFakeRuntime(deviceId: string): FakeTerminatableRuntime {
  const runtime: FakeTerminatableRuntime = {
    deviceId,
    isTerminated: false,
    shutdownCalls: 0,
    async shutdown() {
      runtime.shutdownCalls += 1;
      runtime.isTerminated = true;
    },
  };
  return runtime;
}

describe('tmux runtime registry', () => {
  test('deduplicates concurrent acquire calls for the same device', async () => {
    let createCalls = 0;
    const gate: { open: ((runtime: FakeTerminatableRuntime) => void) | null } = { open: null };
    const gatedRuntime = new Promise<FakeTerminatableRuntime>((resolve) => {
      gate.open = resolve;
    });

    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => {
        createCalls += 1;
        return gatedRuntime.then(() => createFakeRuntime(deviceId));
      },
    });

    const p1 = registry.acquire('device-a');
    const p2 = registry.acquire('device-a');

    gate.open?.(createFakeRuntime('device-a'));

    const [runtime1, runtime2] = await Promise.all([p1, p2]);

    expect(createCalls).toBe(1);
    expect(runtime1).toBe(runtime2);
  });

  test('keeps runtime alive until the last release', async () => {
    const shutdownCalls: string[] = [];
    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => ({
        deviceId,
        async shutdown() {
          shutdownCalls.push(deviceId);
        },
      }),
    });

    const runtime = await registry.acquire('device-a');
    const sameRuntime = await registry.acquire('device-a');

    expect(runtime).toBe(sameRuntime);

    await registry.release('device-a');
    expect(shutdownCalls).toEqual([]);

    await registry.release('device-a');
    expect(shutdownCalls).toEqual(['device-a']);
  });

  test('acquire 废弃已 terminated 的 runtime 并新建实例', async () => {
    let createCalls = 0;
    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => {
        createCalls += 1;
        return createFakeRuntime(deviceId);
      },
    });

    const first = await registry.acquire('device-a');
    first.isTerminated = true; // 模拟连接断开后 runtime 永久关闭

    const second = await registry.acquire('device-a');
    expect(createCalls).toBe(2);
    expect(second).not.toBe(first);
    expect(second.isTerminated).toBe(false);

    await registry.release('device-a', second);
    expect(second.shutdownCalls).toBe(1);
  });

  test('旧持有者按实例 release 走 orphan 计数，不影响新 entry', async () => {
    let createCalls = 0;
    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => {
        createCalls += 1;
        return createFakeRuntime(deviceId);
      },
    });

    const first = await registry.acquire('device-a');
    first.isTerminated = true;

    const second = await registry.acquire('device-a');
    const third = await registry.acquire('device-a');
    expect(third).toBe(second);
    expect(createCalls).toBe(2);

    // 旧持有者 release：递减 orphan，新 entry 计数不受影响
    await registry.release('device-a', first);
    expect(first.shutdownCalls).toBe(1);
    expect(second.shutdownCalls).toBe(0);

    // 重复 release 旧实例：orphan 已清理且与当前 entry 不匹配，忽略
    await registry.release('device-a', first);
    const fourth = await registry.acquire('device-a');
    expect(fourth).toBe(second);
    expect(createCalls).toBe(2);

    await registry.release('device-a', second);
    await registry.release('device-a', third);
    expect(second.shutdownCalls).toBe(0);
    await registry.release('device-a', fourth);
    expect(second.shutdownCalls).toBe(1);
    const fresh = await registry.acquire('device-a');
    expect(fresh).not.toBe(second);
    expect(createCalls).toBe(3);
  });

  test('shutdownAll shuts down each active runtime once and clears the registry', async () => {
    const shutdownCalls: string[] = [];
    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => ({
        deviceId,
        async shutdown() {
          shutdownCalls.push(deviceId);
        },
      }),
    });

    await registry.acquire('device-a');
    await registry.acquire('device-b');

    await registry.shutdownAll();

    expect(shutdownCalls.sort()).toEqual(['device-a', 'device-b']);

    const runtime = await registry.acquire('device-a');
    expect(runtime.deviceId).toBe('device-a');
    expect(shutdownCalls.sort()).toEqual(['device-a', 'device-b']);
  });
});
