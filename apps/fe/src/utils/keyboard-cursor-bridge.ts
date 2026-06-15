// 「光标对齐」键盘模式（issue #27 follow）需要当前聚焦终端的光标屏幕坐标，但终端实例
// 深埋在 DevicePage 子树、而避让位移应用在 main.tsx 的 <main> 上。用一个模块级单例做桥：
// 聚焦的终端注册自己的「读光标 client 矩形」getter，避让 hook 按需 pull。
//
// getter 由终端内部按聚焦判定：未聚焦 / 光标隐藏时返回 null，避让 hook 据此回退到整页上移。
// 单终端场景下注册即覆盖；注销用守卫只清自己，避免切换 pane 时误清新注册者。

export interface CursorClientRect {
  top: number;
  bottom: number;
}

export type CursorRectGetter = () => CursorClientRect | null;

let activeGetter: CursorRectGetter | null = null;

export function registerCursorRectGetter(getter: CursorRectGetter): void {
  activeGetter = getter;
}

export function unregisterCursorRectGetter(getter: CursorRectGetter): void {
  if (activeGetter === getter) {
    activeGetter = null;
  }
}

export function readActiveCursorRect(): CursorClientRect | null {
  return activeGetter ? activeGetter() : null;
}
