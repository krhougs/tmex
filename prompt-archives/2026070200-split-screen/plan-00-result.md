# Split Screen 实现结果总结

计划见 `plan-00.md`，prompt 存档见 `plan-prompt.md`。全部七个阶段完成，分支 `worktree-split-screen`。

## 交付内容

### 数据链路（Phase 1）
- `TmuxPane` 增加 `left/top`、`TmuxWindow` 增加 `layout`（tmux `#{window_layout}` 字符串），wire schema 与 convert 同步；`PaneWireSchema` 顺带补 `currentCommand`。
- 新增 `packages/shared/src/tmux-layout.ts`：layout 字符串 → 分割树解析器（`{}`=row、`[]`=column、叶子 `,paneNumId`），样本取自真实 tmux。
- `snapshot-format.ts` 新增共享行解析器（`WINDOW/PANE_SNAPSHOT_FORMAT` + `parseWindowSnapshotRow/parsePaneSnapshotRow`），字段序重排为「定长前置、自由文本后置」，顺带修复 pane 行 10 字段未被 `splitSnapshotFields` 特判、title 含 `|` 整行失效的历史隐患。local/ssh 双镜像。

### tmux 命令原语（Phase 2）
- `DeviceSessionRuntimeConnection` + facade + local/ssh 双实现新增：`splitPane`（split-window -P 回传新 paneId 并发 pane-active）、`resizePaneById`（resize-pane 绝对值）、`resizeWindow`、`selectLayout`、`focusPane`（无 history capture 的轻量焦点路径）、`requestPaneHistory`。
- 真实 tmux 集成测试覆盖 split / 互补 resize / even-horizontal / focus 全链路。

### WS 协议与多路分发（Phase 3）
- 新 kind `0x020d-0x0212`：`SUBSCRIBE_PANES` / `FETCH_PANE_HISTORY` / `RESIZE_PANE` / `APPLY_STACKED_LAYOUT` / `SPLIT_PANE` / `FOCUS_PANE`。
- gateway：`subscribedPanes` 附加订阅集 + `pendingHistoryFetches`；输出广播焦点 pane 走 switch-barrier、订阅 pane 直发（绝不进 barrier 缓冲，防 flush 错误归属）；history 支持 fetch-token 直发；轮询条件、断连清理补齐；capabilities 加 `tmex-split-v1`。
- FE：新增 `pane-sink-registry`（per-pane sink 注册 + 未挂载缓冲 + fetch-history 门控带超时兜底）；`SelectStateMachine` 回调带 paneId、非事务 pane 输出改路由不丢弃；`Terminal` 从全局回调覆盖改为 `registerPaneSink`；store 一次性接线 + 6 个新动作。

### PC 分屏（Phase 4）
- `SplitTerminalArea`：layout 树按 cells 比例绝对定位多 Terminal 实例（`sizingMode="follow"`，实例 cols/rows 跟随 layout，容器像素不作为尺寸来源）；容器 RO 防抖上报整窗 resize（复用 KIND_TERM_RESIZE 整窗语义）；splitter 拖拽 overlay 参考线 + pointerup 一次提交 `resize-pane` 绝对值（含两侧 min clamp），layout 快照回流即真相、无回弹；焦点 pane 右上角 primary 圆点角标（用户选定样式）。
- `splitLayoutGeometry` 纯函数：pane 矩形 / gutter 命中区 / 拖拽 px→cells 换算（edge leaf 定位：row 取最右链、column 取首子链）。
- DevicePage 最小侵入：`isSplitView` 分支渲染；分屏内同窗焦点切换走轻量 FOCUS_PANE（对账 effect 只加分流不改本体）；分屏禁用远端尺寸回灌；`getSelectSize` 分屏用整个终端区域换算；isSplitView 翻转时强制完整 select（新实例需要 history）。
- e2e 桥（`__tmexE2eXterm` 等）改为焦点实例持有（原为最后挂载实例覆盖）。

### 移动端（Phase 5）
- `PaneSwitcherMenu`：<768px 且多 pane 时标题栏出现切换按钮（Columns2 + 数量角标），弹出 pane 列表（index/title/进程/cwd/当前项高亮）。
- 多 pane window 的 resize/sync 改道 `APPLY_STACKED_LAYOUT`（window 宽 = N*cols+(N-1) + even-horizontal，每 pane 恰好一屏；gateway 幂等跳过防互踩）；select 不携带尺寸。
- 视口 390↔1280 双向翻转自动切换单 pane/分屏。

### 入口与顺带修复（Phase 6）
- 三处 split 入口：sidebar pane 菜单、桌面 PageActions（向右/向下分屏按钮）；cwd 默认取 pane currentPath；split 后焦点自动跟随新 pane（pane-active 事件 → 既有对账）。
- i18n：`window.switchPane/splitRight/splitDown`（zh/en/ja）。
- agent 通知深链修复：新增 `tmux/snapshot-directory` 注册表（runtime 注入 wsServer.getLastSnapshot），agent 通知经 `resolvePaneContext` 由 paneId 反查 windowId/paneUrl。

## 验证结论（Phase 7）

- 单测：`bun test apps/gateway packages apps/fe/src` 1030+ 全过（1 个 pane-emulator 为全量并发下的既有 flaky，单跑通过，主仓同样存在）。
- 冒烟（Playwright + 真实 tmux + worktree dev 实例 19663/19883）：桌面分屏渲染/切焦点/tmux active 同步/输入路由、splitter 拖拽互补 resize（min clamp 精确截停）、split 按钮、移动端拼接几何（137=3×45+2 精确命中）、视口翻转，全部通过并截图自验。
- e2e：新增 `split-screen-desktop.spec.ts` / `split-screen-mobile.spec.ts`；全套回归通过（既有失败仅 mobile-terminal-interactions ×4，主仓 main 同样失败，属本机既有环境问题）。

## 既有 e2e 测试的适配说明（重要）

桌面上多 pane window 现在同屏分屏渲染，以下既有测试假设失效并已适配：

1. 裸 `page.locator('.xterm')` 在分屏下命中多元素（strict violation）→ 批量改 `.first()`（16 个文件，DOM 序第一个 = layout 第一叶 = 测试导航的 pane 0，语义等价）。
2. 「同窗切 pane」不再走完整 select（改轻量 FOCUS_PANE、终端实例不重建）→ 依赖完整 select/barrier/重挂载语义的测试改用 `createTwoWindowSession`（跨 window 切换保留原语义）：`ws-borsh-switch-barrier` ×2、`terminal-selection-canvas` 的「切换清选区」。
3. 与 pane 数无关、two-pane 只是脚手架的测试改 `createSinglePaneSession`：`terminal-mouse-recovery` 的 3 个 vim/opencode 用例、`ws-borsh-resize` 的 focus-restore 用例、`mobile-keyboard-avoidance`（移动端多 pane 的 resize 现在改道 stacked-layout 消息）、selection toolbar 用例。
4. **测试假绿修复**：`terminal-selection-canvas` 的 COPY_SHORTCUT 原按 `process.platform` 选 Meta+C，但 e2e Desktop Chrome 的 UA 恒为 Windows（`isMacPlatform()`=false 要求 Ctrl+C）——此前靠 two-pane resize 抖动清选区碰巧通过；单 pane 化后暴露，已改为固定 `Control+C`（与浏览器 UA 一致）。产品代码在真实浏览器无问题。

## 第二轮迭代（用户修改意见，2026-07-02）

- **pane customName 链路**：`TmuxPane.customName`（wire optional）+ gateway `paneCustomNames` 内存 overlay（不写 tmux pane title，避免被应用 OSC 覆盖）+ `KIND_TMUX_RENAME_PANE`；重命名对话框复用窗口的（`RenameCandidate` 判别联合）。
- **move-pane 原语**：`KIND_TMUX_MOVE_PANE` + `movePane(src, dst, left|right|top|bottom)`（tmux `move-pane -h/-v [-b]`，local/ssh 双实现）。
- **侧栏**：多 pane 窗口行精简为「N 个 pane」（无标题/进程/窗口菜单），pane 行两行完整信息（customName||title + 进程@路径）；单 pane 窗口不变；pane 菜单与单 pane 窗口菜单集合一致（重命名/Agent 会话/newInCwd/分屏×2/Watch/关闭）。
- **全局去编号**：侧栏窗口 Badge 与 pane index、顶栏 `buildTerminalLabel` 的 `w/p:` 前缀、移动端 PaneSwitcherMenu 的 index 全部移除；标题优先展示 pane customName。
- **分屏 pane 标题栏 + 拖拽重排**：每 pane 24px 标题栏（角标+名称+进程@路径）；整窗 rows 换算按 `maxVerticalStackDepth` 扣除标题栏堆叠总高；拖动标题栏到目标 pane 四分区（`resolveDropPosition` 距最近边判定）重排，拖拽中半区高亮预览 + 浮动标签；实测左右布局拖成上下（layout `{...}`→`[...]`）。

## 遗留与后续可做

- 非焦点 pane 的渲染降帧（多实例功耗优化）——本期未做，有 TerminalPreview 先例可参考。
- 双端同看同一 window 时 last-writer-wins（移动端 stacked vs PC 布局互踩）为明示接受的语义，gateway 幂等跳过已缓解高频互踩。
- `splitSnapshotFields` 的 4/8/9 字段分支已无调用方（session 行仅剩 2 字段），可在后续清理。
