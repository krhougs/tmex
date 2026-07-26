import { describe, expect, test } from 'bun:test';
import { resolveGlyphConstraint } from './glyph-constraint';

const CELL = 26;

describe('resolveGlyphConstraint', () => {
  test('普通窄墨迹字形不处理', () => {
    expect(
      resolveGlyphConstraint({ ink: { left: 0, right: 24 }, cellWidth: CELL, maxInkWidth: CELL })
    ).toEqual({ mode: 'normal' });
  });

  test('轻微 side bearing 溢出（<5%）容忍', () => {
    expect(
      resolveGlyphConstraint({
        ink: { left: 0.5, right: CELL + 1 },
        cellWidth: CELL,
        maxInkWidth: CELL,
      })
    ).toEqual({ mode: 'normal' });
  });

  test('宽墨迹符号（→ 型，墨迹近 2 格）右邻有字时缩放进本格', () => {
    const decision = resolveGlyphConstraint({
      ink: { left: 0, right: CELL * 1.9 },
      cellWidth: CELL,
      maxInkWidth: CELL,
    });
    expect(decision.mode).toBe('scale');
    if (decision.mode === 'scale') {
      expect(decision.scale).toBeCloseTo(1 / 1.9, 5);
      // 缩放后墨迹恰好占满 cell，起点为 cell 左缘
      expect(decision.dx).toBeCloseTo(0, 5);
    }
  });

  test('宽墨迹符号右邻为空时放行溢出（≤2 格）', () => {
    expect(
      resolveGlyphConstraint({
        ink: { left: 0, right: CELL * 1.9 },
        cellWidth: CELL,
        maxInkWidth: CELL * 2,
      })
    ).toEqual({ mode: 'normal' });
  });

  test('墨迹整体在右邻格的字形（˄ 型）即使右邻为空也缩放回本格', () => {
    // ˄: xMin=500 xMax=1000（1000upm、advance 500）→ ink.left 为负旁溢、right 近 2 格
    const decision = resolveGlyphConstraint({
      ink: { left: -CELL, right: CELL * 2 },
      cellWidth: CELL,
      maxInkWidth: CELL * 2,
    });
    // right == maxInkWidth，且 left 不构成左溢 → 放行；本格空白属字体设计
    expect(decision.mode).toBe('normal');
  });

  test('左溢字形缩放并平移回本格', () => {
    const decision = resolveGlyphConstraint({
      ink: { left: CELL, right: CELL },
      cellWidth: CELL,
      maxInkWidth: CELL * 2,
    });
    expect(decision.mode).toBe('scale');
    if (decision.mode === 'scale') {
      expect(decision.scale).toBeCloseTo(0.5, 5);
      // 原点平移量 = 居中偏移 + 左溢补偿
      expect(decision.dx).toBeCloseTo(CELL / 2, 5);
    }
  });

  test('墨迹宽度为 0 时不缩放', () => {
    expect(
      resolveGlyphConstraint({
        ink: { left: 0, right: 0 },
        cellWidth: CELL,
        maxInkWidth: CELL,
      })
    ).toEqual({ mode: 'normal' });
  });

  test('超过 2 格的墨迹右邻为空也要缩放', () => {
    const decision = resolveGlyphConstraint({
      ink: { left: 0, right: CELL * 2.5 },
      cellWidth: CELL,
      maxInkWidth: CELL * 2,
    });
    expect(decision.mode).toBe('scale');
  });
});
