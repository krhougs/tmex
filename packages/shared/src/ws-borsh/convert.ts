// WebSocket Borsh 协议 wire <-> domain 转换层
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import type { b } from '@zorsh/zorsh';
import type {
  DeviceEventType,
  EventDevicePayload,
  EventTmuxPayload,
  StateSnapshotPayload,
  TmuxEventType,
  TmuxPane,
  TmuxSession,
  TmuxWindow,
} from '../index';
import * as schema from './schema';

// ========== Domain -> Wire 编码 ==========

export function encodeDeviceEventPayload(payload: EventDevicePayload): Uint8Array {
  const eventTypeMap: Record<DeviceEventType, number> = {
    'tmux-missing': 1,
    disconnected: 2,
    error: 3,
    reconnected: 4,
  };

  const wireData: b.infer<typeof schema.DeviceEventSchema> = {
    deviceId: payload.deviceId,
    eventType: eventTypeMap[payload.type],
    errorType: payload.errorType ?? null,
    message: payload.message ?? null,
    rawMessage: payload.rawMessage ?? null,
  };

  return schema.DeviceEventSchema.serialize(wireData);
}

export function encodeTmuxEventPayload(payload: EventTmuxPayload): Uint8Array {
  const eventTypeMap: Record<TmuxEventType, number> = {
    'window-add': 1,
    'window-close': 2,
    'window-renamed': 3,
    'window-active': 4,
    'pane-add': 5,
    'pane-close': 6,
    'pane-active': 7,
    'layout-change': 8,
    bell: 9,
    output: 10,
  };

  const eventData = encodeEventData(payload.type, payload.data);

  const wireData: b.infer<typeof schema.TmuxEventSchema> = {
    deviceId: payload.deviceId,
    eventType: eventTypeMap[payload.type],
    eventData,
  };

  return schema.TmuxEventSchema.serialize(wireData);
}

function encodeEventData(type: TmuxEventType, data: unknown): Uint8Array {
  switch (type) {
    case 'window-add': {
      const d = data as { windowId: string };
      return schema.WindowAddEventSchema.serialize({ windowId: d.windowId });
    }
    case 'window-close': {
      const d = data as { windowId: string };
      return schema.WindowCloseEventSchema.serialize({ windowId: d.windowId });
    }
    case 'window-renamed': {
      const d = data as { windowId: string; name: string };
      return schema.WindowRenamedEventSchema.serialize({
        windowId: d.windowId,
        name: d.name,
      });
    }
    case 'window-active': {
      const d = data as { windowId: string };
      return schema.WindowActiveEventSchema.serialize({ windowId: d.windowId });
    }
    case 'pane-add': {
      const d = data as { paneId: string; windowId: string };
      return schema.PaneAddEventSchema.serialize({
        paneId: d.paneId,
        windowId: d.windowId,
      });
    }
    case 'pane-close': {
      const d = data as { paneId: string };
      return schema.PaneCloseEventSchema.serialize({ paneId: d.paneId });
    }
    case 'pane-active': {
      const d = data as { windowId: string; paneId: string };
      return schema.PaneActiveEventSchema.serialize({
        windowId: d.windowId,
        paneId: d.paneId,
      });
    }
    case 'layout-change': {
      const d = data as { windowId: string; layout: string };
      return schema.LayoutChangeEventSchema.serialize({
        windowId: d.windowId,
        layout: d.layout,
      });
    }
    case 'bell': {
      const d = data as {
        windowId?: string;
        paneId?: string;
        windowIndex?: number;
        paneIndex?: number;
        paneUrl?: string;
      };
      return schema.BellEventSchema.serialize({
        windowId: d.windowId ?? null,
        paneId: d.paneId ?? null,
        windowIndex: d.windowIndex ?? null,
        paneIndex: d.paneIndex ?? null,
        paneUrl: d.paneUrl ?? null,
      });
    }
    case 'output':
      return new Uint8Array();
    default:
      return new Uint8Array();
  }
}

export function encodeStateSnapshot(payload: StateSnapshotPayload): Uint8Array {
  const wireData: b.infer<typeof schema.StateSnapshotSchema> = {
    deviceId: payload.deviceId,
    session: payload.session ? encodeSessionWire(payload.session) : null,
  };

  return schema.StateSnapshotSchema.serialize(wireData);
}

function encodeSessionWire(session: TmuxSession): b.infer<typeof schema.SessionWireSchema> {
  return {
    id: session.id,
    name: session.name,
    windows: session.windows.map(encodeWindowWire),
  };
}

function encodeWindowWire(window: TmuxWindow): b.infer<typeof schema.WindowWireSchema> {
  return {
    id: window.id,
    name: window.name,
    index: window.index,
    active: window.active,
    panes: window.panes.map(encodePaneWire),
  };
}

function encodePaneWire(pane: TmuxPane): b.infer<typeof schema.PaneWireSchema> {
  return {
    id: pane.id,
    windowId: pane.windowId,
    index: pane.index,
    title: pane.title ?? null,
    active: pane.active,
    width: pane.width,
    height: pane.height,
  };
}

// ========== Wire -> Domain 解码 ==========

export function decodeDeviceEventPayload(data: Uint8Array): EventDevicePayload {
  const wire = schema.DeviceEventSchema.deserialize(data);
  const eventTypeMap: Record<number, DeviceEventType> = {
    1: 'tmux-missing',
    2: 'disconnected',
    3: 'error',
    4: 'reconnected',
  };

  return {
    deviceId: wire.deviceId,
    type: eventTypeMap[wire.eventType] ?? 'error',
    errorType: wire.errorType ?? undefined,
    message: wire.message ?? undefined,
    rawMessage: wire.rawMessage ?? undefined,
  };
}

export function decodeTmuxEventPayload(data: Uint8Array): EventTmuxPayload {
  const wire = schema.TmuxEventSchema.deserialize(data);
  const eventTypeMap: Record<number, TmuxEventType> = {
    1: 'window-add',
    2: 'window-close',
    3: 'window-renamed',
    4: 'window-active',
    5: 'pane-add',
    6: 'pane-close',
    7: 'pane-active',
    8: 'layout-change',
    9: 'bell',
    10: 'output',
  };

  const type = eventTypeMap[wire.eventType] ?? 'output';

  return {
    deviceId: wire.deviceId,
    type,
    data: decodeEventData(type, wire.eventData),
  };
}

function decodeEventData(type: TmuxEventType, data: Uint8Array): unknown {
  if (data.length === 0) return {};

  try {
    switch (type) {
      case 'window-add':
        return schema.WindowAddEventSchema.deserialize(data);
      case 'window-close':
        return schema.WindowCloseEventSchema.deserialize(data);
      case 'window-renamed':
        return schema.WindowRenamedEventSchema.deserialize(data);
      case 'window-active':
        return schema.WindowActiveEventSchema.deserialize(data);
      case 'pane-add':
        return schema.PaneAddEventSchema.deserialize(data);
      case 'pane-close':
        return schema.PaneCloseEventSchema.deserialize(data);
      case 'pane-active':
        return schema.PaneActiveEventSchema.deserialize(data);
      case 'layout-change':
        return schema.LayoutChangeEventSchema.deserialize(data);
      case 'bell': {
        const bell = schema.BellEventSchema.deserialize(data);
        return {
          windowId: bell.windowId ?? undefined,
          paneId: bell.paneId ?? undefined,
          windowIndex: bell.windowIndex ?? undefined,
          paneIndex: bell.paneIndex ?? undefined,
          paneUrl: bell.paneUrl ?? undefined,
        };
      }
      default:
        return {};
    }
  } catch {
    return {};
  }
}

export function decodeStateSnapshot(data: Uint8Array): StateSnapshotPayload {
  const wire = schema.StateSnapshotSchema.deserialize(data);

  return {
    deviceId: wire.deviceId,
    session: wire.session ? decodeSessionWire(wire.session) : null,
  };
}

function decodeSessionWire(wire: b.infer<typeof schema.SessionWireSchema>): TmuxSession {
  return {
    id: wire.id,
    name: wire.name,
    windows: wire.windows.map(decodeWindowWire),
  };
}

function decodeWindowWire(wire: b.infer<typeof schema.WindowWireSchema>): TmuxWindow {
  return {
    id: wire.id,
    name: wire.name,
    index: wire.index,
    active: wire.active,
    panes: wire.panes.map(decodePaneWire),
  };
}

function decodePaneWire(wire: b.infer<typeof schema.PaneWireSchema>): TmuxPane {
  return {
    id: wire.id,
    windowId: wire.windowId,
    index: wire.index,
    title: wire.title ?? undefined,
    active: wire.active,
    width: wire.width,
    height: wire.height,
  };
}
