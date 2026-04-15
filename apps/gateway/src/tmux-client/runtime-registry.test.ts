import { describe, expect, test } from 'bun:test';

import { createTmuxRuntimeRegistry } from './runtime-registry';

describe('tmux runtime registry', () => {
  test('deduplicates concurrent acquire calls for the same device', async () => {
    let createCalls = 0;
    let releaseFactory:
      | ((runtime: {
          deviceId: string;
          shutdownCalls: number;
          shutdown: () => Promise<void>;
        }) => void)
      | null = null;

    const gate = new Promise<{
      deviceId: string;
      shutdownCalls: number;
      shutdown: () => Promise<void>;
    }>((resolve) => {
      releaseFactory = resolve;
    });

    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId) => {
        createCalls += 1;
        return gate.then(() => ({
          deviceId,
          shutdownCalls: 0,
          async shutdown() {
            this.shutdownCalls += 1;
          },
        }));
      },
    });

    const p1 = registry.acquire('device-a');
    const p2 = registry.acquire('device-a');

    releaseFactory?.({
      deviceId: 'device-a',
      shutdownCalls: 0,
      async shutdown() {
        this.shutdownCalls += 1;
      },
    });

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
