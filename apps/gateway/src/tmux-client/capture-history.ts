// capture-pane 输出只有屏幕文本，不含光标位置：回放后前端光标停在最后写入字符之后
// （受 -N 保留的行尾空白和可见区域尾部空行影响），与 tmux pane 的真实光标不一致。
// 依赖相对光标移动做增量重绘的 TUI（如 Ink/Claude Code）会因起点错位而整体错乱，
// 普通终端则表现为光标偏移到行尾空白之后。因此 capture 时一并读取光标位置，
// 把恢复序列拼接到 history 末尾，使回放结束时前端光标与 tmux 一致。

export interface PaneScreenInfo {
  alternateScreen: boolean;
  cursorX: number | null;
  cursorY: number | null;
  paneHeight: number | null;
}

export const PANE_SCREEN_INFO_FORMAT = '#{alternate_on} #{cursor_x} #{cursor_y} #{pane_height}';

export function parsePaneScreenInfo(stdout: string): PaneScreenInfo {
  const parts = stdout.trim().split(/\s+/);
  const toInt = (value: string | undefined): number | null => {
    if (value === undefined) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) || parsed < 0 ? null : parsed;
  };

  return {
    alternateScreen: parts[0] === '1',
    cursorX: toInt(parts[1]),
    cursorY: toInt(parts[2]),
    paneHeight: toInt(parts[3]),
  };
}

export function appendCursorRestore(history: string, info: PaneScreenInfo): string {
  const { cursorX, cursorY, paneHeight } = info;
  if (cursorX === null || cursorY === null || paneHeight === null || paneHeight < 1) {
    return history;
  }

  // capture-pane 输出以换行结尾；去掉它，保证回放写完后光标停在最后一行（可见区域底行），
  // 作为下面相对移动的已知起点。前端 normalizeHistoryForTerminal 对不以 \n 结尾的数据不再裁剪。
  const trimmed = history.endsWith('\n') ? history.slice(0, -1) : history;

  if (info.alternateScreen) {
    // alt 屏无滚动缓冲，前端回放前会清屏并从顶部写起，可用绝对定位
    return `${trimmed}\x1b[${cursorY + 1};${cursorX + 1}H`;
  }

  // 主屏带滚动缓冲，绝对行号不可靠；capture 末行即可见区域底行，从底行相对上移到光标行
  const up = Math.min(Math.max(0, paneHeight - 1 - cursorY), paneHeight - 1);
  const moveUp = up > 0 ? `\x1b[${up}A` : '';
  return `${trimmed}${moveUp}\x1b[${cursorX + 1}G`;
}
