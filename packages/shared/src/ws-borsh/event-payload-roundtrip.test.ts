import { describe, expect, test } from 'bun:test';
import { decodeTmuxEventPayload, encodeTmuxEventPayload } from './convert';
import * as schema from './schema';

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

  // 旧 gateway 的 payload 不含 paneCurrentPath 尾部字节：新客户端必须按 V1 回退解码,
  // 不得因越界丢掉整个事件。
  test('旧版(V1)payload 回退解码不丢字段', () => {
    const v1Bell = schema.TmuxEventSchema.serialize({
      deviceId: 'dev-1',
      eventType: 9,
      eventData: schema.BellEventSchemaV1.serialize({
        windowId: '@1',
        paneId: '%12',
        windowIndex: 0,
        paneIndex: 1,
        paneUrl: null,
        paneTitle: 'legacy',
        paneCurrentCommand: 'vim',
      }),
    });
    const bell = decodeTmuxEventPayload(v1Bell);
    expect(bell.type).toBe('bell');
    expect(bell.data).toMatchObject({ paneId: '%12', paneTitle: 'legacy' });

    const v1Notification = schema.TmuxEventSchema.serialize({
      deviceId: 'dev-1',
      eventType: 11,
      eventData: schema.NotificationEventSchemaV1.serialize({
        source: 1,
        title: 'legacy title',
        body: 'legacy body',
        windowId: null,
        paneId: '%12',
        windowIndex: null,
        paneIndex: null,
        paneUrl: null,
        paneTitle: null,
        paneCurrentCommand: null,
      }),
    });
    const notification = decodeTmuxEventPayload(v1Notification);
    expect(notification.data).toMatchObject({ title: 'legacy title', body: 'legacy body' });
  });
});
