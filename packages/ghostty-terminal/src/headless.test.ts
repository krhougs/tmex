import { describe, expect, test } from 'bun:test';
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
});
