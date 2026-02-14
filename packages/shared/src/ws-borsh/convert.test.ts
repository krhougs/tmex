// WebSocket Borsh 转换层单元测试

import { describe, expect, it } from 'bun:test';
import type { EventDevicePayload, EventTmuxPayload, StateSnapshotPayload } from '../index';
import {
  decodeDeviceEventPayload,
  decodeStateSnapshot,
  decodeTmuxEventPayload,
  encodeDeviceEventPayload,
  encodeStateSnapshot,
  encodeTmuxEventPayload,
} from './convert';

describe('convert', () => {
  describe('DeviceEvent', () => {
    it('应该正确编解码 device error 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'error',
        errorType: 'connection_failed',
        message: 'Connection failed',
        rawMessage: 'Raw error message',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe(payload.type);
      expect(decoded.errorType).toBe(payload.errorType);
      expect(decoded.message).toBe(payload.message);
      expect(decoded.rawMessage).toBe(payload.rawMessage);
    });

    it('应该正确编解码 device disconnected 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'disconnected',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('disconnected');
    });

    it('应该正确编解码 device reconnected 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'reconnected',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('reconnected');
    });
  });

  describe('TmuxEvent', () => {
    it('应该正确编解码 window-add 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'window-add',
        data: { windowId: '@1' },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('window-add');
      expect(decoded.data).toEqual({ windowId: '@1' });
    });

    it('应该正确编解码 window-renamed 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'window-renamed',
        data: { windowId: '@1', name: 'new-name' },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('window-renamed');
      expect(decoded.data).toEqual({ windowId: '@1', name: 'new-name' });
    });

    it('应该正确编解码 pane-active 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'pane-active',
        data: { windowId: '@1', paneId: '%2' },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('pane-active');
      expect(decoded.data).toEqual({ windowId: '@1', paneId: '%2' });
    });

    it('应该正确编解码 bell 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'bell',
        data: {
          windowId: '@1',
          paneId: '%2',
          windowIndex: 1,
          paneIndex: 2,
          paneUrl: 'https://example.com',
        },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('bell');
      expect(decoded.data).toEqual({
        windowId: '@1',
        paneId: '%2',
        windowIndex: 1,
        paneIndex: 2,
        paneUrl: 'https://example.com',
      });
    });

    it('应该正确编解码 layout-change 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'layout-change',
        data: { windowId: '@1', layout: 'c3d5,210x56,0,0,5' },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('layout-change');
      expect(decoded.data).toEqual({ windowId: '@1', layout: 'c3d5,210x56,0,0,5' });
    });

    it('应该处理 output 事件', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'output',
        data: {},
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('output');
    });
  });

  describe('StateSnapshot', () => {
    it('应该正确编解码 StateSnapshot', () => {
      const payload: StateSnapshotPayload = {
        deviceId: 'device-1',
        session: {
          id: '$0',
          name: 'main',
          windows: [
            {
              id: '@1',
              name: 'window-1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  title: 'bash',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      };

      const encoded = encodeStateSnapshot(payload);
      const decoded = decodeStateSnapshot(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.session).not.toBeNull();
      if (decoded.session) {
        expect(decoded.session.id).toBe('$0');
        expect(decoded.session.name).toBe('main');
        expect(decoded.session.windows).toHaveLength(1);
        expect(decoded.session.windows[0].id).toBe('@1');
        expect(decoded.session.windows[0].panes).toHaveLength(1);
        expect(decoded.session.windows[0].panes[0].id).toBe('%1');
        expect(decoded.session.windows[0].panes[0].title).toBe('bash');
      }
    });

    it('应该正确处理空 session', () => {
      const payload: StateSnapshotPayload = {
        deviceId: 'device-1',
        session: null,
      };

      const encoded = encodeStateSnapshot(payload);
      const decoded = decodeStateSnapshot(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.session).toBeNull();
    });

    it('应该正确处理不含 title 的 pane', () => {
      const payload: StateSnapshotPayload = {
        deviceId: 'device-1',
        session: {
          id: '$0',
          name: 'main',
          windows: [
            {
              id: '@1',
              name: 'window-1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      };

      const encoded = encodeStateSnapshot(payload);
      const decoded = decodeStateSnapshot(encoded);

      expect(decoded.session).not.toBeNull();
      if (decoded.session) {
        expect(decoded.session.windows[0].panes[0].title).toBeUndefined();
      }
    });
  });
});
