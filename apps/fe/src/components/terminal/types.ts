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
  onReady?: (terminal: XTermTerminal) => void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => XTermTerminal | null;
  runPostSelectResize: () => void;
  scheduleResize: (kind: 'resize' | 'sync', options?: { immediate?: boolean; force?: boolean }) => void;
}
