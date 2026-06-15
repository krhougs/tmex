// 虚拟键盘弹出时只缩小 visual viewport，layout viewport 不变（viewport meta
// 已显式声明 interactive-widget=resizes-visual，Android Chrome 108+ 与新版
// iOS Safari 都遵循）；本应用是 100dvh + overflow hidden 的固定布局，文档
// 无处可滚，屏幕下半部分会被键盘整体盖住。所有触屏平台统一用平移避让；
// 旧版 iOS Safari 不识别该声明、仍自行平移 visual viewport 的部分会体现在
// offsetTop 里，计算时自动扣除，不会双重补偿。
//
// 修复方式必须是视觉平移（transform），不能改任何容器尺寸：终端容器由
// ResizeObserver 监听，尺寸变化会触发 tmux resize-pane，而"输入交互不得
// 触发 resize"是硬性约束。

export interface VirtualKeyboardViewportMetrics {
  windowInnerHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  viewportScale: number;
}

// 小于该值视为地址栏收放等视口抖动而非键盘
const MIN_KEYBOARD_INSET_PX = 60;
// pinch-zoom 同样会缩小 visual viewport，不属于键盘遮挡
const SCALE_TOLERANCE = 0.02;

export function computeVirtualKeyboardOffset(metrics: VirtualKeyboardViewportMetrics): number {
  if (Math.abs(metrics.viewportScale - 1) > SCALE_TOLERANCE) {
    return 0;
  }
  const inset = Math.round(
    metrics.windowInnerHeight - metrics.viewportHeight - metrics.viewportOffsetTop
  );
  return inset >= MIN_KEYBOARD_INSET_PX ? inset : 0;
}

export interface CursorFollowParams {
  // 光标底沿在当前 client 坐标系的 y（含当前已应用的避让位移）
  cursorBottomClientY: number;
  // 当前已应用到 <main> 的 translateY 位移量（px，正数）
  appliedOffset: number;
  windowInnerHeight: number;
  // 键盘遮挡高度（computeVirtualKeyboardOffset 的结果，>0）
  inset: number;
  // 光标底沿与键盘顶保留的间距（快捷键栏浮动时应含其高度，让光标停在浮条上方）
  margin: number;
  // 允许的最大上移量；默认 inset（位移不超键盘高度即不露白）。快捷键栏浮在键盘上方时
  // 可放宽到 inset + barHeight：多抬的那条空白正好被浮动快捷键栏盖住，仍不露白，从而
  // 光标即便在终端最底行也能抬到浮条之上。
  maxOffset?: number;
}

// 「光标对齐」模式（issue #27 模式 follow）：算出让光标底沿正好落在键盘上方所需的
// 最小整页上移量。
//
// 键盘顶在 client 坐标 = innerHeight - inset（兼容旧版 iOS 自平移：inset 已扣 offsetTop）。
// 当前 client 底沿已含 appliedOffset 位移，加回得未位移的自然底沿，使计算对自身位移收敛、
// 不抖动。上界 clamp 到 maxOffset（默认 inset）：超过会让 <main> 底边升过键盘顶、暴露空白
// （issue 明确要求避免的边界）；浮动快捷键栏存在时放宽到 inset + barHeight，露出部分被浮条盖住。
export function computeCursorFollowOffset(params: CursorFollowParams): number {
  const keyboardTopClientY = params.windowInnerHeight - params.inset;
  const naturalBottom = params.cursorBottomClientY + params.appliedOffset;
  const needed = naturalBottom + params.margin - keyboardTopClientY;
  const maxOffset = params.maxOffset ?? params.inset;
  return Math.min(Math.max(0, Math.round(needed)), maxOffset);
}

export function isIOSMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent;
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent);
  const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOSDevice || isTouchMac;
}

// 触屏平台才可能弹出虚拟键盘；桌面不启用（触屏笔记本不弹键盘时 inset 恒 0，无害）
export function needsManualKeyboardAvoidance(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
