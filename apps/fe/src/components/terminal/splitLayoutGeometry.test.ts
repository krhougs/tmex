import { describe, expect, test } from 'bun:test';
import { parseWindowLayout } from '@tmex/shared';
import {
  computeSplitLayoutGeometry,
  maxVerticalStackDepth,
  resolveDropPosition,
  resolveGutterDrag,
} from './splitLayoutGeometry';

const CELL = { width: 10, height: 20 };

function geometryOf(layout: string) {
  const parsed = parseWindowLayout(layout);
  if (!parsed) {
    throw new Error(`invalid layout: ${layout}`);
  }
  return computeSplitLayoutGeometry(parsed.root, CELL);
}

describe('computeSplitLayoutGeometry', () => {
  test('single pane: one rect, no gutters', () => {
    const geo = geometryOf('ba9d,208x62,0,0,0');
    expect(geo.panes).toEqual([
      {
        paneId: '%0',
        cols: 208,
        rows: 62,
        rect: { left: 0, top: 0, width: 2080, height: 1240 },
      },
    ]);
    expect(geo.gutters).toEqual([]);
  });

  test('two panes side-by-side: vertical gutter in the 1-cell gap', () => {
    const geo = geometryOf('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}');
    expect(geo.panes.map((p) => p.paneId)).toEqual(['%0', '%1']);
    expect(geo.panes[1]?.rect.left).toBe(105 * CELL.width);

    expect(geo.gutters).toHaveLength(1);
    const gutter = geo.gutters[0];
    expect(gutter).toMatchObject({
      axis: 'x',
      edgeLeafPaneId: '%0',
      edgeLeafSizeCells: 104,
      minDeltaCells: -(104 - 2),
      maxDeltaCells: 103 - 2,
    });
    expect(gutter?.rect).toEqual({
      left: 104 * CELL.width,
      top: 0,
      width: CELL.width,
      height: 62 * CELL.height,
    });
  });

  test('nested column on the right: horizontal gutter inside, resize target is edge leaf', () => {
    const geo = geometryOf(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}'
    );
    expect(geo.panes.map((p) => p.paneId)).toEqual(['%0', '%1', '%2']);
    expect(geo.gutters).toHaveLength(2);

    const vertical = geo.gutters.find((g) => g.axis === 'x');
    // 右侧是 column，其左右边界叶子取第一个 child（都是全宽）
    expect(vertical?.edgeLeafPaneId).toBe('%0');
    // before(%0) 可缩到 2，after(column) 的最小宽度是 max(2,2)=2
    expect(vertical?.maxDeltaCells).toBe(103 - 2);

    const horizontal = geo.gutters.find((g) => g.axis === 'y');
    expect(horizontal).toMatchObject({
      edgeLeafPaneId: '%1',
      edgeLeafSizeCells: 31,
      minDeltaCells: -(31 - 2),
      maxDeltaCells: 30 - 2,
    });
    expect(horizontal?.rect.top).toBe(31 * CELL.height);
    expect(horizontal?.rect.left).toBe(105 * CELL.width);
  });

  test('row inside column: vertical gutter target is rightmost leaf of nested row', () => {
    // column[ row{a=0, b=1}, c=2 ]，row 内 gutter 的 edge leaf 是 a（row 的第一段的右边界）
    const geo = geometryOf('abcd,100x50,0,0[100x24,0,0{49x24,0,0,0,50x24,50,0,1},100x25,0,25,2]');
    const vertical = geo.gutters.find((g) => g.axis === 'x');
    expect(vertical?.edgeLeafPaneId).toBe('%0');
    const horizontal = geo.gutters.find((g) => g.axis === 'y');
    // row 的底边叶子取第一个 child
    expect(horizontal?.edgeLeafPaneId).toBe('%0');
    // before 是 row{a,b}，最小高度 = max(2,2) = 2
    expect(horizontal?.minDeltaCells).toBe(-(24 - 2));
    // before 是 row，最小宽度 = 2+2+1 = 5（信息在 vertical gutter 上）
    expect(vertical?.minDeltaCells).toBe(-(49 - 2));
  });
});

describe('maxVerticalStackDepth', () => {
  const rootOf = (layout: string) => {
    const parsed = parseWindowLayout(layout);
    if (!parsed) throw new Error('bad layout');
    return parsed.root;
  };

  test('single pane = 1', () => {
    expect(maxVerticalStackDepth(rootOf('ba9d,208x62,0,0,0'))).toBe(1);
  });

  test('side-by-side row = 1', () => {
    expect(maxVerticalStackDepth(rootOf('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}'))).toBe(1);
  });

  test('row with nested column takes the deepest branch', () => {
    expect(
      maxVerticalStackDepth(
        rootOf('5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}')
      )
    ).toBe(2);
  });

  test('column of row+leaf accumulates', () => {
    expect(
      maxVerticalStackDepth(
        rootOf('abcd,100x50,0,0[100x24,0,0{49x24,0,0,0,50x24,50,0,1},100x25,0,25,2]')
      )
    ).toBe(2);
  });
});

describe('resolveDropPosition', () => {
  test('nearest edge wins', () => {
    expect(resolveDropPosition(0.1, 0.5)).toBe('left');
    expect(resolveDropPosition(0.9, 0.5)).toBe('right');
    expect(resolveDropPosition(0.5, 0.1)).toBe('top');
    expect(resolveDropPosition(0.5, 0.9)).toBe('bottom');
  });

  test('clamps out-of-range input', () => {
    expect(resolveDropPosition(-0.5, 0.5)).toBe('left');
    expect(resolveDropPosition(1.5, 0.5)).toBe('right');
  });
});

describe('resolveGutterDrag', () => {
  const gutter = {
    axis: 'x' as const,
    rect: { left: 0, top: 0, width: 10, height: 100 },
    edgeLeafPaneId: '%0',
    edgeLeafSizeCells: 104,
    minDeltaCells: -102,
    maxDeltaCells: 101,
  };

  test('rounds px to cells and returns absolute target size', () => {
    expect(resolveGutterDrag(gutter, 47, CELL)).toEqual({ deltaCells: 5, targetSizeCells: 109 });
    expect(resolveGutterDrag(gutter, -33, CELL)).toEqual({ deltaCells: -3, targetSizeCells: 101 });
  });

  test('clamps to min/max delta', () => {
    expect(resolveGutterDrag(gutter, 100000, CELL)).toEqual({
      deltaCells: 101,
      targetSizeCells: 205,
    });
    expect(resolveGutterDrag(gutter, -100000, CELL)).toEqual({
      deltaCells: -102,
      targetSizeCells: 2,
    });
  });

  test('sub-cell drag returns null', () => {
    expect(resolveGutterDrag(gutter, 4, CELL)).toBeNull();
    expect(resolveGutterDrag(gutter, 0, CELL)).toBeNull();
  });

  test('y axis uses cell height', () => {
    const hGutter = { ...gutter, axis: 'y' as const, edgeLeafSizeCells: 31 };
    expect(resolveGutterDrag(hGutter, 41, CELL)).toEqual({ deltaCells: 2, targetSizeCells: 33 });
  });
});
