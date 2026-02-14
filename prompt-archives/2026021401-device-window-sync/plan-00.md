# 计划：设备列表/终端窗口同步修复（FE 为主，必要时改 Gateway）

## 摘要

修复 4 个问题的根因是：前端当前选中 window/pane 只由 URL 驱动，并且仅在 URL 变化时向网关发送 `tmux/select`；当 tmux 在“外部”切换 active window/pane（包括在网页终端里按快捷键切换、或 iTerm2/其他客户端切换）时，前端既不会更新 URL，也不会更新 WebSocket 的输出订阅（网关按“客户端选中 pane”过滤输出），导致看起来“不会自动切换/手动切换不工作/新建窗口不跳转”。另外，终端页刷新时在 `deviceConnected=true` 但 `snapshot.windows` 尚未到达的窗口期误跳转到 `/devices`。

本计划按需求：仅在“同一设备 deviceId”下跟随外部 active 变化；设备列表同时表达“tmux active（白色小点）”与“网页终端当前选择（高亮）”。

## 必做变更（接口/行为）

### 1) 前端消费 `event/tmux` 的 `pane-active`，驱动 URL 跳转与订阅切换

- 新增 FE store 状态：
  - 在 `apps/fe/src/stores/tmux.ts` 增加 `activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>`。
- 在 WebSocket `onmessage` 里处理：
  - `msg.type === 'event/tmux'` 时：
    - 保留 `bell` 分支。
    - 对 `payload.type === 'pane-active'` 做类型守卫，解析 `data` 为 `{ windowId, paneId }`，写入 `activePaneFromEvent[deviceId]`。
- 在终端页跟随：
  - 在 `apps/fe/src/pages/DevicePage.tsx` 增加一个 effect：
    - 监听当前 `deviceId` 对应的 `activePaneFromEvent`。
    - 若 event 的 `deviceId` != 当前路由 `deviceId`：忽略。
    - 若 event 的 `{ windowId, paneId }` 与当前 URL 的 `{ windowId, resolvedPaneId }` 不一致：
      1. 先触发一次 `selectPane(deviceId, windowId, paneId)`（确保网关/客户端输出过滤切到新 pane）。
      2. `navigate(nextUrl, { replace: true })`（自动跳转用 replace，避免堆 history）。
- 避免重复 select（去抖/幂等）：
  - 在 `DevicePage.tsx` 的 “Select pane when ready” effect 内增加短路：
    - 若 `useTmuxStore` 里当前 `selectedPanes[deviceId]` 已经等于 URL 的 `{ windowId, paneId }`，则不再发送 `tmux/select`。
  - 在 `pane-active` 跟随 effect 里用 ref 记录 lastHandled `{ windowId, paneId }`，避免同一事件重复处理。

### 2) 以 snapshot 的 active 作为兜底（防止部分环境不产出 pane-active 事件）

- 在 `apps/fe/src/pages/DevicePage.tsx` 再加一个 effect（兜底）：
  - 当 `snapshot.session.windows` 更新后，计算 activeWindow/activePane。
  - 用 `lastActiveRef` 判断 active 是否发生“变化”（active 未变化时不跟随，避免在用户刚点选 URL、但 tmux 尚未切换的窗口期被强行拉回）。
  - active 变化且与当前 URL 不一致时：按自动跳转逻辑 `selectPane + navigate(replace)`。

### 3) 修复“终端页刷新跳默认页”

- 修改 `apps/fe/src/pages/DevicePage.tsx` 的 “Handle window/pane changes” effect：
  - 将 `if (!windows || windows.length === 0) navigate('/devices')` 拆分为：
    - `if (!windows) return;`（snapshot 未到达视为加载中，禁止跳转）。
    - `if (windows.length === 0) navigate('/devices', { replace: true }); return;`。

### 4) 设备列表：明确区分 tmux active 与网页终端选择

- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`：
  - 保持“高亮选择”仍然只由 URL（`selectedWindowId/selectedPaneId`）决定。
  - 将表示 tmux active 的小点样式改为“白色/前景色系”（例如 `bg-foreground/80`），避免与“选择高亮”的 primary 语义混在一起。
  - pane 的 active 小点同理（tmux active 用前景色，URL 选中用 primary 高亮）。

## （可选）Gateway 小改动（仅当验证后仍有延迟/偶现不触发）

如果发现 tmux 切换后 `pane-active` 事件不稳定或 snapshot 更新不及时，再做：

- `apps/gateway/src/tmux/connection.ts`：
  - 在 `selectWindow()`、`selectPane()` 末尾补 `this.requestSnapshot()`（或 schedule 一个短延迟 request），保证切换后 snapshot 更快刷新。

该改动不影响协议，但会增加少量 tmux 命令频率，需要在验收时观察性能。

## 测试计划（E2E，覆盖 4 个问题）

在 `apps/fe/tests/` 新增或扩展 Playwright 用例（复用现有 `routeWebSocket('/ws')` 模式）：

1. 外部切换后自动跟随：
- 打开 `/devices/:deviceId/windows/w0/panes/p0`。
- WS stub：
  - 收到 `device/connect` 回 `device/connected`。
  - 回一个包含 `w0/p0` 与 `w1/p1` 的 `state/snapshot`（`w0/p0` active）。
  - 然后发送 `event/tmux`：`{ type: 'pane-active', data: { windowId: 'w1', paneId: 'p1' } }`。
- 断言：`page.url()` 最终变为 `/devices/:deviceId/windows/w1/panes/p1`。

2. 浏览器里用 tmux 快捷键切换不再“卡住”：
- 同用例 1（本质就是 `pane-active` 到达时 URL+订阅跟随）。

3. 新建窗口后自动跳转：
- WS stub 发送 `event/tmux` 的 `window-add` + `pane-active`（或直接 `pane-active` 到新 pane）。
- 断言：自动跳转到新 window/pane。

4. 终端页刷新不跳默认页：
- WS stub：`device/connected` 立即发送，但 `state/snapshot` 延迟 200-500ms 才发送。
- 断言：在 snapshot 到达前，URL 不应从 `/devices/:id/windows/.../panes/...` 变成 `/devices`。

运行命令：
- `bun run --filter @tmex/fe test:e2e`

## 归档与执行顺序（符合 AGENTS.md，“先存档再干活”）

1. 先存档（执行实现前必须做）：
- 在 `prompt-archives/2026021401-device-window-sync/` 写入：
  - `plan-prompt.md`：包含本次用户原始需求 + 后续补充。
  - `plan-00.md`：本计划内容。
2. 实现代码（按上面 1-4 顺序）。
3. 验证：
- 先跑 `bun run --filter @tmex/fe test:e2e`。
- 需要时再跑 `bun test`（全仓）。
4. 结果归档：
- `prompt-archives/2026021401-device-window-sync/plan-00-result.md`：记录改动点、验证结果、如有 gateway 变更也注明。

## 验收标准（逐条对齐需求）

1. 外部切换窗口后：网页终端 URL 与设备列表高亮自动切到对应 window/pane，终端输出不中断。
2. 浏览器中通过 tmux 快捷键切换：同上。
3. 新建窗口后：自动跳到新 active window/pane。
4. 终端页刷新：停留在原 `/devices/:deviceId/windows/:windowId/panes/:paneId`，不再跳 `/devices`。
