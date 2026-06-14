import { describe, expect, test } from 'bun:test';
import { detectLinksInLine, detectLinksInWrappedLines } from './link-detector';
import { type SelectionLineModel, lineModelFromText } from './selection-model';

function model(colChars: (string | null)[], wrappedToNext = false): SelectionLineModel {
  let contentCols = 0;
  for (let i = colChars.length - 1; i >= 0; i -= 1) {
    const ch = colChars[i];
    if (ch !== null && ch !== '' && ch !== ' ') {
      contentCols = i + 1;
      break;
    }
  }
  return { colChars, contentCols, wrappedToNext };
}

describe('detectLinksInLine', () => {
  test('识别行内 https 链接并定位列区间', () => {
    const line = lineModelFromText('see https://example.com now');
    const links = detectLinksInLine(line);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com');
    expect(links[0].startCol).toBe(4); // 's'=0..'see '=4
    expect(links[0].endCol).toBe(4 + 'https://example.com'.length - 1);
  });

  test('识别 http 与带路径/查询串的链接', () => {
    const line = lineModelFromText('http://a.io/p?x=1&y=2#f');
    const links = detectLinksInLine(line);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('http://a.io/p?x=1&y=2#f');
    expect(links[0].startCol).toBe(0);
  });

  test('裁剪 URL 末尾句读', () => {
    const line = lineModelFromText('go https://example.com.');
    const [link] = detectLinksInLine(line);
    expect(link.url).toBe('https://example.com');
  });

  test('一行多个链接', () => {
    const line = lineModelFromText('https://a.com https://b.com');
    const links = detectLinksInLine(line);
    expect(links.map((l) => l.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  test('无链接返回空数组', () => {
    expect(detectLinksInLine(lineModelFromText('just plain text, no url'))).toEqual([]);
    expect(detectLinksInLine(lineModelFromText('ftp://nope.com /etc/hosts'))).toEqual([]);
  });

  test('宽字符在前时列区间仍正确（spacer-tail 占列）', () => {
    // '你' 占两列：主列 + spacer-tail(null)，随后是 URL
    const colChars: (string | null)[] = ['你', null, ...Array.from('https://x.io')];
    const [link] = detectLinksInLine(model(colChars));
    expect(link.url).toBe('https://x.io');
    expect(link.startCol).toBe(2); // 宽字符占 0、1 两列，URL 从第 2 列开始
  });
});

describe('detectLinksInWrappedLines', () => {
  test('跨软换行的链接被识别并按物理行切段', () => {
    // 第一行软换行到第二行，URL 被换行边界切断
    const first = model(Array.from('go https://example.com/very'), true);
    const second = model(Array.from('/long/path?a=1'), false);
    const links = detectLinksInWrappedLines([first, second]);
    expect(links.length).toBe(2);
    expect(links[0].url).toBe('https://example.com/very/long/path?a=1');
    expect(links[1].url).toBe('https://example.com/very/long/path?a=1');
    expect(links[0].lineIndex).toBe(0);
    expect(links[1].lineIndex).toBe(1);
    expect(links[0].startCol).toBe(3); // 'go ' 之后
    expect(links[1].startCol).toBe(0); // 第二行从行首开始
  });

  test('单行情形与 detectLinksInLine 等价', () => {
    const only = lineModelFromText('x https://a.com y');
    const wrapped = detectLinksInWrappedLines([only]);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].lineIndex).toBe(0);
    expect(wrapped[0].url).toBe('https://a.com');
  });
});
