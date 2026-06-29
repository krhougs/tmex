import type { Device } from '@tmex/shared';
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from './client';
import { createDevice, getDeviceById, updateDevice } from './index';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function makeDevice(id: string, name: string, defaultWorkingDir?: string): Device {
  const now = new Date().toISOString();
  return {
    id,
    name,
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    defaultWorkingDir,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('device defaultWorkingDir', () => {
  test('createDevice stores defaultWorkingDir and getDeviceById returns it', () => {
    createDevice(makeDevice('dwd-1', 'with-dir', '/custom/path'));
    const device = getDeviceById('dwd-1');
    expect(device).not.toBeNull();
    expect(device!.defaultWorkingDir).toBe('/custom/path');
  });

  test('createDevice without defaultWorkingDir stores NULL, returned as undefined', () => {
    createDevice(makeDevice('dwd-2', 'no-dir'));
    const device = getDeviceById('dwd-2');
    expect(device).not.toBeNull();
    expect(device!.defaultWorkingDir).toBeUndefined();
  });

  test('updateDevice sets defaultWorkingDir', () => {
    createDevice(makeDevice('dwd-3', 'update-dir'));
    updateDevice('dwd-3', { defaultWorkingDir: '/new/path' });
    const device = getDeviceById('dwd-3');
    expect(device!.defaultWorkingDir).toBe('/new/path');
  });

  test('updateDevice clears defaultWorkingDir with empty string', () => {
    createDevice(makeDevice('dwd-4', 'clear-dir', '/initial'));
    updateDevice('dwd-4', { defaultWorkingDir: '' });
    const device = getDeviceById('dwd-4');
    expect(device!.defaultWorkingDir).toBeUndefined();
  });
});
