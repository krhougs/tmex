# plan-00 执行结果

## 完成改动

### `apps/gateway/src/tmux-client/ssh-external-connection.ts`

1. **pane reader `onClose` 不再误报**（原 804-808 行）  
   `exit` 导致的 remote `cat $fifo` EOF 不再走 `onError`；改为：从 `paneReaders` 中删除、清理 remote FIFO、`requestSnapshot()` 让下一轮 `syncPipeReaders` 决定是否重开 reader。保留一行 `console.warn` 便于诊断。

2. **hook reader `onClose` 走 shutdown**（原 428-432 行）  
   tmux 远端 server 死/control channel 异常时，不再只 fire `onError` 然后卡住；改为 `void this.shutdownInternal(true)`，触发 `onClose` → `DeviceSessionRuntime.onClose` → `supervisor.handleClose` → 正常 reconnect。

3. **connect 成功清 `lastErrorType`**（152-157 行）  
   原只清 `lastError`；前端 `deviceErrors[id]` 徽标判定依赖 `lastErrorType` 存在，补上后 reconnect 成功徽标自动消失。

### `apps/gateway/src/tmux-client/local-external-connection.ts`

4. **connect 成功清 `lastErrorType`**（140-145 行）  
   与 SSH 侧对齐。local 的 pane reader 用 Bun.spawn + reader 循环，`chunk.done` 时静默 break，天然无误报，无需改动。

## 验证

- `bun test`（apps/gateway）：**125 pass / 0 fail / 283 expect / 25 files**
- `bunx tsc --noEmit`：仅残留 plan 执行前就存在的错误（supervisor.test never 推断、runtime-registry.test、telegram service 私有字段、ssh-auth ProcessEnv、runtime.ts 的 Server 泛型）。未引入新错误。

## 与 plan 的偏差

无。plan 里"可选加分项"第 5 条（pane 级错误不写 lastError）因为改动 1 天然避开，按计划不单独改 notifier。  
`supervisor.ts` 的 `onError` 按 plan 结论未动（底层分层自治：能继续 → 只 notify；不能继续 → shutdownInternal 触发 reconnect）。

## 追加修复：tmux server 死后卡 Connecting

用户验证时发现新症状：退出最后一个 pane 后 remote tmux server 退出，但 SSH 连接本身还活着，`tail -f $fifo` 的 hook reader 没 EOF，我们没检测到 server 已死，前端卡在 "Connecting..."。只有某次用户动作触发 strict `runTmux` 才抛 `no server running`，但此前代码只 `throw` 不 shutdown。

### 追加改动 — `apps/gateway/src/tmux-client/ssh-external-connection.ts`

5. **新增 `isTmuxServerGoneMessage`**（匹配 `no server running on` / `no sessions` / `lost server`）。
6. **`runTmux` 检测到 server gone**：在 `connected && !manualDisconnect` 条件下 `void this.shutdownInternal(true)` 再 throw。
7. **`requestSnapshotInternal` 检测到 server gone**：三条 `runTmuxAllowFailure` 任一失败且 stderr 命中时，写 lastError + `shutdownInternal(true)` + return（替代原来发 `session:null` 空快照）。

### 追加改动 — `apps/gateway/src/tmux-client/local-external-connection.ts`（用户反馈本地同样问题）

8. 原先 local 连接根本不 fire `onClose`（接口定义了但从未调用），本地 tmux server 死同样会卡死。新增 `closeNotified` / `cleanupPromise` 字段 + `shutdownInternal(notifyClose)` 助手（幂等：清 pane readers / hooks / fsPaths root，然后 `callbacks.onClose()` 触发上层 reconnect）。
9. `connect()` 开头 reset `closeNotified = false`。
10. 新增 `isTmuxServerGoneMessage` 助手（与 ssh 侧同义）。
11. `runTmux` 命中 server gone → `shutdownInternal(true)` 再 throw。
12. `requestSnapshotInternal` 三条 `runTmuxAllowFailure` 任一失败且 stderr 命中 server gone → 写 lastError + `shutdownInternal(true)` + return。

链路：`shutdownInternal(true)` → `callbacks.onClose()` → `DeviceSessionRuntime.terminated=true` + 广播 → supervisor / WS 两边 release runtime → registry refCount 归零槽位删除 → supervisor 的 `scheduleReconnect` 重新 acquire 建全新 runtime。

### 补坑 — session 死但 server 还在

Playwright 连 `http://127.0.0.1:19883/devices/{localId}` 调试发现：本地 tmux server 通常还活着，死的只是单独的 session（`tmux` 命令里其他 session 都健在）。此时错误文案是 `can't find session: tmex`，而不是 `no server running`。扩大 `isTmuxServerGoneMessage` 匹配：追加 `can't find session` / `session not found` / `no such session`（ssh + local 对齐）。

### 实测验证

`tmux kill-session -t tmex` 模拟 session 突然消失：页面打开时，WS 的初始 snapshot 立刻命中 → `shutdownInternal(true)` → supervisor `scheduleReconnect`（默认 10s）→ `ensureSession` 重建 `tmex` session → REST 回到 `tmuxAvailable:true, lastError:null, lastErrorType:null`，前端 Sidebar 从 "Connecting..." 变回正常 window/pane 列表。

`bun test` 125 pass / 0 fail；`bunx tsc --noEmit` 无新错误。

## 追加修复：跨 device 切换窗口终端空白

用户反馈：在 sidebar 点击另一个 device 的 window-item 切过去、再切回来时，终端显示空白（只保留原 URL，没有历史内容）。

### 根因

`apps/fe/src/pages/DevicePage.tsx` 的 "Select pane when ready" effect 用 `useTmuxStore.getState().selectedPanes[deviceId]` 做短路：若 store 里记录的 `{windowId, paneId}` 与当前 URL 一致，就跳过 SELECT_START。

问题在于：Terminal 的 React `key={deviceId}:${paneId}` 每次切设备都会触发 xterm 实例重挂载（新的空实例），但 store 里的 `selectedPanes[deviceId]` 是**全局持久**的——初次访问 SSH 时写入 `{@0, %0}` 后从不清空。

因此跨设备路径 SSH → LOCAL → SSH：
- 切回 SSH 时 URL 依然是 `/devices/SSH/windows/@0/panes/%0`，短路命中。
- Terminal 重挂载但没有 dispatch SELECT_START。
- 状态机未下发 `onResetTerminal / onApplyHistory / onFlushBuffer`。
- 终端空白。

局内切 pane 不受影响是因为 URL paneId 变了，短路失败。仅跨设备回切时 URL 三元组与上次一致才暴露。

### 改动

`apps/fe/src/pages/DevicePage.tsx:504-528`：去掉基于 store 的短路，改为 `lastDispatchedSelectRef`（`${deviceId}:${windowId}:${resolvedPaneId}` 作 key），并在 `useEffect([deviceId, resolvedPaneId])` 里清空 ref。Terminal 重挂载（deviceId 或 paneId 变）→ ref reset → 下一次 effect 重新 dispatch。snapshot 连续刷新导致 effect 重跑时 ref 匹配，不会重复 dispatch。

### 实测验证

Playwright 脚本 `debug-cross-device-switch.ts`（修完已删除）模拟 SSH → LOCAL → SSH → LOCAL → SSH 多轮跨切：

修复前：
- B1 (SSH→LOCAL) 显示 OpenCode UI ✓
- B2 (LOCAL→SSH) 终端空白 ✗
- C1 / C2 全部空白 ✗

修复后：
- B1 / B2 / C1 / C2 均有内容（B2、C2 显示 `root@dns:~#` 提示符）✓

`bun test`（gateway）125 pass / 0 fail；`bun test src/`（fe）23 pass / 0 fail；`bunx tsc --noEmit -p apps/fe/tsconfig.json` 无错误。

## 流程合规

- `prompt-archives/2026041801-ssh-pane-exit-false-error/`：plan-prompt / plan-00 / plan-00-result 三件齐全
- 符合"先存档，再干活"约定
