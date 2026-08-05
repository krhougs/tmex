// 历史页离屏解析：把已归一化的页字节写入临时终端，读出全部行（含样式）后释放句柄。
// 翻页路径只做展示层前插（controller.prependHistoryRows），不再走 reset()+全量重放
// 重建终端；本模块产出 GhosttyRenderRow 同构对象，y 由调用方重映射。
// wasm 实例（getGhosttyBindings）全局单例；临时句柄 + render-state resources
// 必须显式释放（WASM 线性内存只增不减）。

import type { GhosttyBindings } from './ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  updateRenderState,
} from './render-state';
import type { GhosttyRenderRow } from './types';

// 临时终端行高：单页行数通常远小于此值，一屏读完；大页（> 此值）逐屏翻读。
const PARSE_TERMINAL_ROWS = 24;
// 临时终端 scrollback：足够容纳单页行数（页数据有字节上限，4096 行保守够用）。
const PARSE_SCROLLBACK = 4096;
// 翻屏读取兜底：正常时由「无新行 / 视口无法前进」自然终止，此值只在 wasm 行为
// 异常时兜底，防止死循环（每屏 24 行，1<<16 屏 ≈ 157 万行）。
const PARSE_SCREEN_LIMIT = 1 << 16;

/**
 * 离屏解析单页历史字节为渲染行。写入的是已归一化（CRLF）的页字节；返回行按
 * y = 0..n-1 排列（n = 页行数），尾部屏幕填充的空行已 trim。结果不可变，调用方
 * 不得修改行对象。
 */
export function parseHistoryRows(
  bindings: GhosttyBindings,
  bytes: Uint8Array,
  cols: number
): GhosttyRenderRow[] {
  const safeCols = Math.max(1, Math.floor(cols));
  const terminal = bindings.createTerminal(safeCols, PARSE_TERMINAL_ROWS, PARSE_SCROLLBACK);
  const renderState = createRenderState(bindings);
  try {
    bindings.writeVt(terminal, bytes);
    // readScrollbar 的 total = max(行数, rows)：尾部含屏幕填充的空行，读完统一 trim。
    const total = bindings.readScrollbar(terminal).total;
    bindings.scrollViewportTop(terminal);

    const rows: GhosttyRenderRow[] = [];
    let guard = 0;
    while (rows.length < total && guard++ < PARSE_SCREEN_LIMIT) {
      updateRenderState(renderState, terminal);
      const scrollbar = bindings.readScrollbar(terminal);
      for (const row of iterateRows(renderState)) {
        const absoluteIndex = scrollbar.offset + row.y;
        // 末屏与上一屏重叠：按绝对行号去重
        if (absoluteIndex < rows.length) {
          continue;
        }
        if (absoluteIndex >= total) {
          break;
        }
        rows.push(row);
      }
      if (scrollbar.offset + scrollbar.len >= total) {
        break; // 视口已贴底，剩余行都在视口内
      }
      const before = scrollbar.offset;
      bindings.scrollViewportDelta(terminal, scrollbar.len);
      if (bindings.readScrollbar(terminal).offset === before) {
        break; // 视口无法前进
      }
    }

    let end = rows.length;
    while (
      end > 0 &&
      (rows[end - 1].cells.length === 0 || rows[end - 1].cells.every((cell) => !cell.hasText))
    ) {
      end -= 1;
    }
    return rows.slice(0, end).map((row, index) => ({ ...row, y: index, dirty: true }));
  } finally {
    disposeRenderStateResources(renderState);
    bindings.freeTerminal(terminal);
  }
}
