// 极简 JSX → 纯文本运行时（classic 运行时，零依赖）。
// gateway tsconfig 配 jsx=react / jsxFactory=h / jsxFragmentFactory=Fragment；
// prompt 模板 .tsx 用 `import { h, Fragment }` 接入。组件即「props → string」纯函数，
// 渲染结果就是字符串，由组件自身决定换行/分隔，h 只负责拍平 children。

export type PromptNode = string | number | boolean | null | undefined | PromptNode[];

export const Fragment = Symbol.for('tmex.prompt.jsx.Fragment');

function collect(node: PromptNode, out: string[]): void {
  if (node === null || node === undefined || node === false || node === true) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, out);
    }
    return;
  }
  const text = typeof node === 'number' ? String(node) : node;
  if (text.length === 0) {
    return;
  }
  out.push(text);
}

/** 把任意嵌套的 children 拍平、过滤空值，得到字符串数组。 */
export function flattenNodes(node: PromptNode): string[] {
  const out: string[] = [];
  collect(node, out);
  return out;
}

/** 无分隔拼接（透明）。 */
export function cat(node: PromptNode): string {
  return flattenNodes(node).join('');
}

/** 逐行拼接（单换行）。 */
export function lines(node: PromptNode): string {
  return flattenNodes(node).join('\n');
}

/** 段落拼接（空行分隔）。 */
export function blocks(node: PromptNode): string {
  return flattenNodes(node).join('\n\n');
}

export type PromptComponent<P = unknown> = (props: P & { children: PromptNode }) => string;

export function h(
  type: PromptComponent<Record<string, unknown>> | typeof Fragment | string,
  props: Record<string, unknown> | null,
  ...children: PromptNode[]
): string {
  if (typeof type === 'function') {
    return type({ ...(props ?? {}), children });
  }
  // Fragment 或字符串标签：透明拼接，交由外层组件决定分隔
  return cat(children);
}

// 把 JSX 类型命名空间挂在工厂 h 上（h.JSX），避免污染全局 JSX 命名空间，
// 防止与前端 React 的 JSX 在统一编辑器工程里冲突。运行时无影响。
// biome-ignore lint/style/noNamespace: JSX 类型命名空间需挂在工厂标识符上
export namespace h {
  export namespace JSX {
    export type Element = string;
    export interface ElementChildrenAttribute {
      children: object;
    }
    export interface IntrinsicElements {
      [tag: string]: Record<string, unknown>;
    }
  }
}
