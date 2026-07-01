// tmux #{window_layout} 布局字符串解析
// 格式（tmux layout-custom.c）：`<4位hex校验和>,<node>`
//   node  = WxH,X,Y ( ',' paneNumId | '{' node (',' node)+ '}' | '[' node (',' node)+ ']' )
//   '{}' 为水平排列（left-right），'[]' 为垂直排列（top-bottom）
//   叶子的 paneNumId 是不带 '%' 前缀的数字，对应 tmux pane id `%<paneNumId>`

export interface TmuxLayoutLeaf {
  type: 'leaf';
  paneNumId: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface TmuxLayoutSplit {
  type: 'row' | 'column';
  width: number;
  height: number;
  x: number;
  y: number;
  children: TmuxLayoutNode[];
}

export type TmuxLayoutNode = TmuxLayoutLeaf | TmuxLayoutSplit;

export interface ParsedWindowLayout {
  checksum: string;
  root: TmuxLayoutNode;
}

interface ParseState {
  input: string;
  pos: number;
}

const CHECKSUM_PATTERN = /^[0-9a-fA-F]{4}$/;

export function parseWindowLayout(layout: string): ParsedWindowLayout | null {
  if (typeof layout !== 'string' || layout.length < 6) {
    return null;
  }
  const checksum = layout.slice(0, 4);
  if (!CHECKSUM_PATTERN.test(checksum) || layout[4] !== ',') {
    return null;
  }
  const state: ParseState = { input: layout, pos: 5 };
  const root = parseNode(state);
  if (!root || state.pos !== layout.length) {
    return null;
  }
  return { checksum, root };
}

function parseNumber(state: ParseState): number | null {
  const start = state.pos;
  while (state.pos < state.input.length) {
    const code = state.input.charCodeAt(state.pos);
    if (code < 48 || code > 57) {
      break;
    }
    state.pos += 1;
  }
  if (state.pos === start) {
    return null;
  }
  return Number.parseInt(state.input.slice(start, state.pos), 10);
}

function consume(state: ParseState, char: string): boolean {
  if (state.input[state.pos] !== char) {
    return false;
  }
  state.pos += 1;
  return true;
}

function parseNode(state: ParseState): TmuxLayoutNode | null {
  const width = parseNumber(state);
  if (width === null || !consume(state, 'x')) {
    return null;
  }
  const height = parseNumber(state);
  if (height === null || !consume(state, ',')) {
    return null;
  }
  const x = parseNumber(state);
  if (x === null || !consume(state, ',')) {
    return null;
  }
  const y = parseNumber(state);
  if (y === null) {
    return null;
  }

  const next = state.input[state.pos];
  if (next === ',') {
    state.pos += 1;
    const paneNumId = parseNumber(state);
    if (paneNumId === null) {
      return null;
    }
    return { type: 'leaf', paneNumId, width, height, x, y };
  }

  if (next === '{' || next === '[') {
    const closer = next === '{' ? '}' : ']';
    state.pos += 1;
    const children: TmuxLayoutNode[] = [];
    for (;;) {
      const child = parseNode(state);
      if (!child) {
        return null;
      }
      children.push(child);
      if (consume(state, ',')) {
        continue;
      }
      if (consume(state, closer)) {
        break;
      }
      return null;
    }
    if (children.length < 2) {
      return null;
    }
    return {
      type: next === '{' ? 'row' : 'column',
      width,
      height,
      x,
      y,
      children,
    };
  }

  return null;
}

export function collectLayoutLeaves(root: TmuxLayoutNode): TmuxLayoutLeaf[] {
  const leaves: TmuxLayoutLeaf[] = [];
  const stack: TmuxLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'leaf') {
      leaves.push(node);
    } else {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i] as TmuxLayoutNode);
      }
    }
  }
  return leaves;
}

export function layoutLeafPaneId(leaf: TmuxLayoutLeaf): string {
  return `%${leaf.paneNumId}`;
}
