import type { StateSnapshotPayload } from '@tmex/shared';

// device tree 显示顺序 overlay 的输入：window/pane 的自定义有序 id
export interface DeviceTreeOrderInput {
  windows: string[];
  panes: Record<string, string[]>;
}

// 按保存的顺序重排 items：仍存在的 saved id 保序在前，未在 saved 中的 live item 按原顺序追加在后；
// saved 中已不存在的 stale id 自动忽略（即清理）。纯函数、无副作用。
function orderBySaved<T>(items: T[], getId: (item: T) => string, savedIds: string[]): T[] {
  if (savedIds.length === 0) return items;
  const byId = new Map(items.map((item) => [getId(item), item] as const));
  const used = new Set<string>();
  const result: T[] = [];
  for (const id of savedIds) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      result.push(item);
      used.add(id);
    }
  }
  for (const item of items) {
    if (!used.has(getId(item))) result.push(item);
  }
  return result;
}

// 在快照下发前应用自定义显示顺序：先重排 windows，再重排每个 window 的 panes。
// 不触碰 tmux 真实布局，不写库；stale id 在此被忽略，未知 id 退回 tmux index 顺序。
export function applyDeviceTreeOverlay(
  payload: StateSnapshotPayload,
  order: DeviceTreeOrderInput
): StateSnapshotPayload {
  if (!payload.session) return payload;

  const hasWindowOrder = order.windows.length > 0;
  const hasPaneOrder = Object.keys(order.panes).length > 0;
  if (!hasWindowOrder && !hasPaneOrder) return payload;

  const orderedWindows = orderBySaved(payload.session.windows, (w) => w.id, order.windows).map(
    (window) => {
      const savedPaneOrder = order.panes[window.id];
      if (!savedPaneOrder || savedPaneOrder.length === 0) return window;
      return { ...window, panes: orderBySaved(window.panes, (p) => p.id, savedPaneOrder) };
    }
  );

  return {
    ...payload,
    session: { ...payload.session, windows: orderedWindows },
  };
}
