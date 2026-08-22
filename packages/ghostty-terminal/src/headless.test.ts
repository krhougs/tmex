import { describe, expect, test } from 'bun:test';
import { getGhosttyBindings } from './ghostty-wasm';
import { HeadlessTerminal } from './headless';
describe('HeadlessTerminal', () => {
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
      expect(bindings.encodeKeyEvent(encoder, handle, { action: 'press', keyCode: KEY_UP, mods: 0, composing: false })).toBe('\x1b[A');
      expect(bindings.encodeKeyEvent(encoder, handle, { action: 'press', keyCode: KEY_ENTER, mods: SHIFT, composing: false })).toBe('\x1b[27;2;13~');

      // Codex 形态快照：kitty flags=7 + modifyOtherKeys=2 + DECCKM
      term.write('\x1b[2J\x1b[Hhello\x1b[1;1H\x1b[=7u\x1b[>4;2m\x1b[?1h');
      // 方向键：disambiguate + DECCKM → CSI 1;1:1A（kitty 编码带 event type）
      expect(bindings.encodeKeyEvent(encoder, handle, { action: 'press', keyCode: KEY_UP, mods: 0, composing: false })).toBe('\x1b[1;1:1A');
      // Shift-Enter：disambiguate → CSI 13;2u（Codex 可识别换行）
      expect(bindings.encodeKeyEvent(encoder, handle, { action: 'press', keyCode: KEY_ENTER, mods: SHIFT, composing: false })).toBe('\x1b[13;2u');
    } finally {
      bindings.freeKeyEncoder(encoder);
      term.free();
    }
  });
});
