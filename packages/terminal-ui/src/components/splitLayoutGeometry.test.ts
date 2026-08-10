import { describe, expect, test } from 'bun:test';
import { parseWindowLayout } from '@tmex/shared';
import {
  computeSplitLayoutGeometry,
  computeSplitLayoutPxGeometry,
  computeSplitWindowGridSize,
  maxHorizontalStackDepth,
  maxVerticalStackDepth,
  paneSizesKey,
  resolveDropPosition,
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
    expect(vertical?.edgeLeafPaneId).toBe('%0');

    const horizontal = geo.gutters.find((g) => g.axis === 'y');
    expect(horizontal?.edgeLeafPaneId).toBe('%1');
    expect(horizontal?.rect.top).toBe(31 * CELL.height);
    expect(horizontal?.rect.left).toBe(105 * CELL.width);
  });

  test('row inside column: vertical gutter target is rightmost leaf of nested row', () => {
    const geo = geometryOf('abcd,100x50,0,0[100x24,0,0{49x24,0,0,0,50x24,50,0,1},100x25,0,25,2]');
    const vertical = geo.gutters.find((g) => g.axis === 'x');
    expect(vertical?.edgeLeafPaneId).toBe('%0');
    const horizontal = geo.gutters.find((g) => g.axis === 'y');
    expect(horizontal?.edgeLeafPaneId).toBe('%0');
  });
});

// 恒等映射：1 cell 恒等于 1 cellPx，不缩放、不按份额分摊；
// 余量归每级最后一个子节点的盒子，主轴越界顺序截断
describe('computeSplitLayoutPxGeometry', () => {
  const CHROME = { width: 12, height: 46 };
  const pxGeometryOf = (layout: string, viewport: { width: number; height: number }) => {
    const parsed = parseWindowLayout(layout);
    if (!parsed) throw new Error(`invalid layout: ${layout}`);
    return computeSplitLayoutPxGeometry(parsed.root, {
      viewport,
      cell: CELL,
      paneChrome: CHROME,
    });
  };

  test('unequal vertical split: bottom pane still fits its rows plus chrome', () => {
    // 39 行 + 1 gutter + 10 行 = 50；精确适配视口下逐 pane 恰好放下
    const layout = 'aaaa,100x50,0,0[100x39,0,0,1,100x10,0,40,2]';
    const viewport = { width: 100 * 10 + 12, height: 50 * 20 + 2 * 46 };
    const geo = pxGeometryOf(layout, viewport);

    expect(geo.panes.map((p) => p.paneId)).toEqual(['%1', '%2']);
    expect(geo.panes[0]?.rect).toEqual({ left: 0, top: 0, width: 1012, height: 826 });
    expect(geo.gutters[0]?.rect).toEqual({ left: 0, top: 826, width: 1012, height: 20 });
    expect(geo.panes[1]?.rect).toEqual({ left: 0, top: 846, width: 1012, height: 246 });
    for (const pane of geo.panes) {
      expect(pane.rect.height - CHROME.height).toBeGreaterThanOrEqual(pane.rows * CELL.height);
    }
  });

  test('surplus pixels go to the tail pane only, others keep exact needs', () => {
    const layout = 'aaaa,100x50,0,0[100x39,0,0,1,100x10,0,40,2]';
    const viewport = { width: 1012, height: 50 * 20 + 2 * 46 + 49 };
    const geo = pxGeometryOf(layout, viewport);

    expect(geo.panes[0]?.rect.height).toBe(826);
    expect(geo.panes[1]?.rect.height).toBe(246 + 49);
    const bottom = geo.panes[1];
    if (!bottom) throw new Error('missing bottom pane');
    expect(bottom.rect.top + bottom.rect.height).toBe(viewport.height);
    for (const pane of geo.panes) {
      expect(pane.rect.height - CHROME.height).toBeGreaterThanOrEqual(pane.rows * CELL.height);
    }
  });

  test('undersized viewport truncates tail panes, leading panes keep their needs', () => {
    const layout = 'aaaa,100x50,0,0[100x39,0,0,1,100x10,0,40,2]';
    const viewport = { width: 1012, height: 700 };
    const geo = pxGeometryOf(layout, viewport);

    expect(geo.panes[0]?.rect).toEqual({ left: 0, top: 0, width: 1012, height: 700 });
    expect(geo.panes[1]?.rect.height).toBe(0);
    expect(geo.gutters).toHaveLength(0);
  });

  test('row with nested column: every leaf meets its minimum, shallow branch keeps slack', () => {
    const layout = '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}';
    const viewport = { width: 208 * 10 + 2 * 12, height: 62 * 20 + 2 * 46 };
    const geo = pxGeometryOf(layout, viewport);

    const left = geo.panes.find((p) => p.paneId === '%0');
    expect(left?.rect).toEqual({ left: 0, top: 0, width: 1052, height: 1332 });

    const vertical = geo.gutters.find((g) => g.axis === 'x');
    expect(vertical?.rect).toEqual({ left: 1052, top: 0, width: 10, height: 1332 });

    const topRight = geo.panes.find((p) => p.paneId === '%1');
    const bottomRight = geo.panes.find((p) => p.paneId === '%2');
    expect(topRight?.rect).toEqual({ left: 1062, top: 0, width: 1042, height: 666 });
    expect(bottomRight?.rect).toEqual({ left: 1062, top: 686, width: 1042, height: 646 });
    for (const pane of geo.panes) {
      expect(pane.rect.width - CHROME.width).toBeGreaterThanOrEqual(pane.cols * CELL.width);
      expect(pane.rect.height - CHROME.height).toBeGreaterThanOrEqual(pane.rows * CELL.height);
    }
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

describe('maxHorizontalStackDepth', () => {
  const rootOf = (layout: string) => {
    const parsed = parseWindowLayout(layout);
    if (!parsed) throw new Error('bad layout');
    return parsed.root;
  };

  test('single pane = 1', () => {
    expect(maxHorizontalStackDepth(rootOf('ba9d,208x62,0,0,0'))).toBe(1);
  });

  test('side-by-side row accumulates', () => {
    expect(maxHorizontalStackDepth(rootOf('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}'))).toBe(2);
  });

  test('row with nested column: column takes max of children', () => {
    expect(
      maxHorizontalStackDepth(
        rootOf('5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}')
      )
    ).toBe(2);
  });

  test('column of row+leaf takes the widest branch', () => {
    expect(
      maxHorizontalStackDepth(
        rootOf('abcd,100x50,0,0[100x24,0,0{49x24,0,0,0,50x24,50,0,1},100x25,0,25,2]')
      )
    ).toBe(2);
  });
});

describe('computeSplitWindowGridSize', () => {
  const rootOf = (layout: string) => {
    const parsed = parseWindowLayout(layout);
    if (!parsed) throw new Error('bad layout');
    return parsed.root;
  };

  test('mixed row/column layout deducts chrome for the deepest vertical stack', () => {
    const root = rootOf(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}'
    );

    expect(
      computeSplitWindowGridSize(root, {
        viewport: { width: 1200, height: 506 },
        cell: { width: 10, height: 10 },
        paneChrome: { width: 12, height: 46 },
      })
    ).toEqual({ cols: 117, rows: 41 });
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

// Bug 1: pane 尺寸签名用于 SplitTerminalArea geometry effect 稳定化
describe('paneSizesKey', () => {
  test('same pane sizes produce same key even with different geometry references', () => {
    const layout = '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}';
    const geo1 = geometryOf(layout);
    const geo2 = geometryOf(layout);

    expect(geo1).not.toBe(geo2);
    expect(paneSizesKey(geo1)).toBe(paneSizesKey(geo2));
  });

  test('different pane sizes produce different keys', () => {
    const geo1 = geometryOf('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}');
    const geo2 = geometryOf('7d1d,208x62,0,0{105x62,0,0,0,102x62,106,0,1}');

    expect(paneSizesKey(geo1)).not.toBe(paneSizesKey(geo2));
  });

  test('null geometry produces empty key', () => {
    expect(paneSizesKey(null)).toBe('');
  });
});
