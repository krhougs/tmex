# plan-00 执行结果

## 完成范围

按 plan-00.md 把 SSH 认证错误专用的告警（log + tgbot）整体拓展到全类型 SSH 连接错误，前端补齐常驻徽标与刷新存活。

## 后端改动

### 新增

- `apps/gateway/src/push/connection-alerts.ts` — 统一连接告警器 `ConnectionAlertNotifier`
  - `classifySshError → persist(updateDeviceRuntimeStatus) → broadcast(WS) → throttled telegram`
  - 节流 key = `${deviceId}:${errorType}`，TTL 5 分钟，类型切换立即再发
  - 依赖注入：`setBroadcaster` / `setSettingsProvider` / `setPersister` / `setTelegramSender`
  - 导出单例 `connectionAlertNotifier`
- `apps/gateway/src/push/connection-alerts.test.ts` — 6 条测试：
  1. 分类 + persist + broadcast + telegram 同时生效
  2. 同 `deviceId:errorType` 5 分钟节流（3 次调用 → 1 条 tg）
  3. errorType 切换立即重发
  4. 不同 deviceId 各自独立节流
  5. `silentTelegram` 只抑制 tg，persist/broadcast 仍执行
  6. `ssh_connection_closed` 哨兵字符串分类为 `connection_closed`

### 改动

- `apps/gateway/src/ws/error-classify.ts` — 新增 `connection_closed` 分类，识别 `ssh_connection_closed` / `connection closed` / `channel closed` / `ssh command channel not ready` / `ssh connection not ready`
- `apps/gateway/src/ws/index.ts` — 新增 public `broadcastDeviceError(deviceId, payload)`，供 push supervisor 侧绕过 WsServer 内部的 `broadcastError` 私有方法
- `apps/gateway/src/runtime.ts` — 启动时 `connectionAlertNotifier.setBroadcaster(...)` 接到 `wsServer.broadcastDeviceError`，stop 时解绑
- `apps/gateway/src/push/supervisor.ts` —
  - 删除 `isSshAuthError` / `notifySshAuthFailure` / `sshAuthNotifyMap` / `SSH_AUTH_NOTIFY_THROTTLE_MS` / `telegramService` 导入
  - `connectEntry` 捕获 → `notify({source: 'connect'})`
  - `runtime.subscribe` 的 `onError` → `notify({source: 'runtime'})`
  - `handleClose` 扩签到 `(device, reason)` → 用 `new Error('ssh_connection_closed')` 触发 `notify({source: 'close'})`
- `apps/gateway/src/tmux-client/ssh-probe.ts` — bootstrap-failed 返回点与 catch 均调 `notify({source: 'probe', silentTelegram: true})`
- `apps/gateway/src/tmux-client/local-external-connection.ts` — 把原来的 `updateDeviceRuntimeStatus` 失败路径重构为 `notifyRuntimeError(message)`（读设备 → 静默调 notifier）
- `apps/gateway/src/api/index.ts` — 新增 `enrichDeviceWithRuntime`，`GET /api/devices` 与 `GET /api/devices/:id` 响应 merge `lastSeenAt` / `lastError` / `lastErrorType` / `tmuxAvailable`，保证前端刷新后能复原徽标

### 数据模型

- `packages/shared/src/index.ts` — `DeviceRuntimeStatus.lastErrorType: string | null`
- `apps/gateway/src/db/schema.ts` — `device_runtime_status` 表加 `last_error_type text`
- `apps/gateway/drizzle/0003_glamorous_lizard.sql` — 对应 ADD COLUMN 迁移
- `apps/gateway/src/db/index.ts` — `createDevice` 初始化、`getDeviceRuntimeStatus` 空行兜底与行映射、`updateDeviceRuntimeStatus` 参数均同步新字段

### i18n

- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`：
  - 删除 `telegram.deviceSshAuthFailed`
  - 新增 `telegram.deviceConnectionError`（参数 `{siteName, deviceName, host, category, error}`）
  - 新增 `sshError.connectionClosed`
  - 新增 `deviceStatus.reconnecting`（参数 `{delay}`）、`deviceStatus.offline`、`deviceStatus.errorBadge.{authFailed,agentUnavailable,agentNoIdentity,configRefNotSupported,networkUnreachable,connectionRefused,timeout,hostNotFound,handshakeFailed,tmuxUnavailable,connectionClosed,unknown}`
- 执行 `bun run build:i18n` 重建 `resources.ts` / `types.ts`

## 前端改动

### 新增

- `apps/fe/src/components/device-status-badge.tsx` —
  - 订阅 `deviceReconnecting` + `deviceErrors`
  - reconnecting 优先：amber + `RefreshCcw animate-spin`
  - error：red + `AlertCircle`，label 走 `deviceStatus.errorBadge.*`，title 聚合 label/message/rawMessage

### 改动

- `apps/fe/src/stores/tmux.ts` —
  - `DeviceError` 扩为 `{message, type, rawMessage?, at}`
  - 新增 `deviceReconnecting: Record<string, DeviceReconnecting | undefined>`
  - `handleDeviceEvent`：`reconnecting` 事件只更新 reconnecting 状态不 toast；其余错误仅在**类型切换或首次**时 toast；收到 `reconnected` / `KIND_DEVICE_CONNECTED` 清两者
  - 新增 `hydrateDeviceErrors(entries)`：REST 列表回来时种初始错误态（已被 WS 写过的不覆盖）
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx` — 从 REST 返回字段 hydrate errors；设备头部插入 `<DeviceStatusBadge/>`
- `apps/fe/src/pages/DevicesPage.tsx` — 同上 hydrate + 卡片徽标

## 验证

- `bun test`（apps/gateway）：**125 pass / 0 fail / 283 expect / 25 files**，含新增 6 条 connection-alerts 测试
- 前端 `tsc --noEmit`：干净
- 后端 `tsc --noEmit`：残留错误均为本次改动前就存在（runtime-registry.test、supervisor.test 的 never 推断、ssh-auth ProcessEnv、telegram Updates.offset），未引入新错误

## 与 plan 的偏差

- `deviceReconnecting` 实际承载 `{message: string, at: number}` 而非 plan 里写的 `{attempt, maxRetries, delaySec, scheduledAt}`。原因：supervisor 广播的是已 i18n 渲染好的 `reconnecting` 文案，前端不再重复拼接结构化字段更简洁；如后续需要重连进度条再回填结构化字段即可。
- probe 通知改走 `silentTelegram: true` 同时 `persist: true`（默认），与 plan 描述一致；local runtime 错误也按相同策略：静默 tg + 持久化 + 广播，避免 local 设备误触发群发。

## 流程合规

- 先在 `prompt-archives/2026041800-ssh-error-unified-alerts/` 存档 `plan-prompt.md` / `plan-00.md`，再开始代码改动
- 本文件为最终执行总结，符合 AGENTS.md "先存档，再干活 + 完成后写 result" 要求
