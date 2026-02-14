// WebSocket Borsh 协议错误码定义
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

export const ERROR_UNSUPPORTED_PROTOCOL = 1001;
export const ERROR_INVALID_FRAME = 1002;
export const ERROR_UNKNOWN_KIND = 1003;
export const ERROR_PAYLOAD_DECODE_FAILED = 1004;
export const ERROR_FRAME_TOO_LARGE = 1005;
export const ERROR_DEVICE_NOT_FOUND = 1101;
export const ERROR_DEVICE_CONNECT_FAILED = 1102;
export const ERROR_TMUX_TARGET_NOT_FOUND = 1201;
export const ERROR_TMUX_NOT_READY = 1202;
export const ERROR_SELECT_CONFLICT = 1301;
export const ERROR_SELECT_TOKEN_MISMATCH = 1302;
export const ERROR_INTERNAL_ERROR = 1401;

export const ERROR_MESSAGES: Record<number, string> = {
  [ERROR_UNSUPPORTED_PROTOCOL]: 'Unsupported protocol version',
  [ERROR_INVALID_FRAME]: 'Invalid frame format',
  [ERROR_UNKNOWN_KIND]: 'Unknown message kind',
  [ERROR_PAYLOAD_DECODE_FAILED]: 'Failed to decode payload',
  [ERROR_FRAME_TOO_LARGE]: 'Frame exceeds maximum size',
  [ERROR_DEVICE_NOT_FOUND]: 'Device not found',
  [ERROR_DEVICE_CONNECT_FAILED]: 'Failed to connect device',
  [ERROR_TMUX_TARGET_NOT_FOUND]: 'Tmux target not found',
  [ERROR_TMUX_NOT_READY]: 'Tmux not ready',
  [ERROR_SELECT_CONFLICT]: 'Select conflict',
  [ERROR_SELECT_TOKEN_MISMATCH]: 'Select token mismatch',
  [ERROR_INTERNAL_ERROR]: 'Internal server error',
};

export function getErrorMessage(code: number): string {
  return ERROR_MESSAGES[code] ?? `Unknown error code: ${code}`;
}

export class WsBorshError extends Error {
  constructor(
    public readonly code: number,
    public readonly retryable: boolean = false,
    message?: string
  ) {
    super(message ?? getErrorMessage(code));
    this.name = 'WsBorshError';
  }
}
