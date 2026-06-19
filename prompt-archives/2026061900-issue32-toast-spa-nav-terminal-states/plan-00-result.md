# 执行结果

分支：`worktree-issue32-toast-spa-nav-terminal-states`（git worktree）。

## Fix A（issue #32）：toast/通知改 SPA 导航

- 新增 `apps/fe/src/lib/app-navigation.ts` 的 `navigateToAppUrl(url)`：
  - `toAppPath()` 先用 `new URL(url, window.location.origin).pathname` 抽取路径——服务端 `paneUrl` 是带 origin 的**绝对 URL**（`${siteUrl}/devices/...`，siteUrl 可能是 loopback，正是 #32 根因），抽 pathname 后既能命中 pane 正则、又确保导航到当前 origin 的同路径，彻底摆脱 siteUrl 污染。
  - pane 路由 → dispatch `tmex:user-initiated-selection`（`paneId` 经 `decodeURIComponent` 还原为原始值，与 sidebar `navigateToPane` 一致）+ `bridgeNavigate(path,{replace:true})` + `bridgeCloseMobileSidebar()`。
  - 非 pane 路由（降级 `/devices/:id`、`/settings` 等）→ 只导航，不 dispatch。
- `flow-bridges.ts` 补对称的 `bridgeCloseMobileSidebar()`。
- 替换 4 处 `window.location.href`：`watch-events-init.tsx`（Notification.onclick / toast action）、`stores/tmux.ts`（bell / notification toast action）。
- 单测 `app-navigation.test.ts`（6 例）：pane(含 `%251`→`%1` 解码)、降级 `/devices/:id`、非移动端不关 sidebar、**服务端绝对 loopback URL 抽 pathname**、尾斜杠不匹配、`/settings` 非 pane。

## Fix B：终端 not-found / loading / 重连状态（`DevicePage.tsx`）

- 新增 `deviceReconnecting` / `hasConnectIntent`(`connectedDevices.has`) selector。
- not-found 文案改用现成 i18n key `terminal.windowClosed` / `terminal.paneClosed`（原为泛化 `wsError.checkGateway`）。
- 渲染门控重排：`showTerminal = resolvedPaneId && !isSelectionInvalid && (deviceConnected || isReconnecting)`——**重连时保持 Terminal 挂载，xterm 不卸载、已有内容可见**。三分支：not-found(`SearchX`+message) / Terminal / 空状态。
- 两 overlay（移进 relative 内层容器）：`isReconnecting` → 非遮挡顶部居中复用 `<DeviceStatusBadge/>`（`pointer-events-none z-10`）；`isResolvingSnapshot` → 遮罩 spinner。
- 删除旧的全屏 `showConnecting`(`!deviceConnected && !deviceError`) backdrop-blur 遮罩（它对已断开设备会永久转圈）。
- `isConnecting = hasConnectIntent && !deviceConnected && !deviceError && !isReconnecting`：初次连接显示「连接中」spinner 而非误导性「已断开」，且因走连接意图集合不会对显式断开的设备永久转圈。

## 对抗式 review（多智能体 workflow）

7 findings → 3 confirmed / 4 rejected（rejected 含「`&& resolvedPaneId` 冗余」——经验证它是 TS 收窄必需，证明保留正确）。3 个 confirmed 全部已修：
1. 服务端绝对 URL 不匹配正则 → 抽 pathname 修复（本次最关键，直接关系 #32）。
2. 初次连接丢失 loading 反馈 → `isConnecting`（连接意图）修复，且不重蹈旧「死设备永久转圈」bug。
3. 测试边界缺失 → 补 3 个用例。

## 验证

- `bun test apps/fe/src`：87 pass / 0 fail（含 6 个新 app-navigation 用例）。
- `tsc --noEmit`（apps/fe）：通过。
- `biome check` 改动 6 文件：仅剩 1 个 **pre-existing** `useExhaustiveDependencies`（`DevicePage` 的 `lastDispatchedSelectRef` effect，HEAD 即有、非本次改动行、且为有意行为不可改），本次 diff 零新增 lint。
- worktree 需 `bun install --frozen-lockfile`（per-workspace node_modules，worktree 初始无）。

## 未覆盖 / 限制

- 重连态的实时视觉（终端内容保留 + 琥珀 badge）需真实设备断连触发，本环境不便安全驱动（生产 9883 禁碰、e2e harness flaky）；not-found 态可经 `/devices/<id>/windows/BOGUS/panes/BOGUS` 直接复现。逻辑经单测 + 类型 + 对抗 review 覆盖。
- Fix B 重连后冷重建重发 history 可能叠加（#31 固有），本次只保证重连期间内容不消失。
