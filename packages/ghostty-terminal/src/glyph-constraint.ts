/**
 * 符号字形宽度约束（对齐 ghostty 的 glyph constraint 思路）。
 *
 * Iosevka Term 系字体（如 Zed Mono）大量符号 advance 只有 1 格但墨迹近 2 格
 * （→ ⇒ — ※ 等），逐 cell 绘制时溢出右邻格造成文字重合；个别字形（˄ ˅）墨迹
 * 整体落在右邻格，本格空白 + 邻格重叠同时出现。ghostty 原生对 Sm/So 类符号
 * 用 `.fit`（等比只缩小）约束、右邻为空格时放行溢出到 2 格；此处等价复刻。
 */

type GlyphInk = {
  /** 墨迹向左超出绘制原点的量（actualBoundingBoxLeft，>0 表示左溢） */
  left: number;
  /** 墨迹右边界相对绘制原点的位置（actualBoundingBoxRight） */
  right: number;
};

type GlyphConstraintDecision = { mode: 'normal' } | { mode: 'scale'; scale: number; dx: number };

/** 墨迹超出 cell 不足 5% 时视为正常（普通字体的轻微 side bearing 溢出不处理）。 */
const OVERFLOW_TOLERANCE_RATIO = 0.05;

function resolveGlyphConstraint(args: {
  ink: GlyphInk;
  cellWidth: number;
  /** 允许墨迹自然延伸的最大宽度（右邻为空 cell 时为 2 格，否则 1 格） */
  maxInkWidth: number;
}): GlyphConstraintDecision {
  const { ink, cellWidth, maxInkWidth } = args;
  const tolerance = cellWidth * OVERFLOW_TOLERANCE_RATIO;

  const overflowLeft = ink.left > tolerance;
  const overflowRight = ink.right > maxInkWidth + tolerance;
  if (!overflowLeft && !overflowRight) {
    return { mode: 'normal' };
  }

  const inkWidth = ink.left + ink.right;
  if (inkWidth <= 0) {
    return { mode: 'normal' };
  }

  const scale = Math.min(1, cellWidth / inkWidth);
  // 缩放后墨迹在本 cell 内水平居中：fillText 原点 = cell 左缘 + dx
  const dx = (cellWidth - inkWidth * scale) / 2 + ink.left * scale;
  return { mode: 'scale', scale, dx };
}

export type { GlyphConstraintDecision, GlyphInk };
export { OVERFLOW_TOLERANCE_RATIO, resolveGlyphConstraint };
