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
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 10_000
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
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

  // capturePaneText 走独立临时 socket（-L），不触碰默认 socket 上的任何会话。
  test('capturePaneText reads plain pane text on demand with optional history', async () => {
    const socketName = `tmex-test-capture-${Date.now()}`;
    const sessionName = 'tmex-capture-text';

    execSync(
      `tmux -L ${socketName} new-session -d -x 80 -y 10 -s ${sessionName} "sh -lc 'exec sh'"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const runOnSocket = async (argv: string[]) => {
      const subprocess = Bun.spawn(['tmux', '-L', socketName, ...argv.slice(1)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

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
        onError: () => {},
        onClose: () => {},
      },
      {
        getDevice: () => createLocalDevice(sessionName),
        run: runOnSocket,
        ensureGhosttyTerminfo: async () => false,
        enableSubscription: false,
      }
    );

    try {
      await connection.connect();

      const snapshot = await waitFor(() => snapshots.at(-1)?.session ?? null);
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;
      expect(paneId).toBeTruthy();
      if (!paneId) {
        throw new Error('snapshot missing pane');
      }

      // 带 SGR 颜色写入，capture 结果必须是去掉转义序列的纯文本
      connection.sendInput(paneId, "printf '\\033[31mCAPTURE_RED_MARKER\\033[0m\\n'\r");
      const visibleWithMarker = await waitFor(async () => {
        const text = await connection.capturePaneText(paneId);
        return text.includes('CAPTURE_RED_MARKER') ? text : null;
      });
      expect(visibleWithMarker).not.toContain('\u001b');

      // 输出 40 行将早期行推出 10 行高的可见区，historyLines 才能取回
      connection.sendInput(paneId, 'for i in $(seq 1 40); do echo HIST_$i; done\r');
      const visible = await waitFor(async () => {
        const text = await connection.capturePaneText(paneId);
        return text.split('\n').includes('HIST_40') ? text : null;
      });
      expect(visible.split('\n')).not.toContain('HIST_1');

      const withHistory = await connection.capturePaneText(paneId, { historyLines: 200 });
      const historyLines = withHistory.split('\n');
      expect(historyLines).toContain('HIST_1');
      expect(historyLines).toContain('HIST_40');

      await expect(connection.capturePaneText('%4242')).rejects.toThrow(
        /can't find pane|no such pane/i
      );

      connection.disconnect();
      await expect(connection.capturePaneText(paneId)).rejects.toThrow(
        /tmux connection not available/
      );
    } finally {
      connection.disconnect();
      try {
        execSync(`tmux -L ${socketName} kill-server`, { stdio: 'ignore' });
      } catch {
        // server 已退出则忽略
      }
      execSync(`rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${socketName}"`, { stdio: 'ignore' });
    }
  }, 20_000);

  // getPaneInfo 同样走独立临时 socket，校验实时尺寸/前台命令。
  test('getPaneInfo reports live cols/rows and foreground command', async () => {
    const socketName = `tmex-test-paneinfo-${Date.now()}`;
    const sessionName = 'tmex-pane-info';

    execSync(
      `tmux -L ${socketName} new-session -d -x 100 -y 30 -s ${sessionName} "sh -lc 'exec sh'"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const runOnSocket = async (argv: string[]) => {
      const subprocess = Bun.spawn(['tmux', '-L', socketName, ...argv.slice(1)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

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
        onError: () => {},
        onClose: () => {},
      },
      {
        getDevice: () => createLocalDevice(sessionName),
        run: runOnSocket,
        ensureGhosttyTerminfo: async () => false,
        enableSubscription: false,
      }
    );

    try {
      await connection.connect();
      const snapshot = await waitFor(() => snapshots.at(-1)?.session ?? null);
      const paneId = snapshot.windows[0]?.panes[0]?.id ?? null;
      expect(paneId).toBeTruthy();
      if (!paneId) {
        throw new Error('snapshot missing pane');
      }

      const info = await connection.getPaneInfo(paneId);
      expect(info.cols).toBe(100);
      expect(info.rows).toBeGreaterThan(0);
      expect(info.rows).toBeLessThanOrEqual(30);
      expect(info.alternateScreen).toBe(false);
      expect(info.currentCommand).toBeTruthy();
      expect(typeof info.cursorX).toBe('number');

      connection.disconnect();
      await expect(connection.getPaneInfo(paneId)).rejects.toThrow(
        /tmux connection not available/
      );
    } finally {
      connection.disconnect();
      try {
        execSync(`tmux -L ${socketName} kill-server`, { stdio: 'ignore' });
      } catch {
        // server 已退出则忽略
      }
      execSync(`rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${socketName}"`, { stdio: 'ignore' });
    }
  }, 20_000);

  test('splitPane / resizePaneById / selectLayout / focusPane drive real tmux layout', async () => {
    const socketName = `tmex-test-split-${Date.now()}`;
    const sessionName = 'tmex-split';

    execSync(
      `tmux -L ${socketName} new-session -d -x 200 -y 50 -s ${sessionName} "sh -lc 'exec sh'"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const runOnSocket = async (argv: string[]) => {
      const subprocess = Bun.spawn(['tmux', '-L', socketName, ...argv.slice(1)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const snapshots: StateSnapshotPayload[] = [];
    const events: TmuxEvent[] = [];
    const histories: string[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId) => {
          histories.push(paneId);
        },
        onSnapshot: (payload) => {
          snapshots.push(payload);
        },
        onError: () => {},
        onClose: () => {},
      },
      {
        getDevice: () => createLocalDevice(sessionName),
        run: runOnSocket,
        ensureGhosttyTerminfo: async () => false,
        enableSubscription: false,
      }
    );

    try {
      await connection.connect();
      const initial = await waitFor(() => snapshots.at(-1)?.session ?? null);
      const windowId = initial.windows[0]?.id;
      const firstPaneId = initial.windows[0]?.panes[0]?.id;
      if (!windowId || !firstPaneId) {
        throw new Error('snapshot missing window/pane');
      }
      expect(initial.windows[0]?.layout).toMatch(/^[0-9a-f]{4},/);

      connection.resizeWindow(windowId, 200, 50);
      await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        return win?.panes[0]?.width === 200 ? win : null;
      });

      // 向右分屏：出现第二个 pane，layout 变为水平排列，焦点跟到新 pane
      connection.splitPane(firstPaneId, 'h');
      const afterSplit = await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        return win && win.panes.length === 2 ? win : null;
      });
      expect(afterSplit.layout).toContain('{');
      const secondPaneId = afterSplit.panes.find((pane) => pane.id !== firstPaneId)?.id;
      if (!secondPaneId) {
        throw new Error('split pane missing');
      }
      const splitEvent = events.find(
        (event) =>
          event.type === 'pane-active' &&
          (event.data as { paneId?: string } | undefined)?.paneId === secondPaneId
      );
      expect(splitEvent).toBeTruthy();
      const rightPane = afterSplit.panes.find((pane) => pane.id === secondPaneId);
      expect((rightPane?.left ?? 0) > 0).toBe(true);

      // 按绝对值调整左 pane 宽度，右 pane 应互补变化
      connection.resizePaneById(firstPaneId, { cols: 150 });
      const afterResize = await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        return win?.panes.find((pane) => pane.id === firstPaneId)?.width === 150 ? win : null;
      });
      const rightAfterResize = afterResize.panes.find((pane) => pane.id === secondPaneId);
      expect(rightAfterResize?.width).toBe(200 - 150 - 1);

      // even-horizontal：两 pane 宽度差 <= 1
      connection.selectLayout(windowId, 'even-horizontal');
      await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        if (!win) {
          return null;
        }
        const widths = win.panes.map((pane) => pane.width);
        return Math.abs((widths[0] ?? 0) - (widths[1] ?? 0)) <= 1 ? win : null;
      });

      // focusPane：切回第一个 pane，发 pane-active 但不触发 history capture
      const historyCountBefore = histories.length;
      connection.focusPane(windowId, firstPaneId);
      await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        return win?.panes.find((pane) => pane.id === firstPaneId)?.active ? win : null;
      });
      const focusEvent = events
        .slice()
        .reverse()
        .find((event) => event.type === 'pane-active');
      expect((focusEvent?.data as { paneId?: string } | undefined)?.paneId).toBe(firstPaneId);
      expect(histories.length).toBe(historyCountBefore);

      // 向下分屏：三 pane，layout 出现垂直排列
      connection.splitPane(firstPaneId, 'v');
      const afterVSplit = await waitFor(() => {
        const win = snapshots.at(-1)?.session?.windows[0];
        return win && win.panes.length === 3 ? win : null;
      });
      expect(afterVSplit.layout).toContain('[');
      const bottomPane = afterVSplit.panes.find(
        (pane) => pane.id !== firstPaneId && (pane.top ?? 0) > 0
      );
      expect(bottomPane).toBeTruthy();
    } finally {
      connection.disconnect();
      try {
        execSync(`tmux -L ${socketName} kill-server`, { stdio: 'ignore' });
      } catch {
        // server 已退出则忽略
      }
      execSync(`rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${socketName}"`, { stdio: 'ignore' });
    }
  }, 30_000);

});
