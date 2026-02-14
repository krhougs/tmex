import type { Terminal as XTermTerminal } from '@xterm/xterm';

export interface TerminalProps {
  deviceId: string;
  paneId: string;
  theme: 'light' | 'dark';
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onData?: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => XTermTerminal | null;
  getSize: () => { cols: number; rows: number } | null;
  runPostSelectResize: () => void;
  scheduleResize: (kind: 'resize' | 'sync', options?: { immediate?: boolean; force?: boolean }) => void;
  /**
   * 基于容器 DOM 尺寸计算行列数
   * 返回根据容器实际尺寸计算出的 cols/rows，而不是当前 xterm 实例的尺寸
   */
  calculateSizeFromContainer: () => { cols: number; rows: number } | null;
}
