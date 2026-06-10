# 网页终端快捷键 / 粘贴 / 选择复制修复计划

## 背景

tmex 网页终端使用自研 `ghostty-terminal` 包（Ghostty 官方 WASM + canvas 渲染），前端为 React（`apps/fe`）。输入通过隐藏 contenteditable（`.xterm-helper-textarea`）捕获，经 WASM 编码后通过 Borsh WebSocket 发往后端 tmux。

本任务修复三个问题（无需参考旧分支，主要涉及 `packages/ghostty-terminal/src/terminal.ts`、`selection-clipboard.ts`、`apps/fe/src/components/terminal/*`、`apps/fe/src/components/ui/sidebar.tsx`）。

## 根因分析

### 问题 1：Ctrl-C 等快捷键失效

- `terminal.ts` keydown：只要存在选区，`isCopyShortcut`（metaKey||ctrlKey + C）一律拦截为复制，且复制后**不清除选区**。选区只在单击终端空白等少数场景清除，因此用户选过一次文本后，后续所有 Ctrl+C 都被吞掉，SIGINT 永远发不出去。
- `isCopyShortcut` 不区分平台：mac 上 Ctrl+C（用户习惯发 SIGINT，复制用 Cmd+C）也被当成复制。
- `sidebar.tsx` 在 `window` 上全局监听 keydown，对 Ctrl/Cmd+B（tmux 默认前缀键）`preventDefault` 并切换侧栏，即使终端已消费该键。

### 问题 2：粘贴不工作

- keydown 阶段 Ctrl+V 被 `shouldEncodeOnKeyDown` 命中 → WASM 编码为 0x16 → `preventDefault()` → 浏览器永远不会派发 `paste` 事件，已有的 paste 监听器形同虚设。
- 移动端：textarea `pointer-events: none`，没有任何粘贴入口。

### 问题 3：缺少复制 GUI

- 复制只能靠键盘快捷键；移动端连选区都无法创建（选区仅由 mouse 事件驱动，触摸只做滚动）。

## 修复设计

1. `selection-clipboard.ts`
   - 平台感知：mac 上仅 Cmd+C 是复制快捷键（Ctrl+C 直通终端）；其它平台 Ctrl+C（含 Ctrl+Shift+C）在有选区时复制。
   - 新增 `isPasteShortcut`：mac 为 Cmd+V；其它平台为 Ctrl+V / Ctrl+Shift+V；全平台 Shift+Insert。
   - 新增带 execCommand 回退的 `writeTextToClipboard`（HTTP 部署下 `navigator.clipboard` 不可用）。
2. `terminal.ts`
   - 复制后清除选区 → 下一次 Ctrl+C 直接发 SIGINT（与 Windows Terminal 行为一致）。
   - keydown 识别粘贴快捷键后直接放行（不编码、不 preventDefault），让浏览器派发 paste 事件，由现有 paste 监听器做 bracketed-paste 编码。
   - 公开选择 API：`getSelection()` / `hasSelection()` / `clearSelection()` / `onSelectionChange(cb)`；新增触摸选择 API：`startTouchSelection` / `updateTouchSelection` / `endTouchSelection`。
3. `sidebar.tsx`：keydown handler 忽略 `defaultPrevented` 的事件以及来自终端（`.xterm` 内）的事件。
4. 前端 GUI：新增 `SelectionToolbar`（浮动于终端容器顶部，含 复制 / 粘贴 / 关闭），选区存在时显示；按钮尺寸照顾触屏。粘贴按钮用 `navigator.clipboard.readText()`，同时给移动端提供粘贴入口。
5. `useMobileTouch.ts`：长按（约 500ms，移动容差内）进入选择模式（按词选中），拖动扩展选区，松手后浮出工具条。
6. i18n：`terminal.copy` / `terminal.paste` / `terminal.copied` / `terminal.pasteFailed` / `terminal.clearSelection` 三语（zh_CN / en_US / ja_JP），改 `packages/shared/src/i18n/locales/*.json` 后跑 `bun run build:i18n` 重新生成（生成文件不要手动 lint）。

## 任务清单

1. 修改 `selection-clipboard.ts`（平台感知 + paste 判断 + 剪贴板写入回退）。
2. 修改 `terminal.ts`（复制清选区、放行粘贴快捷键、公开 selection/touch API、选区变化通知）。
3. 扩展 `types.ts` 的 `CompatibleTerminalLike`。
4. 修改 `sidebar.tsx` 全局快捷键守卫。
5. i18n 文案 + `bun run build:i18n`。
6. 新增 `SelectionToolbar.tsx`，接入 `Terminal.tsx`。
7. `useMobileTouch.ts` 长按选择。
8. `bun test`（ghostty-terminal 包，新增针对性用例）+ 前端 `tsc`/`vite build` 验证。

## 验收标准

- 选中文本 → Ctrl/Cmd+C 复制成功且选区清除；再次 Ctrl+C 向终端发送 0x03。
- mac 上 Ctrl+C 在有选区时仍发 0x03（复制走 Cmd+C）。
- Ctrl+V / Cmd+V / Ctrl+Shift+V / Shift+Insert 触发浏览器 paste 事件并以 bracketed-paste 进入终端。
- 终端聚焦时按 Ctrl+B 不再切换侧栏（发往 tmux）；终端外 Ctrl/Cmd+B 仍可切换。
- 选中文本后出现浮动工具条，复制/粘贴按钮在桌面与移动端均可用。
- 移动端长按可创建选区并通过工具条复制。
- `bun test`、前端构建通过。

## 风险

- Ghostty WASM 对 super(Cmd) 组合键的编码行为未完全确认，mac 下 Cmd+V 是否已被编码吞掉需以"显式放行粘贴快捷键"兜底（本方案即如此）。
- 非 HTTPS 部署下 `navigator.clipboard.readText` 不可用，粘贴按钮将提示失败（复制有 execCommand 回退）。
- 放行 Ctrl+V 意味着 kitty 协议应用收不到 Ctrl+V 键编码（vim 块选择可用 Ctrl+Q 替代），与主流 Web 终端（VS Code、Windows Terminal）一致。
