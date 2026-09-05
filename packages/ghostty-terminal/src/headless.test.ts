import { describe, expect, test } from 'bun:test';
import { getGhosttyBindings } from './ghostty-wasm';
import { HeadlessTerminal } from './headless';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readScrollbackRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
describe('HeadlessTerminal', () => {
  test('默认闪烁配置保留显式常亮、隐藏及重置光标协议', async () => {
    const bindings = await getGhosttyBindings();
    const handle = bindings.createTerminal(20, 5, 100);
    const state = createRenderState(bindings);
    const cursor = () => {
      updateRenderState(state, handle);
      return readRenderSnapshotMeta(state).cursor;
    };
    try {
      bindings.setDefaultCursorBlink(handle, true);
      expect(cursor().blinking).toBe(true);
      bindings.writeVt(handle, '\x1b[2 q');
      expect(cursor().blinking).toBe(false);
      bindings.writeVt(handle, '\x1b[0 q');
      expect(cursor().blinking).toBe(true);
      bindings.writeVt(handle, '\x1b[?25l');
      expect(cursor().visible).toBe(false);
      bindings.resetTerminal(handle);
      expect(cursor().visible).toBe(true);
      expect(cursor().blinking).toBe(true);
    } finally {
      disposeRenderStateResources(state);
      bindings.freeTerminal(handle);
    }
  });

  test('读取滚动预绘制行时跨视口保持连续，且不改变当前视口和后续输出', async () => {
    const bindings = await getGhosttyBindings();
    const handle = bindings.createTerminal(20, 5, 100);
    const state = createRenderState(bindings);
    try {
      bindings.writeVt(handle, Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\r\n'));
      bindings.scrollViewportTop(handle);
      bindings.scrollViewportDelta(handle, 12);
      const original = bindings.readScrollbar(handle);
      for (const [start, count] of [[7, 5], [17, 6], [27, 5]] as const) {
        const rows = readScrollbackRows(state, handle, start, count);
        expect(rows.map((row) => row.text.trimEnd())).toEqual(
          Array.from({ length: Math.min(count, 30 - start) }, (_, i) => `row ${start + i}`)
        );
        expect(bindings.readScrollbar(handle)).toEqual(original);
        expect([...iterateRows(state)][0]?.text.trimEnd()).toBe('row 12');
      }
      bindings.writeVt(handle, '\r\nrow 30');
      bindings.scrollViewportBottom(handle);
      updateRenderState(state, handle);
      expect([...iterateRows(state)].at(-1)?.text.trimEnd()).toBe('row 30');
    } finally {
      disposeRenderStateResources(state);
      bindings.freeTerminal(handle);
    }
  });

  test('渲染态纯文本：剥 ANSI 颜色与控制序列', async () => {
    const term = await HeadlessTerminal.create({ cols: 80, rows: 24 });
    term.write('hello world\r\n');
    term.write('\x1b[31mRED\x1b[0m then \x1b[1mBOLD\x1b[0m\r\n');
    const text = term.render();
    expect(text).toContain('hello world');
    expect(text).toContain('RED then BOLD');
    expect(text).not.toContain('\x1b');
    term.free();
  });

  test('光标定位/重绘后取渲染态（覆盖式写入）', async () => {
    const term = await HeadlessTerminal.create({ cols: 20, rows: 5 });
    term.write('AAAAA');
    term.write('\r'); // 回到行首
    term.write('BB'); // 覆盖前两格
    expect(term.render()).toContain('BBAAA');
    term.free();
  });

  test('alternate screen 检测', async () => {
    const term = await HeadlessTerminal.create({ cols: 40, rows: 10 });
    expect(term.isAlternateScreen()).toBe(false);
    term.write('\x1b[?1049h'); // 进入 alt 屏
    expect(term.isAlternateScreen()).toBe(true);
    term.write('\x1b[?1049l'); // 退出
    expect(term.isAlternateScreen()).toBe(false);
    term.free();
  });

  // 渲染层依赖 wasm 对 DECSET 2026 的状态跟踪来挂起同步输出期间的渲染；
  // 该模式一旦在 ghostty 升级中丢失，门控会静默失效，钉住此协议前提。
  test('synchronized output (DECSET 2026) 状态被跟踪', async () => {
    const term = await HeadlessTerminal.create({ cols: 40, rows: 10 });
    const bindings = (term as any).bindings;
    const handle = (term as any).terminal;
    expect(bindings.isTerminalModeEnabled(handle, 2026)).toBe(false);
    term.write('\x1b[?2026h');
    expect(bindings.isTerminalModeEnabled(handle, 2026)).toBe(true);
    term.write('\x1b[?2026l');
    expect(bindings.isTerminalModeEnabled(handle, 2026)).toBe(false);
    term.free();
  });

  test('size / resize', async () => {
    const term = await HeadlessTerminal.create({ cols: 80, rows: 24 });
    expect(term.size()).toEqual({ cols: 80, rows: 24 });
    term.resize(100, 30);
    expect(term.size()).toEqual({ cols: 100, rows: 30 });
    term.free();
  });

  test('canonical snapshot 中的背景空白 cell 保留完整行高', async () => {
    const term = await HeadlessTerminal.create({ cols: 20, rows: 8, scrollback: 0 });
    const bindings = (
      term as unknown as { bindings: Awaited<ReturnType<typeof getGhosttyBindings>> }
    ).bindings;
    const handle = (term as unknown as { terminal: number }).terminal;
    const renderState = createRenderState(bindings);
    const grayRow = `\x1b[0;48;5;240m${' '.repeat(20)}`;
    term.write(`\x1b[2J\x1b[H\x1b[0m\x1b[H${grayRow}\r\n${grayRow}\r\n${grayRow}\x1b[0m`);

    try {
      updateRenderState(renderState, handle);
      const rows = [...iterateRows(renderState)];
      for (let row = 0; row < 3; row += 1) {
        expect(rows[row]?.cells).toHaveLength(20);
        expect(rows[row]?.cells.every((cell) => cell.bgPaletteIndex === 240)).toBe(true);
      }
      expect(rows[3]?.cells.every((cell) => cell.bgPaletteIndex === null)).toBe(true);
    } finally {
      disposeRenderStateResources(renderState);
      term.free();
    }
  });

  test('free 幂等且 free 后 render 抛错', async () => {
    const term = await HeadlessTerminal.create({ cols: 10, rows: 3 });
    term.free();
    term.free();
    expect(term.disposed).toBe(true);
    expect(() => term.render()).toThrow(/freed/);
  });

  // gateway canonical 快照 data 尾部追加键盘协议恢复序列（见 tmex gateway
  // keyboard mode tracker）；引擎 reset() 后重放快照必须还原编码器模式状态，
  // 否则冷启动/切换终端后 kitty 协议程序（如 Codex TUI）的按键编码退化。
  test('快照恢复序列还原键盘协议编码状态', async () => {
    const bindings = await getGhosttyBindings();
    const term = await HeadlessTerminal.create({ cols: 80, rows: 24 });
    const encoder = bindings.createKeyEncoder();
    // HeadlessTerminal.terminal 是私有 wasm 句柄；测试需要直接喂编码器。
    const handle = (term as unknown as { terminal: number }).terminal;
    const KEY_ENTER = 58;
    const KEY_UP = 78;
    const SHIFT = 1 << 0;

    try {
      // 基线：reset 后默认 legacy —— 方向键 CSI A、Shift-Enter 走 ghostty
      // 的组合键兜底（27;2;13~，无 modifyOtherKeys/KKP）
      expect(
        bindings.encodeKeyEvent(encoder, handle, {
          action: 'press',
          keyCode: KEY_UP,
          mods: 0,
          composing: false,
        })
      ).toBe('\x1b[A');
      expect(
        bindings.encodeKeyEvent(encoder, handle, {
          action: 'press',
          keyCode: KEY_ENTER,
          mods: SHIFT,
          composing: false,
        })
      ).toBe('\x1b[27;2;13~');

      // Codex 形态快照：kitty flags=7 + modifyOtherKeys=2 + DECCKM
      term.write('\x1b[2J\x1b[Hhello\x1b[1;1H\x1b[=7u\x1b[>4;2m\x1b[?1h');
      // 方向键：disambiguate + DECCKM → CSI 1;1:1A（kitty 编码带 event type）
      expect(
        bindings.encodeKeyEvent(encoder, handle, {
          action: 'press',
          keyCode: KEY_UP,
          mods: 0,
          composing: false,
        })
      ).toBe('\x1b[1;1:1A');
      // Shift-Enter：disambiguate → CSI 13;2u（Codex 可识别换行）
      expect(
        bindings.encodeKeyEvent(encoder, handle, {
          action: 'press',
          keyCode: KEY_ENTER,
          mods: SHIFT,
          composing: false,
        })
      ).toBe('\x1b[13;2u');
    } finally {
      bindings.freeKeyEncoder(encoder);
      term.free();
    }
  });
});
