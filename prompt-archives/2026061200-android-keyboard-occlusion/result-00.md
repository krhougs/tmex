# 执行结果总结

## 后续 prompt（同日）

> 我已经测试过，在Android上已经达到了我要的效果，但是iOS上出现了新问题，键盘弹出来之后页面不会跳转到动态输入框的位置

iOS 回归原因：新版 iOS Safari 也解析 `interactive-widget=resizes-visual`，于是不再
执行原生的"自动滚动到聚焦输入框"，而初版避让逻辑把 iOS 排除在外——两头落空。
处理：统一所有触屏平台走 translate 避让，不再依赖 Safari 原生行为；旧版 iOS
Safari 不识别该声明、自行平移的部分体现在 visualViewport.offsetTop 中，inset
公式自动扣除，不会双重补偿。顺带删除了 iOS 专用 editor dock 特例（fixed dock +
paddingBottom 撑高，后者本身会触发终端 resize，违反约束）。

## 最终方案

- `apps/fe/index.html`：viewport meta 显式加 `interactive-widget=resizes-visual`，
  锁定"键盘只缩 visual viewport、不缩 layout viewport"——键盘弹收绝不改变容器
  尺寸，终端的 ResizeObserver → tmux resize-pane 链路不会被输入交互触发。
- `apps/fe/src/utils/virtualKeyboard.ts`：纯函数 `computeVirtualKeyboardOffset`
  （inset = innerHeight − vv.height − vv.offsetTop，≥60px 才视为键盘，
  scale≠1 的 pinch-zoom 不触发）+ `needsManualKeyboardAvoidance`（触屏平台）。
- `apps/fe/src/hooks/use-virtual-keyboard-offset.ts`：监听 visualViewport
  resize/scroll、window resize、focusin/focusout（rAF 节流）；仅当
  document.activeElement 位于 `[data-virtual-keyboard-avoid]` 容器内时输出非零。
- `apps/fe/src/main.tsx` RootLayout：offset>0 时对 SidebarInset 施加
  `transform: translateY(-offset)`（含 0.12s 过渡）；offset=0 时移除 transform
  （非 none 的 transform 会成为 fixed 后代的 containing block）。
- `apps/fe/src/pages/DevicePage.tsx`：终端容器与 editor 容器标记
  `data-virtual-keyboard-avoid`；删除 iOS dock 全套（shouldDockEditor、
  keyboardInsetBottom、editorDockHeight、isEditorFocused、handleEditorFocus 的
  scrollIntoView hack）。

## 平台矩阵

- Android Chrome 等（resizes-visual）：translate 避让，用户真机验证通过。
- iOS Safari：新版同走 translate；旧版 Safari 自行平移的部分经 offsetTop 扣除。
- 桌面：无虚拟键盘，inset 恒 0；pinch-zoom 被 scale 防护排除。
- 任何路径都不改变容器尺寸 → 输入交互零 resize。

## 验证

- 单测：`virtualKeyboard.test.ts` 7 例（Android 全量遮挡、iOS 部分/全量补偿、
  地址栏抖动、pinch-zoom、桌面、负值）。
- e2e：`mobile-keyboard-avoidance.spec.ts`（Pixel 5 形态 + visualViewport mock）：
  meta 声明、键盘弹出 → translateY(-320)、终端容器尺寸不变、全程 0 个
  TERM_RESIZE/TERM_SYNC_SIZE 帧、键盘收起复位、blur 后不平移。
  注意：ghostty 引擎的输入元素是 `<div contenteditable class="xterm-helper-textarea">`，
  不是 `<textarea>`。
- 回归：terminal-focus / mobile-terminal-interactions / ws-borsh-resize 共 14 例全过。
- 真机：用户在 Android 与 iOS 上验证通过。

## 跑 e2e 的环境坑（再次踩到，与 memory 一致）

- shell 里 NODE_ENV=production 会毒化 vite dev（_jsxDEV is not a function），
  跑 e2e 必须显式 NODE_ENV=development。
- 9883 被常驻 tmex 占用且 run-e2e 的端口探测在 IPv6 上误判可用，加上
  reuseExistingServer 会把常驻 tmex 当 fe server（serve 旧构建）；必须
  TMEX_E2E_GATEWAY_PORT=9665 TMEX_E2E_FE_PORT=9885。
