import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import type { Device, StateSnapshotPayload, TmuxEvent } from '@tmex/shared';

import { LocalExternalTmuxConnection } from './local-external-connection';

const now = '2026-04-14T00:00:00.000Z';

function tmux(command: string): string {
  return execSync(`tmux ${command}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureCleanSession(sessionName: string): void {
  try {
    tmux(`kill-session -t ${sessionName}`);
  } catch {
    // ignore
  }
}

function createLocalDevice(session: string): Device {
  return {
    id: 'device-local',
    name: 'local',
    type: 'local',
    authMode: 'auto',
    session,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await Bun.sleep(50);
  }
  throw new Error('waitFor timeout');
}

describe('LocalExternalTmuxConnection integration', () => {
  test('connects to tmux session, captures history, streams live output and bell', async () => {
    const sessionName = `tmex-gateway-local-${Date.now()}`;
    ensureCleanSession(sessionName);
    tmux(`new-session -d -s ${sessionName} "sh -lc 'echo READY_MARKER; exec sh'"`);

    const snapshots: StateSnapshotPayload[] = [];
    const histories: Array<{ paneId: string; data: string }> = [];
    const outputs: string[] = [];
    const events: TmuxEvent[] = [];

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: (_paneId, data) => {
          outputs.push(new TextDecoder().decode(data));
        },
        onTerminalHistory: (paneId, data) => {
          histories.push({ paneId, data });
        },
        onSnapshot: (payload) => {
          snapshots.push(payload);
        },
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        getDevice: () => createLocalDevice(sessionName),
      }
    );

    try {
      await connection.connect();

      const snapshot = await waitFor(() => snapshots.at(-1)?.session ?? null);
      const windowId = snapshot.windows[0]?.id ?? null;
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;

      expect(windowId).toBeTruthy();
      expect(paneId).toBeTruthy();
      if (!windowId || !paneId) {
        throw new Error('snapshot missing active pane');
      }

      connection.selectPane(windowId, paneId);

      const history = await waitFor(
        () => histories.find((item) => item.paneId === paneId)?.data ?? null
      );
      expect(history).toContain('READY_MARKER');

      connection.sendInput(paneId, 'echo LIVE_MARKER\r');
      await waitFor(() => {
        const joined = outputs.join('');
        return joined.includes('LIVE_MARKER') ? joined : null;
      });

      connection.sendInput(paneId, "printf '\\a'\r");
      await waitFor(() => events.find((event) => event.type === 'bell') ?? null);
    } finally {
      connection.disconnect();
      ensureCleanSession(sessionName);
    }
  }, 20_000);

  test('re-selecting the same pane concurrently does not reopen fifo twice', async () => {
    const sessionName = `tmex-gateway-local-reselect-${Date.now()}`;
    ensureCleanSession(sessionName);
    tmux(`new-session -d -s ${sessionName} "sh -lc 'echo READY_MARKER; exec sh'"`);

    const snapshots: StateSnapshotPayload[] = [];
    const histories: Array<{ paneId: string; data: string }> = [];
    const errors: Error[] = [];

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data) => {
          histories.push({ paneId, data });
        },
        onSnapshot: (payload) => {
          snapshots.push(payload);
        },
        onError: (error) => {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        },
        onClose: () => {},
      },
      {
        getDevice: () => createLocalDevice(sessionName),
      }
    );

    try {
      await connection.connect();

      const snapshot = await waitFor(() => snapshots.at(-1)?.session ?? null);
      const windowId = snapshot.windows[0]?.id ?? null;
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;

      expect(windowId).toBeTruthy();
      expect(paneId).toBeTruthy();
      if (!windowId || !paneId) {
        throw new Error('snapshot missing active pane');
      }

      connection.selectPane(windowId, paneId);
      connection.selectPane(windowId, paneId);

      const history = await waitFor(
        () => histories.find((item) => item.paneId === paneId)?.data ?? null
      );
      expect(history).toContain('READY_MARKER');

      await Bun.sleep(200);
      expect(errors).toHaveLength(0);
    } finally {
      connection.disconnect();
      ensureCleanSession(sessionName);
    }
  }, 20_000);
});
