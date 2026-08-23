import { describe, expect, test } from 'bun:test';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import { TerminalSurface } from './TerminalSurface';

const EPOCH = new Uint8Array(16).fill(7);
const decoder = new TextDecoder();

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeSnapshot(beforeLine = 100): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'dev',
    paneId: 'pane',
    paneEpoch: EPOCH,
    baseSeq: 1n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: new TextEncoder().encode('screen body'),
    historyCursor: { paneEpoch: EPOCH, historyEpoch: EPOCH, beforeLine },
  };
}

function makePage(
  lineEnd: number,
  lineStart: number,
  data: string,
  nextBeforeLine: number | null
): GatewayPaneHistoryPage {
  return {
    deviceId: 'dev',
    paneId: 'pane',
    paneEpoch: EPOCH,
    historyEpoch: EPOCH,
    lineStart,
    lineEnd,
    truncated: false,
    data: new TextEncoder().encode(data),
    nextCursor:
      nextBeforeLine === null
        ? null
        : { paneEpoch: EPOCH, historyEpoch: EPOCH, beforeLine: nextBeforeLine },
  };
}

describe('TerminalSurface history pages', () => {
  test('applyHistoryPage 走 prependHistory 前插，不再触发 writeSnapshot（终端重建）', async () => {
    const events: string[] = [];
    const surface = new TerminalSurface({
      createTarget: async () => ({ dispose() {} }),
      writeSnapshot(_target, _snapshot, historyPages) {
        events.push(`snapshot:${historyPages.length}`);
      },
      prependHistory(_target, page) {
        events.push(`prepend:${decoder.decode(page.data)}`);
      },
      writeLive() {},
      activate() {},
      onRecoveryRequired() {},
    });
    await surface.initialize();
    surface.replace(makeSnapshot());
    await flush();

    expect(surface.applyHistoryPage(makePage(100, 95, 'five\nfour\nthree\ntwo\none\n', 95))).toBe(
      true
    );
    expect(
      surface.applyHistoryPage(makePage(95, 90, 'older5\nolder4\nolder3\nolder2\nolder1\n', 90))
    ).toBe(true);

    // replace 只重建一次；翻页只前插
    expect(events).toEqual([
      'snapshot:0',
      'prepend:five\nfour\nthree\ntwo\none\n',
      'prepend:older5\nolder4\nolder3\nolder2\nolder1\n',
    ]);
    // cursor 推进与 historyPages 积累保留（replace 重建基线 / 诊断用）
    expect(surface.getNextHistoryCursor()?.beforeLine).toBe(90);
    expect(surface.getDiagnosticState().historyPages).toBe(2);
  });

  test('页校验失败仍触发 recovery，prependHistory 不被调用', async () => {
    const events: string[] = [];
    const recoveryReasons: string[] = [];
    const surface = new TerminalSurface({
      createTarget: async () => ({ dispose() {} }),
      writeSnapshot(_target, _snapshot, historyPages) {
        events.push(`snapshot:${historyPages.length}`);
      },
      prependHistory() {
        events.push('prepend');
      },
      writeLive() {},
      activate() {},
      onRecoveryRequired(reason) {
        recoveryReasons.push(reason);
      },
    });
    await surface.initialize();
    surface.replace(makeSnapshot());
    await flush();

    // historyEpoch 不匹配
    const badPage: GatewayPaneHistoryPage = {
      ...makePage(100, 95, 'x\n', 95),
      historyEpoch: new Uint8Array(16).fill(9),
    };
    expect(surface.applyHistoryPage(badPage)).toBe(false);
    expect(events).toEqual(['snapshot:0']);
    expect(recoveryReasons).toEqual(['cache_evicted']);
  });
});

describe('TerminalSurface snapshot replacement', () => {
  test('隐藏候选终端追平 live 并完成首帧后才替换可见终端', async () => {
    interface Target {
      id: number;
      writes: string[];
      disposed: boolean;
      dispose(): void;
    }
    const firstRender = deferred();
    const targets: Target[] = [];
    const activated: number[] = [];
    const surface = new TerminalSurface<Target>({
      async createTarget() {
        const target: Target = {
          id: targets.length + 1,
          writes: [],
          disposed: false,
          dispose() {
            this.disposed = true;
          },
        };
        targets.push(target);
        return target;
      },
      writeSnapshot(target, snapshot) {
        target.writes.push(`snapshot:${decoder.decode(snapshot.data)}`);
      },
      prependHistory() {},
      writeLive(target, data) {
        target.writes.push(`live:${decoder.decode(data)}`);
      },
      waitForFirstRender(target) {
        return target.id === 2 ? firstRender.promise : Promise.resolve();
      },
      activate(target) {
        activated.push(target.id);
      },
      onRecoveryRequired() {},
    });
    await surface.initialize();

    surface.replace(makeSnapshot());
    surface.write({
      deviceId: 'dev',
      paneId: 'pane',
      data: new TextEncoder().encode('one'),
    });
    await flush();
    surface.write({
      deviceId: 'dev',
      paneId: 'pane',
      data: new TextEncoder().encode('two'),
    });

    expect(activated).toEqual([1]);
    expect(targets[0]?.writes).toEqual(['live:one', 'live:two']);
    expect(targets[1]?.writes).toEqual(['snapshot:screen body', 'live:one', 'live:two']);
    expect(targets[0]?.disposed).toBe(false);

    firstRender.resolve();
    await flush();
    expect(activated).toEqual([1, 2]);
    expect(targets[0]?.disposed).toBe(true);
    expect(surface.getVisibleTarget()?.id).toBe(2);
  });

  test('候选创建期间 live 超限时保留可见终端并请求恢复', async () => {
    const createCandidate = deferred();
    const recoveries: string[] = [];
    let created = 0;
    const targets = [
      {
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      },
      {
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      },
    ];
    const surface = new TerminalSurface({
      async createTarget() {
        const index = created++;
        if (index === 1) await createCandidate.promise;
        const target = targets[index];
        if (!target) throw new Error('unexpected target');
        return target;
      },
      writeSnapshot() {},
      prependHistory() {},
      writeLive() {},
      activate() {},
      onRecoveryRequired(reason) {
        recoveries.push(reason);
      },
      maxPendingLiveBytes: 3,
    });
    const visible = await surface.initialize();

    surface.replace(makeSnapshot());
    surface.write({
      deviceId: 'dev',
      paneId: 'pane',
      data: new TextEncoder().encode('four'),
    });

    expect(surface.getVisibleTarget()).toBe(visible);
    expect(visible.disposed).toBe(false);
    expect(recoveries).toEqual(['resource_exhausted']);

    createCandidate.resolve();
    await flush();
    expect(targets[1]?.disposed).toBe(true);
    expect(surface.getVisibleTarget()).toBe(visible);
  });
});
