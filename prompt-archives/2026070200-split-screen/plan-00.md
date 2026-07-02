# 终端分屏（Split Screen）实现计划

## 背景

tmex 是基于 tmux 的 Web 终端（Bun monorepo：`apps/gateway` 后端 + `apps/fe` React 前端 + `packages/shared` 共享类型/borsh 协议 + `packages/ghostty-terminal` 自研终端渲染器）。当前整条链路建立在「每个 device 同一时刻只订阅/渲染一个 pane」的假设上：WS 层 `selectedPanes: Record<deviceId, paneId>` 单值过滤输出、前端单 Terminal 实例 + 单路选择状态机、resize 走整窗 `resize-window`。

本次要实现完整的分屏能力：

1. 基于 tmux window/pane 逻辑识别分屏终端（tmux `window_layout` 为布局真相源）。
2. resize 链路按分屏需求完全重设计。
3. PC（≥768px）上多 pane 按 tmux 布局渲染，splitter 可自由拖拽（tmux layout 树语义天然保证同组统一高/宽）。
4. Agent 对应具体 pane（**数据层已是 pane 级绑定**：`agent_sessions.paneId`、`watch_rules.paneId`，无需迁移；顺带修复 agent 通知深链缺 windowId 的问题）。
5. 手机/平板（<768px）单 pane 展示；多 pane window 时标题栏加「切换 pane」按钮弹出 pane 列表；移动端把 window 调整为「所有 pane 水平拼接」尺寸，每个 pane 恰好适配屏幕。
6. active pane 用**角标指示**（右上角小圆点/编号徽标，边框不变）——用户已确认。

用户已确认的决策：**前端提供 split 入口**；**断点沿用 768px**（现有 `useIsMobile`）；**active pane 用角标**。

## 执行前置（先存档，再干活）

1. 用 EnterWorktree 开新 worktree（用户明确要求在新 worktree 实现）。
2. 按 AGENTS.md 规则创建 `prompt-archives/2026070200-split-screen/`，存档 `plan-prompt.md`（用户原始需求 + 三项决策）与 `plan-00.md`（本计划），实现完成后补 `plan-00-result.md`。
3. 红线：**严禁触碰生产 tmex**（9883 端口、`~/Library/Application Support/tmex/`）；dev/e2e 在 worktree 起临时实例（dev 19663/19883，e2e 9885/9665）；测试自起临时 tmux session。

## 总体架构决策

1. **布局真相源 = tmux `#{window_layout}`**：快照新增 window 级 `layout` 字符串 + pane 级 `left/top`；共享解析器重建分割树；相邻 pane 间 1 col/row 的 tmux border 间隙正好渲染 splitter。
2. **订阅模型 = 焦点 pane（现有 `KIND_TMUX_SELECT`，走 switch-barrier/history）+ 附加订阅集（新 `KIND_TMUX_SUBSCRIBE_PANES`）**。移动端订阅集恒为空 → 完全复用现有单 pane 路径。非焦点 pane 首屏用新 `KIND_TMUX_FETCH_PANE_HISTORY`（16B token）+ 前端 per-pane 输出门控，**绝不进 switch-barrier 缓冲**（barrier flush 会按焦点 paneId 重编码，混入即错误归属，见 `switch-barrier.ts:316-328`）。
3. **resize 三分法**：
   - 单 pane window：保持现状（`KIND_TERM_RESIZE` → `resize-window`）不动。
   - PC 分屏：window 容器尺寸（cell size 换算 cols/rows）→ 复用 `KIND_TERM_RESIZE` 整窗语义；splitter 拖拽 → 新 `KIND_TMUX_RESIZE_PANE`（`resize-pane -x/-y` 绝对值，**pointerup 一次提交**，拖拽中只画 overlay 参考线，规避回弹）；layout 经 `%layout-change` → 快照回流刷新。
   - 移动端多 pane window：新 `KIND_TMUX_APPLY_STACKED_LAYOUT` → `resize-window -x (N*cols+(N-1)) -y rows` + `select-layout even-horizontal`（每 pane 恰好 cols×rows）。
4. **焦点模型**：URL paneId = 焦点 pane（不变）。分屏内切焦点走新 `KIND_TMUX_FOCUS_PANE` 轻量路径（select-window + select-pane，**无 barrier/history/reset**——不能复用 `selectPaneInternal`，它自带 history capture 会导致已渲染 pane 重放）。跨 window 或 pane 未订阅时才走完整 `KIND_TMUX_SELECT`。
5. **兼容性**：无需版本协商。同仓同发版，`PaneWireSchema` 加字段有先例（commit 142757b 加 `currentPath`）。`HelloS2C.capabilities`（现为 `['tmex-ws-borsh-v1','tmex-agent-v1']`，`ws/index.ts:448`）追加 `'tmex-split-v1'` 仅作调试标记。

## Phase 1：布局数据链路（snapshot → wire → domain）+ 共享 layout 解析器

**文件**：
- `apps/gateway/src/tmux-client/snapshot-format.ts`（+测试）— 新增共享行解析器
- `apps/gateway/src/tmux-client/local-external-connection.ts`（`requestSnapshotInternal :963`、`parseSnapshotWindows :1062`、`parseSnapshotPanes :1090`）
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`（`:927` 起镜像）
- `packages/shared/src/index.ts`（`TmuxPane :411` 加 `left?/top?: number`；`TmuxWindow :402` 加 `layout?: string`）
- `packages/shared/src/ws-borsh/schema.ts`（`PaneWireSchema :218` 加 `left/top: OptionU16Schema`；`WindowWireSchema :229` 加 `layout: OptionStringSchema`）+ `convert.ts` 双向补齐
- 新增 `packages/shared/src/tmux-layout.ts`（+测试）

**要点**：
- 快照 `-F` 字段序重排为「定长前置、自由文本后置」，行解析提取到 `snapshot-format.ts` 供 local/ssh 共用（顺带修复现有 pane 行 10 字段未被 `splitSnapshotFields` 特判、title 含 `|` 会整行失效的隐患）：
  - windows：`window_id|window_index|window_active|window_layout|window_name`（layout 字符集 hex/数字/`,x{}[]`，无 `|`，安全；name 末位整段 join）
  - panes（12 字段）：`pane_id|window_id|pane_index|pane_active|pane_width|pane_height|pane_left|pane_top|window_active|pane_title|pane_current_command|pane_current_path`（前 9 定长左锚 + 末 2 右锚 + title 中段 join）
- `tmux-layout.ts`：`parseWindowLayout(layout)` → `{checksum, root: TmuxLayoutNode}`；节点体 `WxH,X,Y`，叶子跟 `,paneNumId`（无 `%` 前缀的数字，映射回 `%${id}`）；`{}`=水平排列（row）、`[]`=垂直（column）；解析失败返回 null（前端回退单 pane 渲染）。

**验证**：layout 解析单测（单叶/嵌套/畸形串）；convert round-trip；title/path 含 `|` 的行解析单测。

## Phase 2：tmux 命令原语（local + ssh 双镜像，可与 Phase 1 并行）

**文件**：`device-session-runtime.ts`（接口 `:11` + facade `:54`）、`local-external-connection.ts`、`ssh-external-connection.ts`、`local-external-connection.integration.test.ts`

**新增接口**（facade 同步透传，local/ssh 两边必须同改）：
```ts
splitPane(paneId, direction: 'h'|'v', cwd?)   // split-window -h|-v -t %id -c <cwd ?? defaultWorkingDir> -P -F '#{pane_id}'
                                              // 用 -P 拿新 paneId → emit pane-active 事件 → 刷快照
resizePaneById(paneId, {cols?, rows?})        // resize-pane -t %id [-x] [-y] 绝对值，clamp ≥2，完成后刷快照
resizeWindow(windowId, cols, rows)            // 从现有 resizePaneInternal(:886/:848) 提取的窗口级原语
selectLayout(windowId, 'even-horizontal')     // select-layout -t @id even-horizontal
focusPane(windowId, paneId)                   // 轻量版：select-window + select-pane + emit pane-active + 刷快照，无 history/resize
capturePaneHistory(paneId): Promise<void>     // 公开现有私有方法（local:928），emit onTerminalHistory
```
现有 `resizePane(paneId, cols, rows)`（整窗语义）保持不动。

**验证**：仿现有 integration test 模式（真实 tmux 临时 session）：split 后快照多一 pane 且 layout 含两叶；`resizePaneById` 后同组另一 pane 互补变化；`selectLayout` 后等宽。

## Phase 3：WS 协议扩展 + 前端多路分发（依赖 1/2）

**文件**：`packages/shared/src/ws-borsh/kind.ts`、`schema.ts`；`apps/gateway/src/ws/index.ts`、`ws/borsh/codec-borsh.ts`；`apps/fe/src/ws-borsh/state-machine.ts`（+测试）、`message-builder.ts`；新增 `apps/fe/src/ws-borsh/pane-sink-registry.ts`；`apps/fe/src/stores/tmux.ts`；`apps/fe/src/components/terminal/Terminal.tsx`（`:357-459`）

**新消息**（0x020d–0x0212，全部 C2S）：
```
KIND_TMUX_SUBSCRIBE_PANES      {deviceId, paneIds: vec<string>}          幂等全量声明
KIND_TMUX_FETCH_PANE_HISTORY   {deviceId, paneId, requestToken: 16B}     回包复用 KIND_TERM_HISTORY（selectToken=requestToken）
KIND_TMUX_RESIZE_PANE          {deviceId, paneId, cols?: u16, rows?: u16}
KIND_TMUX_APPLY_STACKED_LAYOUT {deviceId, windowId, cols: u16, rows: u16}
KIND_TMUX_SPLIT_PANE           {deviceId, paneId, direction: u8, cwd?: string}
KIND_TMUX_FOCUS_PANE           {deviceId, windowId, paneId}
```

**Gateway 改造**（`ws/index.ts`）：
- `BorshClientState` 加 `subscribedPanes: Record<deviceId, Set<paneId>>`、`pendingHistoryFetches: Map<'deviceId:paneId', token>`。
- `broadcastTerminalOutput(:972)`：焦点 pane 走现有 barrier 路径；否则命中 `subscribedPanes` 直接发送（不进 barrier 缓冲）；都不是则跳过。`broadcastTerminalHistory(:1014)` 同理：焦点走 `switchBarrier.sendTermHistory`，否则命中 `pendingHistoryFetches` 用存储 token 直发并清 pending。
- 新 handler：`handleSubscribePanes`（校验 paneId 在 lastSnapshot 中，替换 Set）、`handleFetchPaneHistory`、`handleFocusPane`（更新 `selectedPanes` + `runtime.focusPane`）、`handleResizePaneById`、`handleApplyStackedLayout`（查 paneCount N → `resizeWindow(windowId, N*cols+(N-1), rows)` → `selectLayout('even-horizontal')`；**快照几何已匹配则跳过**，防高频互踩；clamp 总宽上限并告警）、`handleSplitPane`。
- `refreshSnapshotPolling(:121)` 驱动条件加 `subscribedPanes[deviceId]?.size`；断连清理（`:256/:585/:1154`）同步清两个新 map。

**前端改造**：
- 新 `pane-sink-registry.ts`：`registerPaneSink(deviceId, paneId, sink)`（sink = onReset/onApplyHistory/onOutput）+ `beginPaneHistoryGate`（缓冲该 pane 输出直到 history 应用，带超时兜底放行）+ `dispatchPaneOutput/dispatchPaneHistory`（token 匹配才应用）。
- `state-machine.ts`：全局 `SelectCallbacks` 单路改为经 registry 路由；`handleOutput(:323)` 不再丢弃非事务 pane 输出，改 `dispatchPaneOutput`。
- `Terminal.tsx :357-459`：`getSelectStateMachine(callbacks)` 覆盖机制（每次挂载覆盖全局回调，多实例互踩）替换为 `registerPaneSink` effect，卸载注销。
- `stores/tmux.ts` 新动作：`subscribePanes / fetchPaneHistory / focusPane / splitPane / resizePaneInWindow / applyStackedLayout`；`KIND_TERM_HISTORY` 分支先试 `dispatchPaneHistory`（fetch 路径）再走状态机（select 路径）。

**验证**：状态机单测（双 pane 并发路由、事务期间非事务 pane 输出不丢、history gate 顺序、token 不匹配丢弃）；此阶段结束移动端行为回归不变（订阅集为空）。

## Phase 4：PC 分屏渲染 SplitTerminalArea（依赖 1/2/3）

**文件**：新增 `apps/fe/src/components/terminal/SplitTerminalArea.tsx`、`splitLayoutGeometry.ts`（纯函数+单测）；`Terminal.tsx`、`types.ts`、`useTerminalResize.ts`；`DevicePage.tsx`（渲染分支 `:946-979`、远端尺寸回灌 `:658-687`、select effect `:402-418`）

**要点**：
- `TerminalProps` 加 `sizingMode?: 'report' | 'follow'`（默认 report 零变化）。follow 模式下 `useTerminalResize` 的 RO/window-resize/runPostSelectResize 均不上报（只本地 `term.resize` 对齐）；`TerminalRef` 加 `getCellSize()`。
- `SplitTerminalArea`：`parseWindowLayout` → `splitLayoutGeometry` 算每叶 px 矩形（layout 坐标 × cell size）绝对定位，每叶挂 `<Terminal sizingMode="follow">`；layout 缺失/解析失败回退渲染焦点 pane 单实例。
  - 订阅编排：effect 按 window.panes 发 `subscribePanes`，新非焦点 pane 发 `fetchPaneHistory`；切 window/卸载重置。
  - window 级 resize：容器 RO（150ms 防抖）→ cols/rows → 复用现有 `resizePane`（KIND_TERM_RESIZE 整窗语义）；`pendingWindowSize`（TTL 2s，思路同 `resizeSyncGuards.shouldApplyRemotePaneSize`）抑制回灌抖动。
  - splitter：在 layout 树 row/column 子节点边界生成 gutter（命中区 `max(cellW, 8px)`，Pointer 事件 + `setPointerCapture`，范式抄 `components/ui/sidebar.tsx:345 SidebarResizer`）；拖拽中 overlay 参考线，pointerup 提交 `resizePaneInWindow` 绝对值。
  - 焦点：pane 容器 `onPointerDownCapture` → `onUserSelectPane`；输入天然按各自 paneId（`KIND_TERM_INPUT` 已带 paneId）。
  - active 角标：焦点 pane 容器右上角 `absolute` 小圆点（`h-1.5 w-1.5 rounded-full bg-primary`）+ pane index 徽标。
- `DevicePage` 集成（最小侵入，**不动 `:463-655` 对账 effect 本体**）：
  - `isSplitView = !isMobile && panes.length > 1 && Boolean(window.layout)` 分支渲染 `SplitTerminalArea`，否则原单 Terminal 路径。
  - 分屏内切焦点：目标 pane 已订阅且同 window → 发 `focusPane` + navigate（`replace: true`），复用既有 `recordSelectRequest`/`userInitiatedSelectionRef` 序列；否则走完整 selectPane。
  - `:658-687` 远端尺寸回灌 effect 加 `if (isSplitView) return`。

**验证**：`splitLayoutGeometry` 单测；e2e：预置分屏 window 打开即呈现、切焦点无闪烁（无 reset 重放）、拖 splitter 后两侧 cols 互补、浏览器 resize 后整窗跟随。

## Phase 5：移动端（依赖 2/3，与 Phase 4 并行）

**文件**：`DevicePage.tsx`（`PageActions :1198`、`handleResize/handleSync :224-239`）；新增 `apps/fe/src/components/terminal/PaneSwitcherMenu.tsx`

**要点**：
- 拼接布局触发：`isMobile && panes.length > 1` 时，在进入 window / 切 pane / 尺寸变化三个时机 → 焦点 Terminal `calculateSizeFromContainer()` → `applyStackedLayout(deviceId, windowId, cols, rows)`；该场景下 `handleResize/handleSync` **改道** stacked-layout（不得发普通 TERM_RESIZE，否则整窗被压成单 pane 尺寸）。单 pane window 路径完全不变。互踩策略：仅为当前查看的 window 触发，双端同窗 last-writer-wins（可接受）。
- PageActions 切换按钮：`panes.length > 1` 时显示（ghost icon-sm，`Columns2` 图标 + 数字角标），DropdownMenu 列出每 pane（`#index title/currentCommand`、cwd basename、active 圆点、agent 状态点——agent store 已按 paneId 分组）；点击走与 sidebar `navigateToPane(:206)` 相同的完整切换（barrier/history，正确）。标题栏样式不变。
- 视口拉宽 ≥768 → `isSplitView` 翻转 → SplitTerminalArea 挂载 + 整窗 resize 自动恢复分屏。

**验证**：Playwright 390×844：按钮/列表/切换正确；`list-panes` 断言每 pane 宽=cols、window 总宽=N*cols+(N-1)；视口放大自动分屏。

## Phase 6：split 入口 + 顺带修复（依赖 2/3；UI 入口部分依赖 4）

**文件**：`sidebar-device-list.tsx`（pane 菜单 `:1285`）、`DevicePage.tsx`（PageActions 桌面态）、`SplitTerminalArea.tsx`（角标点击菜单）、`apps/gateway/src/agent/run.ts`（`:948`）、`apps/gateway/src/tmux/bell-context.ts`（复用 `resolvePaneContext :35`）、i18n 词条

**要点**：
- 三处入口（sidebar pane 菜单 / PageActions / pane 角标菜单）统一 `splitPane(deviceId, paneId, direction, cwd?)`，cwd 默认取该 pane `currentPath`（同 `newInCwd` 思路）；`right`→`-h`、`down`→`-v`。
- split 后跟焦：gateway 用 `-P` 拿新 paneId emit `pane-active` → 前端既有 `activePaneFromEvent` 对账自动 selectPane + navigate，无需新逻辑。
- 顺带修复：agent 通知用 `resolvePaneContext` 由 paneId 反查 windowId，使 `buildPaneUrl` 能生成 pane 深链。
- i18n 新词条改源文件后跑 `bun run build:i18n`，**生成的 resources.ts/types.ts 不手改不 lint**。

## Phase 7：端到端验收与回归

- 单元：全部新单测 + `bun test` 全量回归（重点 state-machine、snapshot-format、convert、switch-barrier）。
- 集成：subscribe 双 pane 输出并行到达、fetch-history token 路由、focus-pane 不触发 history、stacked-layout 幂等跳过。
- e2e 桌面 1280×800：预置 2-pane → 打开即分屏（截图）→ 切焦点 → 拖 splitter（前后 `pane_width` 断言）→ split down → 三 pane 布局。
- e2e 移动 390×844：切换按钮/列表/切换/拼接几何断言/放大自动分屏。
- 回归重点：**单 pane window 的 resize/切换/重连路径与主干行为逐条比对**（用户基数最大路径）。
- 视觉改动自行截图验收（Playwright），不甩给用户手动看。

## 依赖与并行

```
Phase 1 ──┐
Phase 2 ──┼─> Phase 3 ─> Phase 4 (PC UI)
          │        ├───> Phase 5 (移动端，与 4 并行)
          │        └───> Phase 6 (入口+修复，UI 部分等 4)
Phase 7 收尾
```

## 风险与规避（高风险项）

| 风险 | 规避 |
|---|---|
| DevicePage 对账 effects（:320-655）被扰动 | 不改本体；兄弟 pane 纯快照驱动；仅两处 `isSplitView` 分流 |
| switch-barrier flush 错误归属非焦点输出（`:316` 按 context.paneId 重编码） | 非焦点订阅 pane 输出永不进 barrier 缓冲 |
| 分屏内切焦点走完整 SELECT 导致 reset 重放 | 新 FOCUS_PANE 轻量路径绕开 barrier/history |
| splitter 回弹/与远端 layout 互踩 | 拖拽只 overlay 预览、pointerup 一次提交绝对值；layout 回流即真相 |
| 移动端 stacked-layout 与 PC 互踩 | 仅当前查看 window 触发 + gateway 几何匹配去重 + last-writer-wins 明示 |
| 多 ghostty 实例内存/性能 | 仅渲染当前 window 的 pane；有 TerminalPreview 多实例先例；e2e 加 6-pane 冒烟 |
| 快照行含 `\|` 破坏解析（既有隐患被字段变更放大） | 字段序重排（定长前置）+ 共享解析器 + 针对性单测 |
