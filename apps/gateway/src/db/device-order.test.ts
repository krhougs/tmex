import type { Device } from '@tmex/shared';
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import {
  createDevice,
  getAllDevices,
  getDeviceTreeOrder,
  reorderDevices,
  setPaneOrder,
  setWindowOrder,
} from './index';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function makeDevice(id: string, name: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('device sort order', () => {
  test('createDevice 递增 sortOrder，reorderDevices 改变相对顺序', () => {
    const ids = ['ord-a', 'ord-b', 'ord-c'];
    for (const [i, id] of ids.entries()) {
      createDevice(makeDevice(id, `dev-${i}`));
    }

    // 创建顺序即初始相对顺序
    const initial = getAllDevices()
      .filter((d) => ids.includes(d.id))
      .map((d) => d.id);
    expect(initial).toEqual(['ord-a', 'ord-b', 'ord-c']);

    // 重排：c, a, b
    reorderDevices(['ord-c', 'ord-a', 'ord-b']);
    const reordered = getAllDevices()
      .filter((d) => ids.includes(d.id))
      .map((d) => d.id);
    expect(reordered).toEqual(['ord-c', 'ord-a', 'ord-b']);
  });
});

describe('device tree order', () => {
  const deviceId = 'tree-dev';

  test('默认空，setWindowOrder / setPaneOrder 持久化', () => {
    createDevice(makeDevice(deviceId, 'tree'));

    expect(getDeviceTreeOrder(deviceId)).toEqual({ deviceId, windows: [], panes: {} });

    setWindowOrder(deviceId, ['@2', '@0', '@1']);
    expect(getDeviceTreeOrder(deviceId).windows).toEqual(['@2', '@0', '@1']);

    setPaneOrder(deviceId, '@0', ['%1', '%0']);
    const order = getDeviceTreeOrder(deviceId);
    expect(order.windows).toEqual(['@2', '@0', '@1']); // window 顺序不被 pane 写入覆盖
    expect(order.panes).toEqual({ '@0': ['%1', '%0'] });

    // 再写另一个 window 的 panes，合并而非覆盖
    setPaneOrder(deviceId, '@1', ['%3', '%2']);
    expect(getDeviceTreeOrder(deviceId).panes).toEqual({
      '@0': ['%1', '%0'],
      '@1': ['%3', '%2'],
    });
  });
});
