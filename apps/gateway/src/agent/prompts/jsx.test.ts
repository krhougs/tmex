import { describe, expect, test } from 'bun:test';
import { Doc, Item, Section } from './components';
import { Fragment, blocks, cat, flattenNodes, h, lines } from './jsx';

describe('prompt jsx 运行时', () => {
  test('flattenNodes 拍平嵌套并过滤空值', () => {
    expect(flattenNodes(['a', ['b', ['c']], null, undefined, false, true, '', 'd'])).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  test('数字转字符串保留', () => {
    expect(flattenNodes([0, 1, 80])).toEqual(['0', '1', '80']);
  });

  test('cat / lines / blocks 分隔语义', () => {
    expect(cat(['a', 'b', 'c'])).toBe('abc');
    expect(lines(['a', 'b', 'c'])).toBe('a\nb\nc');
    expect(blocks(['a', 'b', 'c'])).toBe('a\n\nb\n\nc');
  });

  test('h 调用函数组件并传入 children 数组', () => {
    const Join = ({ children }: { children: unknown }) =>
      flattenNodes(children as never).join('|');
    expect(h(Join, null, 'x', 'y')).toBe('x|y');
  });

  test('h 对 Fragment / 字符串标签透明拼接', () => {
    expect(h(Fragment, null, 'a', 'b')).toBe('ab');
    expect(h('any', null, 'a', 'b')).toBe('ab');
  });
});

describe('prompt jsx 基础组件', () => {
  test('Section 标题 + 逐行正文', () => {
    expect(h(Section, { title: 'Rules:' }, h(Item, null, 'first'), h(Item, null, 'second'))).toBe(
      'Rules:\n- first\n- second'
    );
  });

  test('Section 无标题', () => {
    expect(h(Section, null, h(Item, null, 'only'))).toBe('- only');
  });

  test('Doc 段落空行分隔，条件子节点被过滤', () => {
    const include = false;
    const out = h(
      Doc,
      null,
      h(Section, { title: 'A' }, h(Item, null, 'a1')),
      include && h(Section, { title: 'SKIP' }, h(Item, null, 'x')),
      h(Section, { title: 'B' }, h(Item, null, 'b1'))
    );
    expect(out).toBe('A\n- a1\n\nB\n- b1');
  });

  test('Item 内联拼接多个子节点', () => {
    expect(h(Item, null, 'cols=', 80)).toBe('- cols=80');
  });
});
