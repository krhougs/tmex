# Plan 00：编辑器发送、移动端手势与 pane title 解析修复

时间：2026-02-11

## 背景

用户集中反馈 6 个前端交互问题，并追加 1 个后端回归问题：

1. 编辑器发送按钮需要可配置“是否附带回车”。
2. 编辑器“逐行发送”按钮能力缺失。
3. 手机 Chrome 下拉会触发整页刷新。
4. 编辑器模式屏蔽了终端直接输入。
5. 编辑器模式移动端底部未预留系统手势安全区。
6. 终端在手机上的上下滚动不跟手。
7. `%output/%extended-output` 链路中剥离 `ESC k ... ESC \\` 后，pane title 丢失。

代码排查结论：

- 前端问题集中在 `apps/fe/src/pages/DevicePage.tsx`、`apps/fe/src/index.css`、`apps/fe/src/stores/ui.ts`。
- “逐行发送”在 i18n 改造提交 `9baf8a0` 中被删除。
- 网关 parser 当前对标题序列仅“剥离不利用”，且标题状态机为全局状态，存在跨 pane 串扰风险。

## 目标

1. 完成 6 项前端交互修复，保持现有功能不回退。
2. 修复标题序列剥离导致的 pane title 回归：剥离同时识别并回填 title。
3. 保持 WebSocket 协议不变，以最小改动完成行为修复。

## 关键决策

1. 编辑器“发送附带回车”默认开启，并持久化在浏览器（zustand persist）。
2. “逐行发送”恢复为编辑器按钮，行为为按行拆分并逐行追加 `\r`，跳过纯空白行。
3. editor 模式不阻断 xterm 的 direct 输入，仅保留 `isComposing` 保护。
4. 标题序列解析按 `paneId` 维度维护状态，避免跨 pane 串扰。
5. pane title 更新通过现有 snapshot 通道传播，不新增 ws 事件类型。

## 实施任务

### 任务 1：前端 UI 状态与编辑器发送能力

- 文件：`apps/fe/src/stores/ui.ts`
- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 文件：`packages/shared/src/i18n/resources.ts`

内容：

1. 在 UI store 新增 `editorSendWithEnter` 与 `setEditorSendWithEnter`。
2. 将该字段加入持久化 `partialize`。
3. 编辑器区新增开关 UI（测试标识：`editor-send-with-enter-toggle`）。
4. `handleEditorSend` 根据开关决定是否附带回车。
5. 恢复 `handleEditorSendLineByLine` 及按钮（测试标识：`editor-send-line-by-line`）。

### 任务 2：前端输入模式与移动端手势/滚动

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 文件：`apps/fe/src/index.css`

内容：

1. `term.onData` 移除 `inputMode === 'direct'` 限制，允许 editor 模式 direct 输入。
2. 终端路由启用移动端手势优化 class。
3. 在终端页禁用 pull-to-refresh（`overscroll-behavior-y: none`）。
4. 优化 `.xterm .xterm-viewport` 的触摸滚动体验（`-webkit-overflow-scrolling: touch` 等）。
5. 编辑器模式移动端底部增加 `safe-area-inset-bottom` 安全区。

### 任务 3：网关 parser 标题序列“剥离+识别+回填”

- 文件：`apps/gateway/src/tmux/parser.ts`
- 文件：`apps/gateway/src/tmux/connection.ts`

内容：

1. parser 增加 `onPaneTitle` 可选回调。
2. 将标题序列状态从全局改为按 `paneId` 维护（Map）。
3. 在剥离 `ESC k ... ESC \\` 时提取标题文本并通过 `onPaneTitle(paneId, title)` 上报。
4. connection 接收标题更新，回填到内存 snapshot pane.title。
5. 若 pane 尚未就绪，写入 pending map，待下次 snapshot panes 合并回填。

### 任务 4：测试与验证

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 文件：`apps/gateway/src/tmux/connection.test.ts`
- 文件：`apps/fe/tests/tmux-ux.e2e.spec.ts`

内容：

1. parser 新增标题提取用例（含跨 chunk、跨 pane 交错）。
2. connection 新增/更新 pane title 回填用例。
3. e2e 增加编辑器“发送附带回车”与“逐行发送”可见性/行为断言。

## 验收标准

1. 编辑器模式可见“发送附带回车”开关，默认开启且刷新后保持。
2. 编辑器“逐行发送”按钮恢复并可执行。
3. editor 模式下点击终端并输入，仍可向后端发输入数据。
4. 手机终端页下拉不触发整页刷新，终端滚动跟手。
5. 移动端编辑器底部控件不被系统手势区遮挡。
6. 标题序列不会污染终端输出，同时能恢复并更新 pane title。

## 风险与注意事项

1. 全局禁用 overscroll 可能误伤其他页面，需限定在终端路由。
2. 标题解析若未做 pane 维度隔离，可能继续出现串扰。
3. 标题文本解码失败时应降级忽略，避免中断输出链路。
