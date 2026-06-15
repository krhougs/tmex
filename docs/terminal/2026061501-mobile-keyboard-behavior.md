# 终端手机端键盘行为优化（issue #27）

## 背景

当前（0.12.0）移动端虚拟键盘弹出时，整页通过 `transform: translateY(-keyboardHeight)` 上移、终端尺寸不变（刻意规避终端 `ResizeObserver` → tmux `resize-pane`）。

该策略在满屏终端下体验良好：光标在底部，整页上移后光标正好落在键盘上方。但在**新打开的空 shell** 中，光标/提示符在终端**顶部**（第 0 行），整页按键盘高度上移后，顶部光标被推到屏幕上沿之外，导致「看不见正在输入的内容」。

## 目标

新增「键盘行为」设置，入口在终端页右上角（`PageActions`），点击弹出底部 Sheet，三种模式即点即生效，选择持久化在浏览器（`useUIStore` / localStorage）。三模式：

| 内部值 | 用户文案 | 行为 |
|---|---|---|
| `lift` | 页面平移 | 整页按键盘高度上移，终端尺寸不变（即 0.12.0 现状）。 |
| `resize` | 终端缩放 | 整页缩到键盘上方的可用高度，终端随之 resize 占满（会改远端 tmux 窗格行数）。 |
| `follow` | 光标对齐 | 不改尺寸，按光标位置上移使光标正好在键盘上方；边界封顶避免露白。**默认**。 |

默认 `follow`：升级后即修复空 shell 问题；光标在底部时表现等同现状。

设置入口在**所有屏幕尺寸**展示（含触屏 PC、iPad），底部 Sheet 在大屏需居中限宽。

## 当前实现链路（现状 = `lift`）

- `apps/fe/src/hooks/use-virtual-keyboard-offset.ts`：监听 `visualViewport` resize/scroll + window resize + document focusin/focusout（RAF 防抖）；仅当 `document.activeElement.closest('[data-virtual-keyboard-avoid]')` 命中时输出 inset。
- `apps/fe/src/utils/virtualKeyboard.ts`：`computeVirtualKeyboardOffset` = `round(innerHeight - viewportHeight - offsetTop)`，`scale≠1` 或 `<60px` 归零；`needsManualKeyboardAvoidance()` 触屏检测。
- `apps/fe/src/main.tsx` `MainInset`：`offset>0` 时给 `SidebarInset`（`<main>`）加 `transform: translateY(-offset)` + `transition 0.12s`；底部 safe-area 填充 div 与 offset 联动。
- 标记点：`DevicePage.tsx` 终端容器（L896）、editor textarea 容器（L973）的 `data-virtual-keyboard-avoid`。

## 设计

### 状态与持久化

`useUIStore`（zustand + persist，key `tmex-ui`）新增 `keyboardBehaviorMode: 'lift' | 'resize' | 'follow'`（默认 `'follow'`）+ `setKeyboardBehaviorMode`，并加入 `partialize`。复用既有机制，零额外基建。旧用户无此字段时 `merge` 用 `current` 默认值兜底（即 `follow`）。

### 避让计算重构

新增 `apps/fe/src/hooks/use-keyboard-avoidance.ts`，替代 `MainInset` 内联逻辑，返回结构化结果：

```ts
type KeyboardAvoidance =
  | { strategy: 'none' }
  | { strategy: 'transform'; offset: number }   // lift / follow
  | { strategy: 'height'; height: number };      // resize
```

复用 `use-virtual-keyboard-offset` 的事件接线与 `computeVirtualKeyboardOffset`，按 `mode` 分发：

- `lift`：`transform`，`offset = inset`。
- `resize`：`height`，`height = innerHeight - inset`（触发终端既有 `ResizeObserver` → resize 链路，无需新写 resize 逻辑）。
- `follow`：`transform`，`offset = clamp(光标自然底 + margin - 键盘顶, 0, inset)`；键盘打开期间用 RAF 轮询光标位置（光标移动不发 viewport 事件）。光标拿不到（终端未聚焦 / 编辑器模式 / 光标隐藏）时回退到 `inset`（等价 `lift`）。

纯函数 `computeCursorFollowOffset`（放 `virtualKeyboard.ts`，可单测）：

```
keyboardTopClientY = innerHeight - inset
naturalBottom      = cursorBottomClientY + appliedOffset   // 加回当前已应用的位移
offset             = clamp(round(naturalBottom + margin - keyboardTopClientY), 0, inset)
```

`clamp` 上界 `inset` 是**避免露白**的核心：位移绝不超过键盘高度，否则 `<main>` 底边升过键盘顶、暴露下方空白。`naturalBottom = 当前 client 底 + appliedOffset`：因 transform 把元素上移了 `appliedOffset`，加回即得未位移的自然坐标，计算对自身位移稳定收敛（不抖动）。坐标用 `innerHeight - inset` 表示键盘顶 client Y，兼容旧版 iOS（`offsetTop>0`）。

### 光标位置获取（跨包，模式 `follow` 专用）

`packages/ghostty-terminal`：

- `terminal.ts` `render()`（每帧 RAF 已读 `meta.cursor`）缓存 `this.lastCursor`。
- 新增 public `getCursorViewportRect(): { top: number; bottom: number } | null`：仅当本终端聚焦（`document.activeElement === this.textarea`）且光标可见有值时返回 `screenElement.getBoundingClientRect().top + cursor.y * cellHeight` 的 client 上/下沿；否则 `null`。复用持久 `this.renderState`，**不**像 `syncTextareaPositionToCursor` 那样每次新建临时 render state。
- `types.ts` `CompatibleTerminalLike` 增可选 `getCursorViewportRect?()`。

桥接：新增 `apps/fe/src/utils/keyboard-cursor-bridge.ts` 单例（`registerCursorRectGetter` / `readActiveCursorRect`）。`Terminal.tsx` 在 `instance` 就绪时注册其 getter，卸载/切换时注销（守卫只清自己）。getter 内部按聚焦判定，天然解决「编辑器模式 / 多终端」——非聚焦终端返回 `null`。

### 入口与弹窗

- 入口：`DevicePage.tsx` `PageActions` 末尾加一个 `Button variant=ghost size=icon-sm` + lucide `Settings2` 图标，全屏尺寸显示（不门控）。
- 弹窗：新建 `apps/fe/src/components/settings/keyboard-behavior-sheet.tsx`，用 `ui/sheet.tsx` `side="bottom"`，大屏 `sm:mx-auto sm:max-w-md sm:rounded-t-2xl` 居中限宽。三张选项卡片（模式名 + 一句文案 + 选中 Check），点选立即 `setKeyboardBehaviorMode`（无保存按钮，满足「实时影响」）。

### i18n

`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 同步新增 `terminal.keyboardBehavior` 分组（`title`/`description`/`modeLift`+`modeLiftDesc`/`modeResize`+`modeResizeDesc`/`modeFollow`+`modeFollowDesc`），跑 `bun run build:i18n` 重建（生成文件不手改）。

## 验收标准

- 设置入口在终端页右上角全尺寸可见；点击弹底部 Sheet，大屏居中限宽不变形。
- 三模式即点即生效并持久化（刷新后保留）。
- `lift`：行为与 0.12.0 一致（e2e：键盘弹出 transform=translateY(-inset)、host 高度不变、无 resize 帧）。
- `follow`：空 shell（光标在顶部）键盘弹出时 offset≈0、光标可见；满屏（光标底部）offset≈inset；中间位置光标贴键盘顶；任何情况底部不露白。
- `resize`：键盘弹出后终端 rows 减少、内容铺满键盘上方；收起恢复。
- 单测覆盖 `computeCursorFollowOffset` 边界；e2e 覆盖三模式 DOM 契约。
- `biome check` 与 `tsc` 通过；既有 e2e 不回归。

## 风险

- `resize` 主动触发远端 tmux `resize-pane`（vim/htop 重绘）——issue 明确取舍，非默认。
- `follow` 跨包新增光标 API；RAF 轮询仅在键盘打开期间运行，setState 仅在 offset 变化 ≥1px 时触发。
- 旧版 iOS（`offsetTop>0`）尺寸/坐标准确性验证手段受限（模拟器历史无法复现键盘 bug）——见 `known-issues`。
