// tmux layout 树 → 分屏渲染几何（纯函数）
//
// tmux layout 的坐标单位是 cell（cols/rows），相邻兄弟节点之间恰好空 1 cell
// （tmux pane border），该间隙即 splitter（gutter）的渲染与命中位置。
// px 换算统一为 cells × cellSize。

import type { TmuxLayoutNode } from '@tmex/shared';
import { layoutLeafPaneId } from '@tmex/shared';

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitPaneRect {
  paneId: string;
  rect: PxRect;
  cols: number;
  rows: number;
}

export interface SplitGutter {
  /** x：拖动垂直分隔条改变左右宽度；y：拖动水平分隔条改变上下高度 */
  axis: 'x' | 'y';
  rect: PxRect;
  /** resize-pane 的目标叶子：before 子树中触及本边界的叶子 */
  edgeLeafPaneId: string;
}

export interface SplitLayoutGeometry {
  panes: SplitPaneRect[];
  gutters: SplitGutter[];
}

// before 子树中右边界与子树右边界重合的叶子：
// resize-pane -x 移动它的右边界即移动整个子树与右侧兄弟的分界
function rightEdgeLeaf(node: TmuxLayoutNode): TmuxLayoutNode & { type: 'leaf' } {
  if (node.type === 'leaf') {
    return node;
  }
  if (node.type === 'row') {
    return rightEdgeLeaf(node.children[node.children.length - 1] as TmuxLayoutNode);
  }
  return rightEdgeLeaf(node.children[0] as TmuxLayoutNode);
}

function bottomEdgeLeaf(node: TmuxLayoutNode): TmuxLayoutNode & { type: 'leaf' } {
  if (node.type === 'leaf') {
    return node;
  }
  if (node.type === 'column') {
    return bottomEdgeLeaf(node.children[node.children.length - 1] as TmuxLayoutNode);
  }
  return bottomEdgeLeaf(node.children[0] as TmuxLayoutNode);
}

export function computeSplitLayoutGeometry(
  root: TmuxLayoutNode,
  cell: { width: number; height: number }
): SplitLayoutGeometry {
  const panes: SplitPaneRect[] = [];
  const gutters: SplitGutter[] = [];

  const visit = (node: TmuxLayoutNode): void => {
    if (node.type === 'leaf') {
      panes.push({
        paneId: layoutLeafPaneId(node),
        cols: node.width,
        rows: node.height,
        rect: {
          left: node.x * cell.width,
          top: node.y * cell.height,
          width: node.width * cell.width,
          height: node.height * cell.height,
        },
      });
      return;
    }

    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i] as TmuxLayoutNode;
      visit(child);

      if (i === node.children.length - 1) {
        continue;
      }

      if (node.type === 'row') {
        const edgeLeaf = rightEdgeLeaf(child);
        gutters.push({
          axis: 'x',
          rect: {
            left: (child.x + child.width) * cell.width,
            top: node.y * cell.height,
            width: cell.width,
            height: node.height * cell.height,
          },
          edgeLeafPaneId: layoutLeafPaneId(edgeLeaf),
        });
      } else {
        const edgeLeaf = bottomEdgeLeaf(child);
        gutters.push({
          axis: 'y',
          rect: {
            left: node.x * cell.width,
            top: (child.y + child.height) * cell.height,
            width: node.width * cell.width,
            height: cell.height,
          },
          edgeLeafPaneId: layoutLeafPaneId(edgeLeaf),
        });
      }
    }
  };

  visit(root);
  return { panes, gutters };
}

// layout 树的最大垂直堆叠 pane 数：每个 pane 有一条占空间的标题栏，
// 整窗 rows 换算时需按最深的一列扣除标题栏总高，保证该列也能放下
export function maxVerticalStackDepth(node: TmuxLayoutNode): number {
  if (node.type === 'leaf') {
    return 1;
  }
  if (node.type === 'column') {
    let total = 0;
    for (const child of node.children) {
      total += maxVerticalStackDepth(child);
    }
    return total;
  }
  let max = 1;
  for (const child of node.children) {
    max = Math.max(max, maxVerticalStackDepth(child));
  }
  return max;
}

// 对称地，最大水平并排 pane 数：每个 pane 左右各有视觉留白，
// 整窗 cols 换算按最宽的一行扣除留白总宽
export function maxHorizontalStackDepth(node: TmuxLayoutNode): number {
  if (node.type === 'leaf') {
    return 1;
  }
  if (node.type === 'row') {
    let total = 0;
    for (const child of node.children) {
      total += maxHorizontalStackDepth(child);
    }
    return total;
  }
  let max = 1;
  for (const child of node.children) {
    max = Math.max(max, maxHorizontalStackDepth(child));
  }
  return max;
}

export interface SplitWindowGridSizeInput {
  viewport: { width: number; height: number };
  cell: { width: number; height: number };
  paneChrome: { width: number; height: number };
}

export function computeSplitWindowGridSize(
  root: TmuxLayoutNode,
  input: SplitWindowGridSizeInput
): { cols: number; rows: number } {
  const vStack = maxVerticalStackDepth(root);
  const hStack = maxHorizontalStackDepth(root);
  const usableWidth = Math.max(0, input.viewport.width - hStack * input.paneChrome.width);
  const usableHeight = Math.max(0, input.viewport.height - vStack * input.paneChrome.height);
  const cols = Math.max(2, Math.floor(usableWidth / input.cell.width));
  const rows = Math.max(2, Math.floor(usableHeight / input.cell.height));
  return { cols, rows };
}

export interface SplitLayoutPxInput {
  viewport: { width: number; height: number };
  cell: { width: number; height: number };
  paneChrome: { width: number; height: number };
}

// 像素级分屏几何：按比例分配会把每 pane 固定的 chrome（标题栏/留白）也按
// cell 份额摊派，份额小的 pane 拿到的像素 < cells*cell + chrome，终端内容
// 被裁掉。这里按「子树最小需求 = cells*cell + stack 深度*chrome」先行保底，
// 剩余像素再按 cell 份额分摊（负余量同比例收缩，容器与 layout 过渡期不炸）。
export function computeSplitLayoutPxGeometry(
  root: TmuxLayoutNode,
  input: SplitLayoutPxInput
): SplitLayoutGeometry {
  const panes: SplitPaneRect[] = [];
  const gutters: SplitGutter[] = [];
  const { cell, paneChrome } = input;

  const neededWidth = (node: TmuxLayoutNode): number =>
    node.width * cell.width + maxHorizontalStackDepth(node) * paneChrome.width;
  const neededHeight = (node: TmuxLayoutNode): number =>
    node.height * cell.height + maxVerticalStackDepth(node) * paneChrome.height;

  const visit = (node: TmuxLayoutNode, box: PxRect): void => {
    if (node.type === 'leaf') {
      panes.push({
        paneId: layoutLeafPaneId(node),
        cols: node.width,
        rows: node.height,
        rect: box,
      });
      return;
    }

    const horizontal = node.type === 'row';
    const gutterSize = horizontal ? cell.width : cell.height;
    const totalCells = node.children.reduce(
      (sum, child) => sum + (horizontal ? child.width : child.height),
      0
    );
    const totalNeeded = node.children.reduce(
      (sum, child) => sum + (horizontal ? neededWidth(child) : neededHeight(child)),
      (node.children.length - 1) * gutterSize
    );
    const extra = (horizontal ? box.width : box.height) - totalNeeded;

    let cursor = horizontal ? box.left : box.top;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i] as TmuxLayoutNode;
      const childCells = horizontal ? child.width : child.height;
      const need = horizontal ? neededWidth(child) : neededHeight(child);
      const size = need + (totalCells > 0 ? (extra * childCells) / totalCells : 0);
      const childBox: PxRect = horizontal
        ? { left: cursor, top: box.top, width: size, height: box.height }
        : { left: box.left, top: cursor, width: box.width, height: size };
      visit(child, childBox);
      cursor += size;

      if (i === node.children.length - 1) {
        continue;
      }
      if (horizontal) {
        gutters.push({
          axis: 'x',
          rect: { left: cursor, top: box.top, width: gutterSize, height: box.height },
          edgeLeafPaneId: layoutLeafPaneId(rightEdgeLeaf(child)),
        });
      } else {
        gutters.push({
          axis: 'y',
          rect: { left: box.left, top: cursor, width: box.width, height: gutterSize },
          edgeLeafPaneId: layoutLeafPaneId(bottomEdgeLeaf(child)),
        });
      }
      cursor += gutterSize;
    }
  };

  visit(root, {
    left: 0,
    top: 0,
    width: input.viewport.width,
    height: input.viewport.height,
  });
  return { panes, gutters };
}

export type DropPosition = 'left' | 'right' | 'top' | 'bottom';

// pane 尺寸签名：只在 pane 的 paneId/cols/rows 变化时才变化，
// 用于 SplitTerminalArea geometry effect 依赖，避免 geometry 引用抖动导致无效 resize
export function paneSizesKey(geometry: SplitLayoutGeometry | null): string {
  if (!geometry) return '';
  return geometry.panes.map((p) => `${p.paneId}:${p.cols}x${p.rows}`).join('|');
}

// 指针在目标 pane 内的相对位置 → 四分区判定（距哪条边最近归哪侧）
export function resolveDropPosition(relativeX: number, relativeY: number): DropPosition {
  const x = Math.min(1, Math.max(0, relativeX));
  const y = Math.min(1, Math.max(0, relativeY));
  const distances: Array<[DropPosition, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return (distances[0] as [DropPosition, number])[0];
}
