import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import { describe, expect, it } from 'bun:test';
import { applyDeviceTreeOverlay } from './overlay-utils';

function pane(id: string, index: number): TmuxPane {
  return { id, windowId: '@0', index, active: false, width: 80, height: 24 };
}

function win(id: string, index: number, panes: TmuxPane[] = []): TmuxWindow {
  return { id, name: `w${index}`, index, active: false, panes };
}

function snapshot(windows: TmuxWindow[]): StateSnapshotPayload {
  return { deviceId: 'dev-1', session: { id: '$0', name: 'tmex', windows } };
}

describe('applyDeviceTreeOverlay', () => {
  it('无 order 时原样返回（同一引用）', () => {
    const payload = snapshot([win('@0', 0), win('@1', 1)]);
    const result = applyDeviceTreeOverlay(payload, { windows: [], panes: {} });
    expect(result).toBe(payload);
  });

  it('session 为 null 时原样返回', () => {
    const payload: StateSnapshotPayload = { deviceId: 'dev-1', session: null };
    expect(applyDeviceTreeOverlay(payload, { windows: ['@0'], panes: {} })).toBe(payload);
  });

  it('按保存顺序重排 windows', () => {
    const payload = snapshot([win('@0', 0), win('@1', 1), win('@2', 2)]);
    const result = applyDeviceTreeOverlay(payload, { windows: ['@2', '@0', '@1'], panes: {} });
    expect(result.session?.windows.map((w) => w.id)).toEqual(['@2', '@0', '@1']);
  });

  it('未知（新建）window 按原 tmux 顺序追加在后', () => {
    const payload = snapshot([win('@0', 0), win('@1', 1), win('@2', 2)]);
    // 保存顺序里只有 @2、@0，@1 是新窗口
    const result = applyDeviceTreeOverlay(payload, { windows: ['@2', '@0'], panes: {} });
    expect(result.session?.windows.map((w) => w.id)).toEqual(['@2', '@0', '@1']);
  });

  it('stale（已不存在）id 被忽略', () => {
    const payload = snapshot([win('@0', 0), win('@1', 1)]);
    const result = applyDeviceTreeOverlay(payload, {
      windows: ['@9', '@1', '@8', '@0'],
      panes: {},
    });
    expect(result.session?.windows.map((w) => w.id)).toEqual(['@1', '@0']);
  });

  it('重排某 window 内的 panes（二维）', () => {
    const payload = snapshot([
      win('@0', 0, [pane('%0', 0), pane('%1', 1), pane('%2', 2)]),
      win('@1', 1, [pane('%3', 0), pane('%4', 1)]),
    ]);
    const result = applyDeviceTreeOverlay(payload, {
      windows: [],
      panes: { '@0': ['%2', '%0', '%1'] },
    });
    const w0 = result.session?.windows.find((w) => w.id === '@0');
    const w1 = result.session?.windows.find((w) => w.id === '@1');
    expect(w0?.panes.map((p) => p.id)).toEqual(['%2', '%0', '%1']);
    // 未指定的 window panes 不受影响
    expect(w1?.panes.map((p) => p.id)).toEqual(['%3', '%4']);
  });

  it('同时重排 windows 与各自 panes', () => {
    const payload = snapshot([
      win('@0', 0, [pane('%0', 0), pane('%1', 1)]),
      win('@1', 1, [pane('%2', 0), pane('%3', 1)]),
    ]);
    const result = applyDeviceTreeOverlay(payload, {
      windows: ['@1', '@0'],
      panes: { '@1': ['%3', '%2'] },
    });
    expect(result.session?.windows.map((w) => w.id)).toEqual(['@1', '@0']);
    expect(result.session?.windows[0].panes.map((p) => p.id)).toEqual(['%3', '%2']);
  });
});
