// 设备快照查询注册表：wsServer 持有各 device 的 lastSnapshot，
// 但 agent 等子系统无法直接引用 wsServer 实例（runtime 局部创建）。
// 仿 connectionAlertNotifier.setBroadcaster 的注册模式解耦。

import type { StateSnapshotPayload } from '@tmex/shared';

type SnapshotLookup = (deviceId: string) => StateSnapshotPayload | null;

let lookup: SnapshotLookup | null = null;

export function registerSnapshotLookup(fn: SnapshotLookup | null): void {
  lookup = fn;
}

export function getDeviceSnapshot(deviceId: string): StateSnapshotPayload | null {
  return lookup?.(deviceId) ?? null;
}
