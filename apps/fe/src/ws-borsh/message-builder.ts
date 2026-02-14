// FE Borsh 消息构建器
// 提供便捷的 API 构建各种消息

import { type b, wsBorsh } from '@tmex/shared';

// ========== 生成 selectToken ==========

export function generateSelectToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// ========== C2S 消息构建 ==========

export function buildDeviceConnect(deviceId: string): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, {
    deviceId,
  });
  return { kind: wsBorsh.KIND_DEVICE_CONNECT, payload };
}

export function buildDeviceDisconnect(deviceId: string): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectSchema, {
    deviceId,
  });
  return { kind: wsBorsh.KIND_DEVICE_DISCONNECT, payload };
}

export interface TmuxSelectParams {
  deviceId: string;
  windowId?: string;
  paneId?: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  cols?: number;
  rows?: number;
}

export function buildTmuxSelect(params: TmuxSelectParams): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectSchema, {
    deviceId: params.deviceId,
    windowId: params.windowId ?? null,
    paneId: params.paneId ?? null,
    selectToken: params.selectToken,
    wantHistory: params.wantHistory,
    cols: params.cols ?? null,
    rows: params.rows ?? null,
  });
  return { kind: wsBorsh.KIND_TMUX_SELECT, payload };
}

export function buildTmuxSelectWindow(
  deviceId: string,
  windowId: string
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectWindowSchema, {
    deviceId,
    windowId,
  });
  return { kind: wsBorsh.KIND_TMUX_SELECT_WINDOW, payload };
}

export function buildTmuxCreateWindow(
  deviceId: string,
  name?: string
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxCreateWindowSchema, {
    deviceId,
    name: name ?? null,
  });
  return { kind: wsBorsh.KIND_TMUX_CREATE_WINDOW, payload };
}

export function buildTmuxCloseWindow(
  deviceId: string,
  windowId: string
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxCloseWindowSchema, {
    deviceId,
    windowId,
  });
  return { kind: wsBorsh.KIND_TMUX_CLOSE_WINDOW, payload };
}

export function buildTmuxClosePane(
  deviceId: string,
  paneId: string
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxClosePaneSchema, {
    deviceId,
    paneId,
  });
  return { kind: wsBorsh.KIND_TMUX_CLOSE_PANE, payload };
}

export function buildTmuxRenameWindow(
  deviceId: string,
  windowId: string,
  name: string
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxRenameWindowSchema, {
    deviceId,
    windowId,
    name,
  });
  return { kind: wsBorsh.KIND_TMUX_RENAME_WINDOW, payload };
}

export function buildTermInput(
  deviceId: string,
  paneId: string,
  data: string,
  isComposing = false
): { kind: number; payload: Uint8Array } {
  const encoder = new TextEncoder();
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
    deviceId,
    paneId,
    encoding: 2, // utf8-bytes
    data: encoder.encode(data),
    isComposing,
  });
  return { kind: wsBorsh.KIND_TERM_INPUT, payload };
}

export function buildTermPaste(
  deviceId: string,
  paneId: string,
  data: string
): { kind: number; payload: Uint8Array } {
  const encoder = new TextEncoder();
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermPasteSchema, {
    deviceId,
    paneId,
    encoding: 2, // utf8-bytes
    data: encoder.encode(data),
    isComposing: false,
  });
  return { kind: wsBorsh.KIND_TERM_PASTE, payload };
}

export function buildTermResize(
  deviceId: string,
  paneId: string,
  cols: number,
  rows: number
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermResizeSchema, {
    deviceId,
    paneId,
    cols,
    rows,
  });
  return { kind: wsBorsh.KIND_TERM_RESIZE, payload };
}

export function buildTermSyncSize(
  deviceId: string,
  paneId: string,
  cols: number,
  rows: number
): { kind: number; payload: Uint8Array } {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermSyncSizeSchema, {
    deviceId,
    paneId,
    cols,
    rows,
  });
  return { kind: wsBorsh.KIND_TERM_SYNC_SIZE, payload };
}

// ========== S2C 消息解码 ==========

export function decodeDeviceConnected(payload: Uint8Array): { deviceId: string } {
  return wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, payload);
}

export function decodeDeviceDisconnected(payload: Uint8Array): { deviceId: string } {
  return wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectedSchema, payload);
}

export function decodeDeviceEvent(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.DeviceEventSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.DeviceEventSchema, payload);
}

export function decodeStateSnapshot(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.StateSnapshotSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.StateSnapshotSchema, payload);
}

export function decodeTmuxEvent(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.TmuxEventSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxEventSchema, payload);
}

export function decodeTermOutput(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.TermOutputSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, payload);
}

export function decodeTermHistory(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.TermHistorySchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payload);
}

export function decodeSwitchAck(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.SwitchAckSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, payload);
}

export function decodeLiveResume(
  payload: Uint8Array
): b.infer<typeof wsBorsh.schema.LiveResumeSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, payload);
}

export function decodeError(payload: Uint8Array): b.infer<typeof wsBorsh.schema.ErrorSchema> {
  return wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, payload);
}
