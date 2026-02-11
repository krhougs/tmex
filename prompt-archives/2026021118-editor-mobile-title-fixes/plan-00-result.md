# Plan 00 执行结果

时间：2026-02-11

## 完成情况概览

本次已完成 7 项问题修复（原 6 项 + pane title 回归）：

1. 编辑器模式新增“发送附带回车”开关（默认开启，浏览器持久化）。
2. 恢复编辑器“逐行发送”按钮与行为。
3. 移动端终端页屏蔽 Chrome 下拉刷新手势。
4. 编辑器模式不再屏蔽终端直接输入。
5. 编辑器模式移动端底部增加系统手势安全区。
6. 优化 xterm 在手机端的触摸滚动跟手性。
7. 网关在剥离 `ESC k ... ESC \\` 时识别并回填 pane title，修复标题丢失回归。

## 关键实现明细

### 前端

- `apps/fe/src/stores/ui.ts`
  - 新增 `editorSendWithEnter`（默认 `true`）与 `setEditorSendWithEnter`。
  - 纳入 `tmex-ui` 持久化字段。

- `apps/fe/src/pages/DevicePage.tsx`
  - 编辑器新增“发送附带回车”开关 UI（`editor-send-with-enter-toggle`）。
  - `handleEditorSend` 根据开关决定是否附加 `\r`。
  - 恢复 `handleEditorSendLineByLine` 与按钮（`editor-send-line-by-line`）。
  - `term.onData` 去除 `inputMode === 'direct'` 限制，editor 模式下也可直接输入终端。

- `apps/fe/src/index.css`
  - 新增 `tmex-terminal-mobile-gesture-guard`，用于移动端终端页手势控制。
  - `.xterm .xterm-viewport` 增加 `-webkit-overflow-scrolling: touch`、`overscroll-behavior: contain`、`touch-action: pan-y`。
  - 编辑器底部新增 `safe-area-inset-bottom` 安全区。
  - 新增发送开关样式。

- `apps/fe/src/layouts/RootLayout.tsx`
  - 按“移动端 + 终端路由”条件动态挂载/移除 `body` 手势保护类。
  - 终端路由主区域增加 `overscroll-none`。

- `packages/shared/src/i18n/resources.ts`
  - 新增中英文文案：`terminal.editorSendWithEnter`。

### 网关

- `apps/gateway/src/tmux/parser.ts`
  - `TmuxControlParserOptions` 新增可选 `onPaneTitle` 回调。
  - `ESC k ... ESC \\` 处理升级为“剥离 + 提取标题”。
  - 标题解析状态改为按 `paneId` 维度（`Map<paneId, TitleParseState>`），避免跨 pane 串扰。
  - `%output/%extended-output` 继续保持换行归一化与跨模式同内容去重。

- `apps/gateway/src/tmux/connection.ts`
  - 接入 parser 的 `onPaneTitle` 回调。
  - 实时回填已存在 pane 的 `title` 并触发 snapshot 下发。
  - 新增 `pendingPaneTitles`：当 pane 尚未进入快照时，先缓存标题，在 `parseSnapshotPanes` 合并。

## 测试更新

- `apps/gateway/src/tmux/parser.test.ts`
  - 新增标题序列剥离与提取测试。
  - 新增跨 chunk 标题提取测试。
  - 新增跨 pane 状态隔离测试。

- `apps/gateway/src/tmux/connection.test.ts`
  - 新增 pending title 与 snapshot panes 合并测试。
  - 新增实时更新 pane title 并触发 snapshot 测试。

- `apps/fe/tests/tmux-ux.e2e.spec.ts`
  - 增加编辑器发送开关默认态与逐行发送按钮可见性断言。
  - 增加 editor 模式下 direct 输入可发送断言。
  - 增加逐行发送执行结果断言。

## 验证结果

### 网关单测

- `bun test apps/gateway/src/tmux/parser.test.ts` ✅（20 pass）
- `bun test apps/gateway/src/tmux/connection.test.ts` ✅（6 pass）

### 构建与类型检查

- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅
- `bun run --cwd apps/fe build` ✅（存在既有 CSS pseudo-class warning）
- `bun run --cwd apps/gateway build` ✅

### E2E 定向验证

- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "输入模式切换"` ✅
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"` ✅

## 结论

本轮问题已按需求完成落地，新增的 pane title 回归修复也已并入并通过单测验证。当前实现保持了协议兼容与最小侵入，前后端核心行为均已通过定向回归。

## 追加修复（User Prompt 05）

时间：2026-02-11

### 新增问题

1. 发送附带回车开关与 3 个发送相关按钮需要同一行，且紧邻输入框。
2. 安卓和 iOS 下拉刷新仍未被成功屏蔽。
3. 手机端终端滚动仍不够丝滑。

### 追加实现

- `apps/fe/src/pages/DevicePage.tsx`
  - 新增 `editor-send-row` 容器，把以下 4 个控件放到同一行：
    - 发送附带回车开关
    - 清空按钮
    - 逐行发送按钮
    - 发送按钮
  - 保留快捷键区单独一行。

- `apps/fe/src/index.css`
  - 强化 `tmex-terminal-mobile-gesture-guard`：`overflow: hidden`、`overscroll-behavior: none`。
  - `xterm-viewport` 隐藏滚动条并保留触摸惯性滚动。
  - 新增 `.send-row` 布局；移动端下 `.send-row` 改为横向可滚动，保证同排不挤压。

- `apps/fe/src/layouts/RootLayout.tsx`
  - 新增移动端终端路由下的 `touchstart/touchmove` 非被动监听。
  - 仅在“向下拉且当前滚动容器已到顶”时 `preventDefault()`，阻断浏览器 pull-to-refresh。

- `apps/fe/src/pages/DevicePage.tsx`
  - xterm 初始化增加滚动参数：
    - `scrollSensitivity: 1.35`
    - `smoothScrollDuration: 120`
    - `fastScrollModifier: 'none'`
    - `fastScrollSensitivity: 1`

- `apps/fe/tests/tmux-ux.e2e.spec.ts`
  - 新增 `editor-send-row` 可见性与子节点数量断言。

### 追加验证

- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅
- `bun run --cwd apps/fe build` ✅（既有 CSS warning）
- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "输入模式切换"` ✅
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"` ✅

### 说明

下拉刷新屏蔽在本次由“CSS 限制”升级为“CSS + 触摸事件拦截”双保险实现；终端滚动体验在 xterm 参数与 viewport 触摸行为两层同时做了优化。真机体感仍会受系统版本和浏览器内核差异影响，如需可继续按设备型号做参数微调。

## 追加修复（User Prompt 06）

时间：2026-02-11

### 新增问题

1. 编辑器模式输入区下方“开关+发送相关按钮”在窄宽度下应自动换两行；拆成两行时需右对齐。
2. 快捷键按钮被挡住。
3. Android Chrome 在 direct/editor 模式下输入法遮挡输入区域。

### 追加实现

- `apps/fe/src/index.css`
  - `send-row` 改为 `flex-wrap: wrap` + `justify-content: flex-end`，满足窄宽度自动换行且右对齐。
  - 去掉移动端 `send-row` 的横向滚动单行策略，避免遮挡快捷键区。
  - 给 `.actions` 增加移动端 `max-height + overflow-y: auto`，保证快捷键区可滚动可见。
  - 新增 `--tmex-viewport-height` 变量默认值，用于配合输入法弹出时动态高度。

- `apps/fe/src/layouts/RootLayout.tsx`
  - 引入 `visualViewport` 监听（`resize/scroll`）与 `window.resize` 双重监听。
  - 动态更新 `--tmex-viewport-height`，根容器高度改为该变量，规避软键盘弹出造成的可视区域被遮挡。

- `apps/fe/tests/tmux-ux.e2e.spec.ts`
  - 在“输入模式切换”场景中增加窄屏切换后 `editor-send-row` 和 `editor-shortcuts-row` 可见断言。

### 追加验证

- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅
- `bun run --cwd apps/fe build` ✅（既有 CSS warning）
- `bun run --cwd apps/fe test:e2e -- tests/tmux-ux.e2e.spec.ts -g "输入模式切换"` ✅

### 说明

输入法遮挡属于浏览器/系统实现差异较大的领域，本次采用了当前 Web 侧可控且稳定性较高的方案：

1. 使用 `visualViewport` 动态同步可视高度；
2. 保证编辑器操作区可纵向滚动；
3. 保留终端页触摸手势拦截能力。

如仍有个别机型异常，可基于机型日志再补充“键盘弹出时自动 `scrollIntoView` 当前输入控件”的兜底策略。
