import { describe, expect, test } from 'bun:test';
import { getGhosttyBindings } from './ghostty-wasm';
import { parseHistoryRows } from './history-prepend';

// 与 gateway 页数据一致：每行以 '\n' 结尾（parseHistoryRows 写的是已归一化字节，
// 归一化会吃掉页尾换行，但解析本身对尾随 '\n' 同样正确——屏幕填充 trim 掉）。
const encodePage = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseHistoryRows', () => {
  test('SGR 颜色/样式保留，行数与 y 重映射正确', async () => {
    const bindings = await getGhosttyBindings();
    const rows = parseHistoryRows(
      bindings,
      encodePage('plain\r\n\x1b[31mred\x1b[0m\r\n\x1b[1mbold\x1b[0m'),
      20
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.y)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.dirty)).toBe(true);
    expect(rows[0].text.trim()).toBe('plain');
    expect(rows[0].cells[0].fgColor).toBeNull();
    expect(rows[1].text.trim()).toBe('red');
    expect(rows[1].cells[0].fgColor).toEqual({ r: 204, g: 102, b: 102 });
    expect(rows[2].text.trim()).toBe('bold');
    expect(rows[2].cells[0].style.bold).toBe(true);
  });

  test('CJK 宽字保留 widthKind=wide 与文本', async () => {
    const bindings = await getGhosttyBindings();
    const rows = parseHistoryRows(bindings, encodePage('中文宽字测试'), 20);
    expect(rows).toHaveLength(1);
    const wideCells = rows[0].cells.filter((cell) => cell.widthKind === 'wide');
    expect(wideCells.length).toBe(6);
    expect(rows[0].text.trim()).toBe('中文宽字测试');
  });

  test('折行：单逻辑行超过 cols 产生 wrap 行且延续行标记正确', async () => {
    const bindings = await getGhosttyBindings();
    const rows = parseHistoryRows(bindings, encodePage('0123456789abcdefghijklmnopqrstuvwxyz'), 20);
    expect(rows).toHaveLength(2);
    expect(rows[0].text.trim()).toBe('0123456789abcdefghij');
    expect(rows[0].wrap).toBe(true);
    expect(rows[1].text.trim()).toBe('klmnopqrstuvwxyz');
    expect(rows[1].wrapContinuation).toBe(true);
  });

  test('超一屏的页逐屏读取无重复无遗漏', async () => {
    const bindings = await getGhosttyBindings();
    const lines = Array.from({ length: 60 }, (_, index) => `row-${index}`);
    const rows = parseHistoryRows(bindings, encodePage(lines.join('\r\n')), 20);
    expect(rows).toHaveLength(60);
    expect(rows[0].text.trim()).toBe('row-0');
    expect(rows[59].text.trim()).toBe('row-59');
    expect(new Set(rows.map((row) => row.text.trim())).size).toBe(60);
    expect(rows.every((row) => row.y === rows.indexOf(row))).toBe(true);
  });

  test('尾部空行（屏幕填充）trim，中间空行保留', async () => {
    const bindings = await getGhosttyBindings();
    const rows = parseHistoryRows(bindings, encodePage('a\r\n\r\nb\r\n'), 20);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.text.trim())).toEqual(['a', '', 'b']);
  });

  test('空字节产出空行数组', async () => {
    const bindings = await getGhosttyBindings();
    expect(parseHistoryRows(bindings, new Uint8Array(), 20)).toEqual([]);
  });
});
