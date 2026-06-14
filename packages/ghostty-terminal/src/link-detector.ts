import type { SelectionLineModel } from './selection-model';

// 终端文本里的 http/https 链接：URL 内部不含空白与这些定界符。
// 故意不含 ()[]{}，避免把紧跟 URL 的右括号/方括号吞进链接。
const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]{}]+/g;
// 紧贴 URL 末尾的句读不计入链接（如 "见 https://a.com。"）。
const TRAILING_PUNCT = /[.,;:!?]+$/;

export interface DetectedLink {
  /** 链接起始屏幕列（含） */
  startCol: number;
  /** 链接结束屏幕列（含） */
  endCol: number;
  url: string;
}

export interface WrappedLink {
  /** 该段所在物理行在传入 models 数组中的下标 */
  lineIndex: number;
  startCol: number;
  endCol: number;
  /** 完整 URL（跨行时各段共享同一值） */
  url: string;
}

interface LineText {
  text: string;
  /** colOf[i] = text 第 i 个 UTF-16 单元所属的屏幕列；长度与 text 一致 */
  colOf: number[];
}

// 把一行的 colChars 还原成可见文本，并记录每个 UTF-16 单元对应的屏幕列。
// spacer-tail(null) 与 spacer-head('') 不产生文本；宽字符/emoji 的多个单元共享主列。
function modelToText(model: SelectionLineModel): LineText {
  let text = '';
  const colOf: number[] = [];
  const limit = model.colChars.length;
  for (let col = 0; col < limit; col += 1) {
    const ch = model.colChars[col];
    if (ch === null || ch === '') {
      continue;
    }
    for (let unit = 0; unit < ch.length; unit += 1) {
      text += ch[unit];
      colOf.push(col);
    }
  }
  return { text, colOf };
}

/** 单行链接识别，按屏幕列返回（窄/宽字符均可） */
export function detectLinksInLine(model: SelectionLineModel): DetectedLink[] {
  const { text, colOf } = modelToText(model);
  const links: DetectedLink[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = URL_PATTERN.exec(text);
  while (match !== null) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    if (url.length > 0) {
      const startIdx = match.index;
      const endIdx = startIdx + url.length - 1;
      links.push({ startCol: colOf[startIdx], endCol: colOf[endIdx], url });
    }
    match = URL_PATTERN.exec(text);
  }
  return links;
}

/**
 * 跨软换行的链接识别：把 models 视作一条逻辑行直接拼接（软换行不插换行）后识别，
 * 再把每个链接按其跨越的物理行切成多段，映射回各自的列区间。
 */
export function detectLinksInWrappedLines(models: SelectionLineModel[]): WrappedLink[] {
  let text = '';
  const lineOf: number[] = [];
  const colOf: number[] = [];
  for (let i = 0; i < models.length; i += 1) {
    const piece = modelToText(models[i]);
    for (let k = 0; k < piece.text.length; k += 1) {
      text += piece.text[k];
      lineOf.push(i);
      colOf.push(piece.colOf[k]);
    }
  }

  const links: WrappedLink[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = URL_PATTERN.exec(text);
  while (match !== null) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    if (url.length > 0) {
      const start = match.index;
      const end = start + url.length - 1;
      let segStart = start;
      for (let i = start; i <= end; i += 1) {
        const lastOfLine = i === end || lineOf[i + 1] !== lineOf[i];
        if (lastOfLine) {
          links.push({
            lineIndex: lineOf[segStart],
            startCol: colOf[segStart],
            endCol: colOf[i],
            url,
          });
          segStart = i + 1;
        }
      }
    }
    match = URL_PATTERN.exec(text);
  }
  return links;
}
