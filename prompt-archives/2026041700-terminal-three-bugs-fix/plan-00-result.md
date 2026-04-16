# 三个终端/鼠标 Bug 修复执行结果

## 概述

按 `plan-00.md` 实施，修复了三个互相耦合的 bug：

1. **Bug 1**：vim `set mouse=a` 退出后，鼠标滚轮仍被当作 SGR 鼠标事件注入 pty。
2. **Bug 2**：opencode 等 bubbletea TUI 在刷新或切换 pane 后恢复的画面残缺。
3. **Bug 3**：点击 Sidebar「新建窗口」按钮没反应，控制台被注入 `0;1;12m`（SGR 鼠标释放事件残留）。

三者通过「WASM 鼠标 tracking 状态残留 → 全局 `mouseup` 监听误注入 pty」这条链条耦合在一起。

## 实施改动

### Bug 1：alt→primary 边沿清 mouse tracking

`packages/ghostty-terminal/src/terminal.ts`

- 抽出 `MOUSE_TRACKING_MODES = [9, 1000, 1002, 1003]` 常量。
- 新增私有 `clearMouseTrackingModes()`：逐个调 `setTerminalMode(..., false)`、`bindings.resetMouseEncoder(...)`、清空 `pressedMouseButtons`。
- 新增私有 `isAltScreenActive()` 读 `exportModeSnapshot()` 判断 alt screen 状态。
- `write(data)` 前后各读一次 alt screen 状态，在 `prev && !next` 边沿自动调用 `clearMouseTrackingModes()`。
  只做 alt→primary 边沿触发，不影响在 primary 上显式使用鼠标追踪的应用（如 htop）。
- `clearMouseTrackingModes` 暴露到 `CompatibleTerminalLike`。

`packages/ghostty-terminal/src/types.ts`

- `CompatibleTerminalLike` 新增可选方法 `clearMouseTrackingModes?: () => void`。

`apps/fe/src/components/terminal/Terminal.tsx`

- `reconcileRecoveredModes` primary 分支明确清理所有 mouse tracking bits（mouseX10/mouseNormal/mouseButton/mouseAny/mouseUtf8/mouseSgrPixels/mouseUrxvt），并顺带把 altScreen1047/1049 置 false（交给 VT preamble 驱动）。
- alt-screen 分支同样把 altScreen1047/1049 置 false。
- 删除 instance mount effect 里 `restoreModeSnapshot(cachedModes)`，让 mount 从 `reset()` 的干净状态开始。
- `createAlternateScreenFallbackSnapshot` 的 `altScreen1049` 改为 `false`，保持一致。

### Bug 2：alt-screen history 加 VT preamble 包裹

`apps/fe/src/components/terminal/normalization.ts`

- 新增 `ALT_SCREEN_HISTORY_PREAMBLE = '\x1b[?1049h\x1b[H\x1b[2J'`。
- 新增 `wrapAlternateScreenHistory(data)`：normalize 后拼 preamble。

`apps/fe/src/components/terminal/Terminal.tsx`

- `onApplyHistory` 分支：`alternateScreen` 时使用 `wrapAlternateScreenHistory`，否则仍用 `normalizeHistoryForTerminal`。
- `restoreModeSnapshot` → `instance.write(payload)` 的顺序维持不变（mouse 模式属全局，不受缓冲区切换影响）。

### Bug 3：mouseDragActive 守卫 + Sidebar 防御

`packages/ghostty-terminal/src/terminal.ts`

- 新增 `private mouseDragActive = false`。
- `selectSurface` 的 `mousedown` 监听：mouseReporting 分支和选区分支各自 emit / beginPointerSelection 时置 `true`。
- 全局 `window.mousemove` / `mouseup` 监听：入口判断 `mouseDragActive === false` 时直接 return。
- `mouseup` 清理 `mouseDragActive = false`。

`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

- 「New Window Button」加 `data-testid={`window-create-${device.id}`}`、`onPointerDown`/`onMouseDown` `stopPropagation` 作为附加防御层。

（注：最初误将附加防御加在了 `apps/fe/src/components/Sidebar.tsx`，但该文件并未被 `main.tsx` 引用（当前 app 实际使用 `AppSidebar` + `sidebar-device-list.tsx`）。已移除该文件的 stopPropagation，保留其他结构不变。）

### 测试新增

`apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`

- 开 vim `set mouse=a` pane，等 `alternate_on='1'`。
- 订阅 WebSocket `framesent` 过滤 `TERM_INPUT` 包，检测载荷是否包含 `\x1b[<`。
- 点击 `[data-testid="window-create-${deviceId}"]`，等待 `TMUX_CREATE_WINDOW` 发出。
- 断言没有任何 SGR 注入。

`apps/fe/tests/helpers/ws-borsh.ts`

- `KIND` 常量补充 `TMUX_CREATE_WINDOW: 0x0203`。

## 验证结果

### 类型检查

- `apps/fe`：`bunx tsc --noEmit` 绿，无错误。
- `packages/ghostty-terminal`：仅预先存在的 Bun 类型声明问题（`ghostty-wasm.ts` / `terminal.canvas.test.ts` 缺 `@types/bun`），与本次改动无关。

### Playwright e2e

| 测试文件 | 用例数 | 结果 |
|---|---|---|
| `tests/terminal-mouse-recovery.spec.ts` | 7 | 全绿（20.2s） |
| `tests/ssh-terminal-restore.spec.ts` | 3 | 全绿（14.9s） |
| `tests/sidebar-click-no-pty-injection.spec.ts`（新增） | 1 | 绿（5.2s） |

注：首次运行 `terminal-mouse-recovery` 时 `vim mouse modes survive pane round-trip navigation` 偶现 flake，单测重跑和全套重跑各绿一次，无代码层面回归。

### 环境提示

本机 9883 端口长期被 `~/Library/LaunchAgents/com.tmex.tmex.plist` 拉起的 tmex runtime 占用。测试时需设 `TMEX_E2E_FE_PORT=9884 TMEX_E2E_GATEWAY_PORT=9664 TMEX_E2E_DATABASE_URL=...`（后者触发 `forceFreshServers`），让 Playwright 走独立 vite，否则 HMR 不生效。

### 追加修复二：新建窗口后自动跳转

用户要求：新建窗口之后前端需要自动跳转到对应窗口。

实现：
- `apps/fe/src/stores/tmux.ts`
  - state 增加 `pendingCreateWindowAt: Record<string, number | undefined>`。
  - `createWindow` 发完 TMUX_CREATE_WINDOW 后写入 `Date.now()` 作为「等待跟随下一个 active 变化」的标记。
  - 新增 `clearPendingCreateWindow(deviceId)` action。
- `apps/fe/src/pages/DevicePage.tsx`
  - 新增 effect 订阅 `pendingCreateWindowAt[deviceId]` 与 `snapshotActiveSelection`。
  - 当 pending 活跃、snapshot 的 active window/pane 与 URL 不一致时，`recordSelectRequest` + `selectPane` + `navigate(replace:true)` 跳转。
  - 如果 snapshot active 还和 URL 一致（尚未收到新 snapshot），用 `setTimeout(TTL - elapsed)` 兜底清理，避免 pending 永远残留。
  - TTL 5000ms。

关键细节：写入 `userInitiatedSelectionRef` 以绕开 `shouldSkipSnapshotFollow` 里基于 route 的 pending 匹配——否则老 URL 的 `userInitiatedSelectionRef` 会把新 active 的 snapshot 判定为"应被跳过"。

验证：
- Playwright 直连 dev server：点击前 URL `@660/pane %1122`，点击后 URL 变为 `@661/pane %1123`，与 `tmux list-windows -t tmex` 显示的新 active window 一致。
- `sidebar-click-no-pty-injection.spec.ts` 仍绿（2.3s）。

### 追加修复：Bug 3 真实根因

实施完上述改动后用户反馈「新建窗口仍无反应」，用 Playwright 直连 dev 环境 observability 复现：
- 前端 `TMUX_CREATE_WINDOW` (kind `0x203`) 正常发出；
- 后端收到后调 `LocalExternalTmuxConnection.createWindow()` 执行 `tmux new-window`，但 **未带 `-t <sessionName>`**；
- gateway 进程未在 tmux 环境中运行（`$TMUX` 未设置），tmux 将该命令落到「最近一次被 attach 的 session」，本机最近被频繁 attach 的是 e2e 临时 session，于是新窗口被创建到错了的 session。

修复：`apps/gateway/src/tmux-client/local-external-connection.ts` 与 `ssh-external-connection.ts` 的 `createWindow()` 在 `new-window` 后补齐 `'-t', this.sessionName`，与 `closeWindowInternal` 里 `new-window -d -t sessionName` 的既有写法保持一致。

验证：重新跑 `sidebar-click-no-pty-injection.spec.ts` 绿；手测 `tmux list-windows -t tmex` 可见新增窗口，而非落到其它 session。

## 关键文件清单

修改：
- `packages/ghostty-terminal/src/terminal.ts`
- `packages/ghostty-terminal/src/types.ts`
- `apps/fe/src/components/terminal/Terminal.tsx`
- `apps/fe/src/components/terminal/normalization.ts`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
- `apps/fe/src/components/Sidebar.tsx`（改动被回滚，保留原始结构）
- `apps/fe/tests/helpers/ws-borsh.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`（追加修复一）
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`（追加修复一）
- `apps/fe/src/stores/tmux.ts`（追加修复二：pending follow）
- `apps/fe/src/pages/DevicePage.tsx`（追加修复二：自动跳转 effect）

新增：
- `apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`

## 后续遗留

1. `apps/fe/src/components/Sidebar.tsx` 当前未被引用，实际 app 使用 `AppSidebar`。建议下一次清理时考虑删除该遗留组件，避免继续误导（非本次 PR 职责）。
2. Bug 2 的 VT preamble 方案是启发式：在常见 bubbletea TUI 下肉眼对齐良好、回归测试通过，但极端多行 wrap 或宽字符场景可能仍需调整（可行后续策略见 plan-00 末尾「注意事项」）。
