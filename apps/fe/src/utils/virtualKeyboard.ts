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
