import { beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import type { Device, StateSnapshotPayload } from '@tmex/shared';

import { runMigrations } from '../db/migrate';
import type { TmuxEvent } from './events';
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

beforeAll(() => {
  runMigrations();
});

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

  test('OSC notifications (raw and tmux-passthrough-wrapped) flow through control mode', async () => {
    const sessionName = `tmex-gateway-local-notify-${Date.now()}`;
    ensureCleanSession(sessionName);
    tmux(`new-session -d -s ${sessionName} "sh -lc 'echo READY_MARKER; exec sh'"`);

    const snapshots: StateSnapshotPayload[] = [];
    const events: TmuxEvent[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
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
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;
      if (!paneId) {
        throw new Error('snapshot missing pane');
      }

      connection.sendInput(paneId, "printf '\\033]9;hello-notif\\007'\r");
      const rawNotif = await waitFor(
        () =>
          events.find(
            (event) =>
              event.type === 'notification' &&
              (event.data as { body?: string }).body === 'hello-notif'
          ) ?? null
      );
      expect((rawNotif.data as { source: string }).source).toBe('osc9');

      // Claude Code 在 tmux 内的形态：DCS tmux; 包装 + 内层 ESC 翻倍
      connection.sendInput(
        paneId,
        "printf '\\033Ptmux;\\033\\033]9;wrapped-notif\\007\\033\\\\'\r"
      );
      await waitFor(
        () =>
          events.find(
            (event) =>
              event.type === 'notification' &&
              (event.data as { body?: string }).body === 'wrapped-notif'
          ) ?? null
      );
    } finally {
      connection.disconnect();
      ensureCleanSession(sessionName);
    }
  }, 20_000);

  test('two gateway connections subscribe to the same session without preempting each other', async () => {
    const sessionName = `tmex-gateway-local-dual-${Date.now()}`;
    ensureCleanSession(sessionName);
    tmux(`new-session -d -s ${sessionName} "sh -lc 'echo READY_MARKER; exec sh'"`);

    function createConn(outputs: string[], snapshots: StateSnapshotPayload[]) {
      return new LocalExternalTmuxConnection(
        {
          deviceId: 'device-local',
          onEvent: () => {},
          onTerminalOutput: (_paneId, data) => {
            outputs.push(new TextDecoder().decode(data));
          },
          onTerminalHistory: () => {},
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
    }

    const outputsA: string[] = [];
    const outputsB: string[] = [];
    const snapshotsA: StateSnapshotPayload[] = [];
    const snapshotsB: StateSnapshotPayload[] = [];
    const connA = createConn(outputsA, snapshotsA);
    const connB = createConn(outputsB, snapshotsB);

    try {
      await connA.connect();
      await connB.connect();

      const snapshot = await waitFor(() => snapshotsA.at(-1)?.session ?? null);
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;
      if (!paneId) {
        throw new Error('snapshot missing pane');
      }

      // A 写入，两边都应收到
      connA.sendInput(paneId, 'echo DUAL_ONE\r');
      await waitFor(() => (outputsA.join('').includes('DUAL_ONE') ? true : null));
      await waitFor(() => (outputsB.join('').includes('DUAL_ONE') ? true : null));

      // B 写入，两边仍都应收到（pipe-pane 时代 B 会顶掉 A）
      connB.sendInput(paneId, 'echo DUAL_TWO\r');
      await waitFor(() => (outputsA.join('').includes('DUAL_TWO') ? true : null));
      await waitFor(() => (outputsB.join('').includes('DUAL_TWO') ? true : null));

      // A 断开后 B 不受影响
      connA.disconnect();
      await Bun.sleep(300);
      connB.sendInput(paneId, 'echo DUAL_THREE\r');
      await waitFor(() => (outputsB.join('').includes('DUAL_THREE') ? true : null));
    } finally {
      connA.disconnect();
      connB.disconnect();
      ensureCleanSession(sessionName);
    }
  }, 30_000);

  test('control client never delivers focus events to ?1004h panes (Claude Code 60s fallback guard)', async () => {
    const sessionName = `tmex-gateway-local-focus-${Date.now()}`;
    const focusLog = `/tmp/${sessionName}.focuslog`;
    ensureCleanSession(sessionName);
    // pane 进入 raw 模式、开启 focus reporting，并把 stdin 原样落盘；
    // 若 control attach / select-pane 触发焦点事件，日志中会出现 ESC[I / ESC[O。
    tmux(
      `new-session -d -s ${sessionName} "sh -c 'stty raw -echo; printf \\"\\\\033[?1004h\\"; exec cat -u > ${focusLog}'"`
    );

    const snapshots: StateSnapshotPayload[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
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
      if (!windowId || !paneId) {
        throw new Error('snapshot missing active pane');
      }

      connection.selectPane(windowId, paneId);
      await Bun.sleep(300);
      connection.sendInput(paneId, 'MARKER');

      const logged = await waitFor(() => {
        try {
          const content = execSync(`cat ${focusLog}`, { encoding: 'utf8' });
          return content.includes('MARKER') ? content : null;
        } catch {
          return null;
        }
      });

      expect(logged).not.toContain('[I');
      expect(logged).not.toContain('[O');
    } finally {
      connection.disconnect();
      ensureCleanSession(sessionName);
      execSync(`rm -f ${focusLog}`);
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
