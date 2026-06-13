import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { ReactNode } from 'react';

export type TerminalTheme = 'light' | 'dark';

export interface TerminalProps {
  deviceId: string;
  paneId: string;
  theme: TerminalTheme;
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onData?: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  /** 拼接在终端容器最下方的内容（如快捷键栏），会占据终端可视区域下方的空间 */
  children?: ReactNode;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => CompatibleTerminalLike | null;
  getSize: () => { cols: number; rows: number } | null;
  runPostSelectResize: () => void;
  scheduleResize: (
    kind: 'resize' | 'sync',
    options?: { immediate?: boolean; force?: boolean }
  ) => void;
  /**
   * 基于容器 DOM 尺寸计算行列数
   * 返回根据容器实际尺寸计算出的 cols/rows，而不是当前 xterm 实例的尺寸
   */
  calculateSizeFromContainer: () => { cols: number; rows: number } | null;
  getPendingLocalSize: () => { cols: number; rows: number; at: number } | null;
}
