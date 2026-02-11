import { describe, expect, test } from 'bun:test';
import type { Device, SiteSettings, StateSnapshotPayload } from '@tmex/shared';
import { PushSupervisor } from './supervisor';

const now = '2026-02-11T00:00:00.000Z';

function createDevice(id: string): Device {
  return {
    id,
    name: id,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    createdAt: now,
    updatedAt: now,
  };
}

function createSettings(): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 6,
    enableBrowserBellToast: true,
    enableTelegramBellPush: true,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 1,
    language: 'zh_CN',
    updatedAt: now,
  };
}

describe('PushSupervisor', () => {
  test('start should connect all devices and request snapshots', async () => {
    const devices = [createDevice('d1'), createDevice('d2')];
    const connectCalls: string[] = [];
    const snapshotCalls: string[] = [];

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => devices,
        getDevice: (deviceId) => devices.find((item) => item.id === deviceId) ?? null,
        getSettings: () => createSettings(),
        createConnection: (options) =>
          ({
            async connect() {
              connectCalls.push(options.deviceId);
            },
            requestSnapshot() {
              snapshotCalls.push(options.deviceId);
            },
            disconnect() {},
          }) as any,
      },
    });

    await supervisor.start();

    expect(connectCalls.sort()).toEqual(['d1', 'd2']);
    expect(snapshotCalls.sort()).toEqual(['d1', 'd2']);

    await supervisor.stopAll();
  });

  test('remove should disconnect existing connection', async () => {
    const devices = [createDevice('d1')];
    let disconnected = false;

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => devices,
        getDevice: (deviceId) => devices.find((item) => item.id === deviceId) ?? null,
        getSettings: () => createSettings(),
        createConnection: () =>
          ({
            async connect() {},
            requestSnapshot() {},
            disconnect() {
              disconnected = true;
            },
          }) as any,
      },
    });

    await supervisor.start();
    supervisor.remove('d1');

    expect(disconnected).toBe(true);
    await supervisor.stopAll();
  });

  test('bell event should notify with resolved pane context', async () => {
    const device = createDevice('d1');
    const notifications: Array<{ paneId?: string; windowId?: string; paneUrl?: string }> = [];

    const supervisor = new PushSupervisor({
      deps: {
        listDevices: () => [device],
        getDevice: () => device,
        getSettings: () => createSettings(),
        createConnection: (options) =>
          ({
            async connect() {
              const snapshot: StateSnapshotPayload = {
                deviceId: device.id,
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
              };

              options.onSnapshot(snapshot);
              options.onEvent({ type: 'bell', data: { paneId: '%1' } });
            },
            requestSnapshot() {},
            disconnect() {},
          }) as any,
        async notifyBell(context) {
          notifications.push({
            paneId: context.bell.paneId,
            windowId: context.bell.windowId,
            paneUrl: context.bell.paneUrl,
          });
        },
      },
    });

    await supervisor.start();

    expect(notifications).toEqual([
      {
        paneId: '%1',
        windowId: '@1',
        paneUrl: 'https://tmex.example.com/devices/d1/windows/%401/panes/%251',
      },
    ]);

    await supervisor.stopAll();
  });
});
