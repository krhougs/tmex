import { describe, expect, test } from 'bun:test';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import { TerminalSurface } from './TerminalSurface';

const EPOCH = new Uint8Array(16).fill(7);
const decoder = new TextDecoder();

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
