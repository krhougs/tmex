import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';

import { handleDeviceTestConnection } from './test-connection';
import { createTmuxRuntimeRegistry } from '../tmux-client/runtime-registry';

const now = '2026-04-16T00:00:00.000Z';

function createDevice(): Device {
  return {
    id: 'device-ssh',
    name: 'dns shanghai',
    type: 'ssh',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authMode: 'agent',
    session: 'main1',
    createdAt: now,
    updatedAt: now,
  };
}

function createLocalDevice(): Device {
  return {
    id: 'device-local',
    name: 'local-device',
    type: 'local',
    authMode: 'auto',
    session: 'tmex',
    createdAt: now,
    updatedAt: now,
  };
}

describe('handleDeviceTestConnection', () => {
  test('returns 404 when device does not exist', async () => {
    const response = await handleDeviceTestConnection('missing-device', {
      getDevice: () => null,
      translate: (key: string) => key,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'apiError.deviceNotFound',
    });
  });

  test('uses runtime path for local devices instead of ssh probe', async () => {
    let runtimeConnectCalls = 0;

    const response = await handleDeviceTestConnection('device-local', {
      getDevice: () => createLocalDevice(),
      acquireRuntime: async () => ({
        async connect() {
          runtimeConnectCalls += 1;
        },
        requestSnapshot() {},
      }),
      releaseRuntime: async () => {},
      translate: (key: string) => key,
    });

    expect(runtimeConnectCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      tmuxAvailable: true,
      phase: 'ready',
      message: 'common.success',
    });
  });

  test('returns phase-aware payload instead of stubbed success when probe fails', async () => {
    const response = await handleDeviceTestConnection('device-ssh', {
      getDevice: () => createDevice(),
      acquireRuntime: async () => ({
        async connect() {
          throw new Error('tmux_not_found');
        },
        requestSnapshot() {},
      }),
      releaseRuntime: async () => {},
      translate: (key: string) => key,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: false,
      tmuxAvailable: false,
      phase: 'bootstrap',
      errorType: 'tmux_unavailable',
      message: 'sshError.tmuxUnavailable',
      rawMessage: 'tmux_not_found',
    });
  });

  test('wraps thrown probe errors into structured failure payload', async () => {
    const response = await handleDeviceTestConnection('device-ssh', {
      getDevice: () => createDevice(),
      acquireRuntime: async () => ({
        async connect() {
          throw new Error('auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）');
        },
        async shutdown() {},
        requestSnapshot() {},
      }),
      releaseRuntime: async () => {},
      translate: (key: string) => key,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: false,
      tmuxAvailable: false,
      phase: 'connect',
      errorType: 'agent_unavailable',
      message: 'sshError.agentUnavailable',
      rawMessage: 'auth_auto_missing: auto 模式下未找到可用认证方式（SSH_AUTH_SOCK / 私钥 / 密码）',
    });
  });

  test('reuses a single runtime when test-connection is called concurrently for the same device', async () => {
    let createCalls = 0;
    let connectCalls = 0;
    const releaseGateRef: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      releaseGateRef.current = resolve;
    });

    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId: string) => {
        createCalls += 1;
        let connectPromise: Promise<void> | null = null;
        return {
          deviceId,
          async connect() {
            if (!connectPromise) {
              connectCalls += 1;
              connectPromise = gate;
            }
            await connectPromise;
          },
          requestSnapshot() {},
          async shutdown() {},
        };
      },
    });

    const deps = {
      getDevice: () => createDevice(),
      acquireRuntime: async (deviceId: string) => registry.acquire(deviceId),
      releaseRuntime: async (deviceId: string) => registry.release(deviceId),
      translate: (key: string) => key,
    };

    const first = handleDeviceTestConnection('device-ssh', deps);
    const second = handleDeviceTestConnection('device-ssh', deps);

    expect(createCalls).toBe(1);
    releaseGateRef.current?.();

    const [firstPayload, secondPayload] = await Promise.all([first, second]).then((responses) =>
      Promise.all(responses.map((response) => response.json()))
    );

    expect(connectCalls).toBe(1);
    expect(firstPayload).toMatchObject({ success: true, phase: 'ready' });
    expect(secondPayload).toMatchObject({ success: true, phase: 'ready' });
  });

  test('reuses an already acquired runtime instead of creating a second connection', async () => {
    let createCalls = 0;
    let connectCalls = 0;

    const registry = createTmuxRuntimeRegistry({
      createRuntime: async (deviceId: string) => {
        createCalls += 1;
        let connectPromise: Promise<void> | null = null;
        return {
          deviceId,
          async connect() {
            if (!connectPromise) {
              connectCalls += 1;
              connectPromise = Promise.resolve();
            }
            await connectPromise;
          },
          requestSnapshot() {},
          async shutdown() {},
        };
      },
    });

    const retained = await registry.acquire('device-ssh');
    await retained.connect();

    const response = await handleDeviceTestConnection('device-ssh', {
      getDevice: () => createDevice(),
      acquireRuntime: async (deviceId: string) => registry.acquire(deviceId),
      releaseRuntime: async (deviceId: string) => registry.release(deviceId),
      translate: (key: string) => key,
    });

    expect(createCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(await response.json()).toMatchObject({ success: true, phase: 'ready' });

    await registry.release('device-ssh');
  });
});
