export interface WsBorshEnvelope {
  version: number;
  kind: number;
  flags: number;
  seq: number;
  payload: Buffer;
}

export const KIND = {
  HELLO_C2S: 0x0001,
  HELLO_S2C: 0x0002,
  PING: 0x0003,
  PONG: 0x0004,
  ERROR: 0x0005,

  DEVICE_CONNECT: 0x0101,
  DEVICE_CONNECTED: 0x0102,
  DEVICE_DISCONNECT: 0x0103,
  DEVICE_DISCONNECTED: 0x0104,
  DEVICE_EVENT: 0x0105,

  TMUX_SELECT: 0x0201,
  TMUX_EVENT: 0x0207,
  STATE_SNAPSHOT: 0x0208,

  TERM_INPUT: 0x0301,
  TERM_PASTE: 0x0302,
  TERM_RESIZE: 0x0303,
  TERM_SYNC_SIZE: 0x0304,
  TERM_OUTPUT: 0x0305,
  TERM_HISTORY: 0x0306,

  SWITCH_ACK: 0x0401,
  LIVE_RESUME: 0x0402,

  CHUNK: 0x0501,
} as const;

function isMagicTX(data: Buffer): boolean {
  return data.length >= 2 && data[0] === 0x54 && data[1] === 0x58;
}

export function decodeEnvelope(payload: string | Buffer): WsBorshEnvelope | null {
  if (typeof payload === 'string') return null;
  if (!isMagicTX(payload)) return null;
  if (payload.length < 16) return null;

  const version = payload.readUInt16LE(2);
  const kind = payload.readUInt16LE(4);
  const flags = payload.readUInt16LE(6);
  const seq = payload.readUInt32LE(8);
  const payloadLen = payload.readUInt32LE(12);
  const payloadStart = 16;
  const payloadEnd = payloadStart + payloadLen;
  if (payloadEnd > payload.length) return null;

  return {
    version,
    kind,
    flags,
    seq,
    payload: payload.subarray(payloadStart, payloadEnd),
  };
}

class BorshCursor {
  private buf: Buffer;
  offset = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new Error('Borsh decode overflow');
    }
  }

  readU8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readU16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readFixedBytes(length: number): Buffer {
    this.ensure(length);
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readVecBytes(): Buffer {
    const len = this.readU32();
    return this.readFixedBytes(len);
  }

  readString(): string {
    const bytes = this.readVecBytes();
    return bytes.toString('utf8');
  }

  readOptionString(): string | null {
    const disc = this.readU8();
    if (disc === 0) return null;
    return this.readString();
  }

  readOptionU16(): number | null {
    const disc = this.readU8();
    if (disc === 0) return null;
    return this.readU16();
  }
}

export interface TermInputPayload {
  deviceId: string;
  paneId: string;
  encoding: number;
  data: Buffer;
  isComposing: boolean;
}

export function decodeTermInput(payload: Buffer): TermInputPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const encoding = c.readU8();
  const data = c.readVecBytes();
  const isComposing = c.readBool();
  return { deviceId, paneId, encoding, data, isComposing };
}

export interface TmuxSelectPayload {
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  selectToken: Buffer;
  wantHistory: boolean;
  cols: number | null;
  rows: number | null;
}

export function decodeTmuxSelect(payload: Buffer): TmuxSelectPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const windowId = c.readOptionString();
  const paneId = c.readOptionString();
  const selectToken = c.readFixedBytes(16);
  const wantHistory = c.readBool();
  const cols = c.readOptionU16();
  const rows = c.readOptionU16();
  return { deviceId, windowId, paneId, selectToken, wantHistory, cols, rows };
}

export interface SwitchAckPayload {
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Buffer;
}

export function decodeSwitchAck(payload: Buffer): SwitchAckPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const windowId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  return { deviceId, windowId, paneId, selectToken };
}

export interface LiveResumePayload {
  deviceId: string;
  paneId: string;
  selectToken: Buffer;
}

export function decodeLiveResume(payload: Buffer): LiveResumePayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  return { deviceId, paneId, selectToken };
}

export interface TermHistoryPayload {
  deviceId: string;
  paneId: string;
  selectToken: Buffer;
  encoding: number;
  data: Buffer;
}

export function decodeTermHistory(payload: Buffer): TermHistoryPayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const selectToken = c.readFixedBytes(16);
  const encoding = c.readU8();
  const data = c.readVecBytes();
  return { deviceId, paneId, selectToken, encoding, data };
}

export interface TermResizePayload {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
}

export function decodeTermResize(payload: Buffer): TermResizePayload {
  const c = new BorshCursor(payload);
  const deviceId = c.readString();
  const paneId = c.readString();
  const cols = c.readU16();
  const rows = c.readU16();
  return { deviceId, paneId, cols, rows };
}

