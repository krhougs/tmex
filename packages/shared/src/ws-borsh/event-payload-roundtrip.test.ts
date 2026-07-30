import { describe, expect, test } from 'bun:test';
import { decodeTmuxEventPayload, encodeTmuxEventPayload } from './convert';

// bell / notification 事件线格 round-trip：schema 与 convert 双侧字段必须同步,
// 否则新增字段会在编解码中被静默丢弃(paneCurrentPath 回归)。
describe('tmux event payload round-trip', () => {
  test('bell 事件全字段保真', () => {
    const payload = {
      deviceId: 'dev-1',
      type: 'bell' as const,
      data: {
        windowId: '@1',
        paneId: '%12',
        windowIndex: 0,
        paneIndex: 1,
        paneUrl: 'https://tmex.example.com/devices/dev-1/windows/%401/panes/%2512',
        paneTitle: 'renamed',
        paneCurrentCommand: 'vim',
        paneCurrentPath: '/home/dev/project',
      },
    };
    expect(decodeTmuxEventPayload(encodeTmuxEventPayload(payload))).toEqual(payload);
  });

  test('notification 事件全字段保真(可选字段缺省不引入垃圾值)', () => {
    const payload = {
      deviceId: 'dev-1',
      type: 'notification' as const,
      data: {
        source: 'osc777' as const,
        title: '构建完成',
        body: 'all green',
        paneId: '%12',
        paneCurrentPath: '/tmp/build',
      },
    };
    const decoded = decodeTmuxEventPayload(encodeTmuxEventPayload(payload));
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.type).toBe('notification');
    expect(decoded.data).toMatchObject({
      source: 'osc777',
      title: '构建完成',
      body: 'all green',
      paneId: '%12',
      paneCurrentPath: '/tmp/build',
    });
  });
});
