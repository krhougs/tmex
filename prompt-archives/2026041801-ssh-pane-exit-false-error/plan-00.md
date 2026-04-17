# SSH pane 正常退出误报 + runtime 级错误无法恢复 修复

## Context

用户报：在 SSH device 里一个终端 pane 主动 `exit` 之后，该设备"再也连不上了"，前端一直显示 `SSH pane reader closed unexpectedly: %2`。

联调代码发现三个层叠问题：

1. **pane reader 误报**：remote 端我们用 `cat $paneFifo` 读 `pipe-pane` 的输出。当 pane `exit` 时 tmux 停止 `pipe-pane` 写入，remote `cat` 立即 EOF，ssh 的 reader channel `onClose` 触发。`startPipeForPaneNow` 里的 `onClose` 看到 `paneReaders.has(paneId)` 仍为 true（因为 `syncPipeReaders` 还没在下一个快照周期清理），就把它当成异常，喊 `onError('SSH pane reader closed unexpectedly: %2')`。**这是正常退出，不是故障**。  
   `apps/gateway/src/tmux-client/ssh-external-connection.ts:797-809`

2. **成功重连清不掉 lastErrorType**：`ssh-external-connection.ts:152-156` 和 `local-external-connection.ts:140-144` 在 connect 成功时只清 `lastError`，没清 `lastErrorType`。前端 `deviceErrors[id]` 靠 REST `lastErrorType` 判断，导致红色徽标无法自动消失。

3. **runtime 级错误不触发 reconnect**：上一轮把 `supervisor.ts:244-251` 的 `onError` 统一改成 `connectionAlertNotifier.notify(...)`，只写库/广播/tg，没触发 `teardown + scheduleReconnect`。举例：tmux 远端 server 挂了 → `startHooks` 的 hook reader channel 关闭 → `onError('SSH hook reader closed unexpectedly')`；但 SSH 客户端还活着，不会触发 `client.on('close')`，于是 supervisor 永远不 reconnect，runtime 卡在"有错但不重连"。用户感知的"再也连不上"主要是这条。  
   `apps/gateway/src/tmux-client/ssh-external-connection.ts:428-432`（hook reader onClose → onError）  
   `apps/gateway/src/push/supervisor.ts:244-251`（onError 只 notify）

## 修复方案

### 1. pane reader `onClose` 不再视为故障

改 `apps/gateway/src/tmux-client/ssh-external-connection.ts:804-808`：

- 不再走 `onError`。
- 从 `paneReaders` 里把自己删掉（释放 map 槽，避免下次 syncPipeReaders skip）。
- 调 `this.requestSnapshot()`。下一次 snapshot 周期触发 `syncPipeReaders`：如果 pane 仍在 expected 列表（说明是意外断流而不是 pane 退出），`startPipeForPaneNow` 会自动重开 reader；如果 pane 已不存在，静默结束。
- 用 `console.warn` 记录一行（保留诊断能力，但不污染 lastError）。

`local-external-connection.ts` 里如果有对应 pane reader 关闭逻辑同步对齐（扫一下确认是否有相同路径）。

### 2. 成功 connect 时一并清 `lastErrorType`

- `apps/gateway/src/tmux-client/ssh-external-connection.ts:152-156`：`updateDeviceRuntimeStatus({... lastError: null, lastErrorType: null })`。
- `apps/gateway/src/tmux-client/local-external-connection.ts:140-144`：同上。

前端依赖 `lastErrorType` 存在才展示红色徽标，此改动让 reconnect 成功后徽标自动消失。

### 3. hook reader 断开必须走 shutdown → reconnect

改 `apps/gateway/src/tmux-client/ssh-external-connection.ts:428-432`（hook reader 的 `onClose`）：  
- 非 `manualDisconnect` 下走 `void this.shutdownInternal(true)`（等价于 SSH client 断开的处理）。
- 继续保留一次 `console.error` 记录原因。  
这样 hook reader 断开会触发 `onClose` → `DeviceSessionRuntime` 往上传 → `supervisor.handleClose` → `scheduleReconnect`。

### 4. supervisor.onError 兜底

改 `apps/gateway/src/push/supervisor.ts:244-251`：当前 onError 只通知。保留通知逻辑，但对"致命/不可继续使用"类型的错误额外触发 teardown+reconnect。

实际落地最简洁的做法：**让底层连接层自己决定 onError / onClose 的语义，supervisor 不做二次判断**。即：
- 底层如果能继续运行，只发 onError（如单个 pane 读失败但 session 仍在）；  
- 如果不能继续，在内部调用 `shutdownInternal(true)` → 触发 onClose；supervisor 的 `handleClose` 自动重连。

本次改动 1 和 3 正好达成这一分层。**supervisor.onError 保持只通知，无需再加兜底**。

### 5. （可选、加分项）pane 级错误不应写入 lastError

pane reader 的临时故障不该污染 device 级 `lastError`。当前 `connectionAlertNotifier.notify` 写所有 source='runtime' 的错误到 lastError。改动 1 让 pane reader 不再走 onError，天然避开这个问题。无需单独改 notifier。

## 文件清单

| 文件 | 改动 |
|------|------|
| `apps/gateway/src/tmux-client/ssh-external-connection.ts` | pane reader onClose 改为静默 + requestSnapshot；hook reader onClose 走 shutdownInternal；connect 成功清 lastErrorType |
| `apps/gateway/src/tmux-client/local-external-connection.ts` | connect 成功清 lastErrorType；如有等价 pane reader 路径对齐 |

不动 `supervisor.ts`、`connection-alerts.ts`、前端、i18n、DB。

## 验证

1. **单元测试**：  
   - 现有 `connection-alerts.test.ts` / `supervisor.test.ts` 不受影响，跑一遍 `bun test` 确认 green。  
   - 如时间允许，给 `startPipeForPaneNow.onClose` 路径补一个轻量测试，验证 close 后不 fire onError、paneReaders 被清空、requestSnapshot 被调。

2. **手动复现**：  
   - 用远端 ssh device，打开终端，敲 `exit` 退出当前 pane（也是唯一 pane）→ 预期：前端不再弹红色徽标"pane reader closed unexpectedly"；session 被 tmux 自然结束后，push supervisor 走正常的 `handleClose → scheduleReconnect` 路径重建 session。  
   - 多 pane：只 `exit` 其中一个 → 其他 pane 不受影响，红色徽标不出现。  
   - 远端手动 `tmux kill-server` → 触发 hook reader 断开 → 走 shutdownInternal → supervisor 自动 reconnect，徽标短暂闪现后 connect 成功自动清除。

3. **回归**：  
   - 认证失败/网络不可达等真·连接错误仍照常写 lastError + 徽标 + telegram。  
   - `bunx tsc --noEmit -p apps/gateway/tsconfig.json` 不引入新错误。

## 存档

按 AGENTS.md"先存档，再干活"：  
- 新建 `prompt-archives/2026041801-ssh-pane-exit-false-error/plan-prompt.md`（存本轮 prompt：用户关于 `exit` 退出后 device 再也连不上 + `SSH pane reader closed unexpectedly: %2` 的原话）  
- `plan-00.md`（复制本 plan 落盘）  
- 实施完成后补 `plan-00-result.md`
