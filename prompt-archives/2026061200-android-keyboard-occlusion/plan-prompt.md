# Prompt 存档

## 原始 prompt（2026-06-12）

> 新的问题：Android上键盘会完全盖住终端的下半部分
> iOS上这个问题倒是会被Safari自己处理好，修Android这个问题的时候你得处理好不同平台（包括各种手机和电脑），且输入相关交互的任何操作不能触发任何的resize

## 背景与调查结论

- 前端是 `h-dvh overflow-hidden` 的单屏固定布局（main.tsx RootLayout 的
  SidebarInset），body 不可滚。
- Android Chrome 108+ 默认 `interactive-widget=resizes-visual`：键盘弹出只缩小
  visual viewport，layout viewport 不变；固定布局下文档无处可滚 → 下半屏被键盘
  盖死。iOS Safari 会自行平移 visual viewport（offsetTop 补偿），所以 iOS 没问题。
- DevicePage 已有 iOS 专用逻辑：`shouldDockEditor`（editor 模式 fixed dock，
  bottom = keyboardInsetBottom），仅 `isIOSBrowser` 启用。
- ghostty-terminal 的隐藏 textarea 跟随光标定位（syncTextareaPositionToCursor），
  focus 已带 preventScroll；Terminal.tsx 用 ResizeObserver 观察容器，容器尺寸变化
  会触发终端 resize → tmux resize-pane。

## 关键约束

输入交互（聚焦/键盘弹收）不能触发任何 resize：
- 不能用 `interactive-widget=resizes-content`（会缩 layout viewport → 容器变小 →
  终端 fit → tmux resize）。
- 不能动态改终端容器高度/padding（同理触发 ResizeObserver）。
- 只能用 transform 平移（不参与布局，不触发 ResizeObserver）。

## 方案

- 新 hook `useVirtualKeyboardOffset()`：监听 visualViewport resize/scroll，
  inset = innerHeight - vv.height - vv.offsetTop；仅在非 iOS 触屏设备、
  vv.scale≈1、inset 超过阈值、且 document.activeElement 位于
  `[data-virtual-keyboard-avoid]` 容器内时输出非零。
- RootLayout（main.tsx）把 offset 应用为 SidebarInset 的
  `transform: translateY(-offset)`（offset=0 时不设 transform，避免创建
  containing block 影响 iOS dock 的 fixed 定位；iOS 路径 offset 恒 0，互斥）。
- DevicePage 给终端容器与 editor 容器加 `data-virtual-keyboard-avoid`。
- index.html viewport meta 显式加 `interactive-widget=resizes-visual`，
  锁定各 Chromium 系浏览器行为。
- iOS 现有 dock 逻辑保持不变；桌面（无触屏/pinch-zoom scale≠1）不启用。
