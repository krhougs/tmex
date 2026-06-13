// Headless 终端：在 Node/Bun 服务端复用 ghostty-vt.wasm 维护 per-pane 渲染网格，
// 喂字节流后取渲染态纯文本。无 DOM/Canvas 依赖（只用 GhosttyBindings）。
// wasm 实例（getGhosttyBindings）全局单例；每个 HeadlessTerminal 持一个终端句柄，
// 必须 free() 释放（WASM 线性内存只增不减，靠 bounded scrollback + 显式 free 控制）。

import {
  GHOSTTY_FORMATTER_FORMAT_PLAIN,
  type GhosttyBindings,
  getGhosttyBindings,
} from './ghostty-wasm';

// alternate screen 的 DEC 私有模式（1049=切换+存光标，1047/47=旧式）
const ALTERNATE_SCREEN_MODES = [1049, 1047, 47];

export interface HeadlessTerminalOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

export class HeadlessTerminal {
  private terminal: number;
  private cols: number;
  private rows: number;

  private constructor(
    private readonly bindings: GhosttyBindings,
    terminal: number,
    cols: number,
    rows: number
  ) {
    this.terminal = terminal;
    this.cols = cols;
    this.rows = rows;
  }

  static async create(options: HeadlessTerminalOptions): Promise<HeadlessTerminal> {
    const bindings = await getGhosttyBindings();
    const cols = Math.max(1, Math.floor(options.cols));
    const rows = Math.max(1, Math.floor(options.rows));
    const terminal = bindings.createTerminal(cols, rows, options.scrollback ?? 5000);
    return new HeadlessTerminal(bindings, terminal, cols, rows);
  }

  write(data: Uint8Array | string): void {
    this.ensureAlive();
    this.bindings.writeVt(this.terminal, data);
  }

  /** 当前可见屏的渲染态纯文本（去 ANSI、按网格折行）。 */
  render(): string {
    this.ensureAlive();
    return this.bindings.formatViewport(
      this.terminal,
      GHOSTTY_FORMATTER_FORMAT_PLAIN,
      { trim: true, unwrap: false, includePalette: false },
      { cols: this.cols, rows: this.rows }
    );
  }

  isAlternateScreen(): boolean {
    this.ensureAlive();
    for (const mode of ALTERNATE_SCREEN_MODES) {
      try {
        if (this.bindings.isTerminalModeEnabled(this.terminal, mode)) {
          return true;
        }
      } catch {
        // 该模式号不被支持则忽略
      }
    }
    return false;
  }

  size(): { cols: number; rows: number } {
    this.ensureAlive();
    return this.bindings.readTerminalSize(this.terminal);
  }

  resize(cols: number, rows: number): void {
    this.ensureAlive();
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    this.bindings.resizeTerminal(this.terminal, safeCols, safeRows, { width: 8, height: 16 });
    this.cols = safeCols;
    this.rows = safeRows;
  }

  free(): void {
    if (this.terminal !== 0) {
      this.bindings.freeTerminal(this.terminal);
      this.terminal = 0;
    }
  }

  get disposed(): boolean {
    return this.terminal === 0;
  }

  private ensureAlive(): void {
    if (this.terminal === 0) {
      throw new Error('HeadlessTerminal already freed');
    }
  }
}
