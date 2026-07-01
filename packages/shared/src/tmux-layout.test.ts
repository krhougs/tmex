import { describe, expect, test } from 'bun:test';
import {
  collectLayoutLeaves,
  layoutLeafPaneId,
  parseWindowLayout,
} from './tmux-layout';

// 以下样本均由真实 tmux 生成（tmux -L … display-message '#{window_layout}'）

describe('parseWindowLayout', () => {
  test('单叶 window', () => {
    const parsed = parseWindowLayout('ba9d,208x62,0,0,0');
    expect(parsed).not.toBeNull();
    expect(parsed?.checksum).toBe('ba9d');
    expect(parsed?.root).toEqual({
      type: 'leaf',
      paneNumId: 0,
      width: 208,
      height: 62,
      x: 0,
      y: 0,
    });
  });

  test('水平两 pane（{} = row）', () => {
    const parsed = parseWindowLayout('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}');
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    expect(root?.type).toBe('row');
    if (root?.type !== 'row') {
      return;
    }
    expect(root.width).toBe(208);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toEqual({
      type: 'leaf',
      paneNumId: 0,
      width: 104,
      height: 62,
      x: 0,
      y: 0,
    });
    expect(root.children[1]).toEqual({
      type: 'leaf',
      paneNumId: 1,
      width: 103,
      height: 62,
      x: 105,
      y: 0,
    });
  });

  test('嵌套 {[]}：右侧再垂直分割', () => {
    const parsed = parseWindowLayout(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}',
    );
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    if (root?.type !== 'row') {
      throw new Error('expected row root');
    }
    expect(root.children).toHaveLength(2);
    const right = root.children[1];
    if (right?.type !== 'column') {
      throw new Error('expected column child');
    }
    expect(right.x).toBe(105);
    expect(right.children).toHaveLength(2);
    expect(right.children[0]).toMatchObject({ type: 'leaf', paneNumId: 1, y: 0, height: 31 });
    expect(right.children[1]).toMatchObject({ type: 'leaf', paneNumId: 2, y: 32, height: 30 });
  });

  test('even-horizontal 三 pane', () => {
    const parsed = parseWindowLayout(
      '8419,208x62,0,0{68x62,0,0,0,68x62,69,0,1,70x62,138,0,2}',
    );
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    if (root?.type !== 'row') {
      throw new Error('expected row root');
    }
    expect(root.children).toHaveLength(3);
    expect(root.children.map((c) => (c.type === 'leaf' ? c.paneNumId : -1))).toEqual([0, 1, 2]);
  });

  test('大 pane 编号映射回 %id', () => {
    const parsed = parseWindowLayout('ba9d,208x62,0,0,42');
    const leaves = parsed ? collectLayoutLeaves(parsed.root) : [];
    expect(leaves).toHaveLength(1);
    expect(layoutLeafPaneId(leaves[0] as (typeof leaves)[0])).toBe('%42');
  });

  test('collectLayoutLeaves 按视觉顺序返回', () => {
    const parsed = parseWindowLayout(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}',
    );
    const leaves = parsed ? collectLayoutLeaves(parsed.root) : [];
    expect(leaves.map((l) => l.paneNumId)).toEqual([0, 1, 2]);
  });

  describe('畸形输入返回 null', () => {
    const cases: [string, string][] = [
      ['空串', ''],
      ['缺 checksum', '208x62,0,0,0'],
      ['checksum 非 hex', 'zzzz,208x62,0,0,0'],
      ['checksum 长度错', 'ba9,208x62,0,0,0'],
      ['缺 pane id', 'ba9d,208x62,0,0'],
      ['尺寸缺 x', 'ba9d,20862,0,0,0'],
      ['括号不闭合', '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1'],
      ['括号不匹配', '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1]'],
      ['split 只有一个子节点', '7d1d,208x62,0,0{104x62,0,0,0}'],
      ['尾部有多余内容', 'ba9d,208x62,0,0,0garbage'],
      ['非数字字段', 'ba9d,ax62,0,0,0'],
    ];
    for (const [name, input] of cases) {
      test(name, () => {
        expect(parseWindowLayout(input)).toBeNull();
      });
    }
  });
});
