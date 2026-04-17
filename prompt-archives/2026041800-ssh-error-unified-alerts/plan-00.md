# SSH 错误全链路告警：log + tgbot + 前端常驻徽标

## 执行顺序（项目强制：先存档再干活）

批准本 plan 后**第一步**即建立 prompt-archives：
- 目录 `prompt-archives/2026041800-ssh-error-unified-alerts/`
- `plan-prompt.md`：存本轮 + 前一轮相关的用户 prompt 原文（"帮我看看本地部署的版本为什么一直在重启" / "直接在当前分支按照你的'长期修复'来修 ..." / "网络问题导致ssh连接失败/断线是怎么处理的？" / "ssh auth error 相关的错误提示...所有ssh error都应该这么处理 / 前端对应的逻辑也得处理好"），并简述上下文
- `plan-00.md`：把本 plan 文件原样复制过去（作为本仓库可提交的存档）
- 实施完成后再建 `plan-00-result.md` 写执行结果总结

后续所有代码改动必须在存档落盘后才开始。

## Context

上一轮只对 SSH **认证失败** 加了日志前缀 + Telegram 通知（`supervisor.ts` 的 `isSshAuthError` + `notifySshAuthFailure`），其他类型错误（网络不可达、连接被拒、超时、host 不存在、握手失败、tmux 不可用、已连接后掉线等）均未纳入通知体系，且前端只有 toast（一次性）+ sidebar 小圆点（二态 online/offline），刷新后错误信息全丢。

本次把范围扩到**所有 SSH/连接错误**，覆盖：
- push supervisor 的 `connectEntry` 初始连接失败
- 已连接后的 `client.on('error')` / `client.on('close')` / `commandStream.on('close')`（当前完全不经分类、不发 tg）
- `ssh-probe` 探活
- `local-external-connection` 的本地 tmux 错误

前端同步升级为设备卡片常驻错误徽标：即便刷新页面，只要 `DeviceRuntimeStatus.lastError` 仍在，仍能看到分类化的错误信息与重连倒计时。

## 复用的既有能力（不重造）

- **错误分类器** `apps/gateway/src/ws/error-classify.ts:1-91` — `classifySshError(error)` 返回 `{type, messageKey, messageParams?}`，12 类，正好覆盖 `sshError.*` 整套 i18n key。用来替代本次第一版的 `isSshAuthError`。
- **WS 广播** `apps/gateway/src/ws/index.ts:857-873` — `broadcastError(deviceId, err)` 已在内部调用 `classifySshError` 并经 `KIND_DEVICE_EVENT` 推前端；前端 `apps/fe/src/stores/tmux.ts:140-146` 已消费并写 `deviceErrors[id]`。只需让 push supervisor 能复用这条通道。
- **DeviceRuntimeStatus 写入** `updateDeviceRuntimeStatus` — 已有多个调用点（ssh-external-connection.ts:152/297/360/893, local-external-connection.ts:139/798），统一扩展 lastError 为"分类后友好消息"。
- **Telegram** `telegramService.sendToAuthorizedChats({ text })` — events/index.ts 已在用，push 通道直接复用。
- **i18n `sshError.*`** `packages/shared/src/i18n/locales/*.json` — 12+ 分类 key 已有；不为 telegram 每类写独立模板，通用模板 + 分类名注入。

## 后端改动

### 1. 新增：统一连接告警模块
**新文件** `apps/gateway/src/push/connection-alerts.ts`

```ts
// 核心接口（示意）
export interface ConnectionAlert {
  device: Device;
  error: unknown;
  source: 'connect' | 'runtime' | 'close' | 'probe';
}

export class ConnectionAlertNotifier {
  private throttleMap = new Map<string, number>();  // key: `${deviceId}:${errorType}`
  private readonly NOTIFY_THROTTLE_MS = 5 * 60 * 1000;

  async notify(alert: ConnectionAlert): Promise<ClassifiedError>;
}
```

- 调用 `classifySshError(err)` 拿分类
- `console.error('[conn-alert] device <id> (<name>) source=<s> type=<t>: <msg>')`
- 写 `updateDeviceRuntimeStatus({ lastError: translatedFriendlyMsg, lastErrorType: type })`
- 按 `deviceId:errorType` 节流 5 分钟，达到阈值则调 `telegramService.sendToAuthorizedChats({ text: t('telegram.deviceConnectionError', {...}) })`
- 把现有 `notifySshAuthFailure` 的 auth-only 专用逻辑**整个删除**，统一走此模块

### 2. 扩展 `DeviceRuntimeStatus` 加 `lastErrorType` 字段
**改** `packages/shared/src/index.ts`（`DeviceRuntimeStatus` 接口加 `lastErrorType: string | null`）
**改** `apps/gateway/src/db/schema.ts` + 生成 migration（新列 `last_error_type`）
**改** `apps/gateway/src/db/index.ts`（`updateDeviceRuntimeStatus` 接受 `lastErrorType`）

### 3. push supervisor 所有错误走新通知器
**改** `apps/gateway/src/push/supervisor.ts`:
- 删除 `isSshAuthError`、`notifySshAuthFailure`、`sshAuthNotifyMap`、`SSH_AUTH_NOTIFY_THROTTLE_MS`
- `connectEntry` 的 catch（269-281 行附近）：调 `connectionAlerts.notify({device, error, source: 'connect'})`
- 新增：`runtime.subscribe` 的 `onError` 回调（244 行附近）把 error 也转给 `connectionAlerts.notify({source: 'runtime'})`
- 新增：`handleClose`（现在仅 `scheduleReconnect`，不发通知）— 追加 `connectionAlerts.notify({error: new Error('ssh_connection_closed'), source: 'close'})`；由于 close 往往没有 error 对象，构造 sentinel Error，classifier 对 "ssh_connection_closed" 走默认 `unknown` → 在 classifier 里加一条规则返回 `type='connection_closed'` + `sshError.connectionClosed`

### 4. 让 push supervisor 能广播到 WS
**改** `apps/gateway/src/ws/index.ts`:
- 把 `broadcastError` 改为 `public`，或新增 public 方法 `broadcastDeviceError(deviceId, payload)`，内部复用现有 encoder
- **关键**：需要对**所有已连到该设备的 WS clients 广播**（现有实现已满足），但当 `entry` 不存在（没人开终端）时直接 no-op，不影响 lastError 写库

**改** `apps/gateway/src/runtime.ts:45-47`:
- `pushSupervisor.setBroadcastHandler((deviceId, payload) => wsServer.broadcastDeviceError(deviceId, payload))`
- 需要给 `PushSupervisor` 加 `setBroadcastHandler(fn)` 方法（轻量，不破坏现有 deps 注入）

### 5. `ssh-probe.ts` 探活走同一分类器
**改** `apps/gateway/src/tmux-client/ssh-probe.ts` — 原有 probe 错误直接返回；在返回点调一次 `connectionAlerts.notify({source: 'probe'})`；考虑到探活是用户主动行为，**probe 的 telegram 通知关闭**，但 `updateDeviceRuntimeStatus` + console 保留（即 notify 里加 `silentTelegram?: boolean`）

### 6. local 设备
**改** `apps/gateway/src/tmux-client/local-external-connection.ts` — `updateDeviceRuntimeStatus` 的调用点接入 `connectionAlerts.notify({source:'runtime'})`；classifier 里补充识别 local 专属错误（`tmux: command not found` 已有，ok；额外加 `local_shell_unavailable` 如需要）

## 前端改动

### 1. Store 新增状态
**改** `apps/fe/src/stores/tmux.ts`:
- `deviceErrors[id]` 已有（`{message, type?}`），改为 `{message, type, rawMessage, at: number}` 加时间戳
- 新增 `deviceReconnecting[id]: { attempt, maxRetries, delaySec, scheduledAt } | null` 消费 `errorType: 'reconnecting'` 事件
- 处理 `type: 'reconnected'` 事件时清 `deviceErrors[id]`

### 2. REST `/api/devices` 返回 runtime status
**改** `apps/gateway/src/api/index.ts:158,241-243`:
- 列表/详情接口 merge `DeviceRuntimeStatus` 的 `lastError` + `lastErrorType` + `lastSeenAt` 到响应
**改** `apps/fe/src/` 设备列表初始拉取逻辑，把 response 里的 `lastError/lastErrorType` 写入 `deviceErrors[id]`，保证刷新后仍可见

### 3. 设备卡片常驻徽标
**改** `apps/fe/src/components/sidebar-device-list.tsx` 和/或 `apps/fe/src/pages/DevicesPage.tsx`:
- 在设备行/卡片右侧加错误徽标（红点 + 分类短标签，如 `🔴 认证失败`/`🔴 网络不可达`/`🟡 重连中 10s`）
- hover/点击展开原始错误
- `deviceReconnecting` 优先于 `deviceErrors` 显示（重连中用黄色）
- 连接成功后徽标自动消失

### 4. Toast 策略调整
现在每次 error 都 toast 会刷屏。仅在**错误类型切换**（`prevType !== newType`）或**首次出现**时 toast，其余只更新徽标。

## i18n 改动

**改** `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`:
- 删除本次第一版的 `telegram.deviceSshAuthFailed`（被下条替代）
- 新增 `telegram.deviceConnectionError`：通用模板，参数 `{siteName, deviceName, host, category, error}`，`category` 传翻译后的 `sshError.*` 简短标签
- `sshError.connectionClosed` 新增（zh/en/jp）
- 新增前端徽标短标签：`deviceStatus.reconnecting`、`deviceStatus.offline`、`deviceStatus.errorBadge.{authFailed,networkUnreachable,connectionRefused,timeout,hostNotFound,handshakeFailed,tmuxUnavailable,connectionClosed,unknown}`（10+ key）

之后跑 `bun run build:i18n` 重建 `resources.ts` / `types.ts`。

## 文件清单

| 文件 | 改动类型 |
|------|---------|
| `apps/gateway/src/push/connection-alerts.ts` | 新增 |
| `apps/gateway/src/push/supervisor.ts` | 重构：删 auth-only 逻辑，接入 notifier |
| `apps/gateway/src/ws/index.ts` | 暴露 public 广播方法 |
| `apps/gateway/src/ws/error-classify.ts` | 补 `connection_closed` 分类 |
| `apps/gateway/src/runtime.ts` | 注入 broadcast handler |
| `apps/gateway/src/api/index.ts` | 设备接口 merge runtime status |
| `apps/gateway/src/tmux-client/ssh-probe.ts` | 接入 notifier（silentTelegram） |
| `apps/gateway/src/tmux-client/local-external-connection.ts` | 接入 notifier |
| `apps/gateway/src/db/schema.ts` | 加 `last_error_type` 列 + migration |
| `apps/gateway/src/db/index.ts` | `updateDeviceRuntimeStatus` 支持新字段 |
| `packages/shared/src/index.ts` | `DeviceRuntimeStatus.lastErrorType` |
| `packages/shared/src/i18n/locales/*.json` | telegram.deviceConnectionError、sshError.connectionClosed、deviceStatus.* |
| `apps/fe/src/stores/tmux.ts` | errors 结构增强、reconnecting state |
| `apps/fe/src/components/sidebar-device-list.tsx` | 错误徽标 |
| `apps/fe/src/pages/DevicesPage.tsx` | 错误徽标（若 sidebar 外也要展示） |
| `packages/app/src/runtime/server.ts` | 无改动（上一轮加的 unhandledRejection 兜底保留） |

## 验证

1. **单测**：
   - `apps/gateway/src/push/supervisor.test.ts` 更新：mock notifier，验证四条路径（connect / runtime / close / probe）都会触发一次，且节流生效
   - 新增 `apps/gateway/src/push/connection-alerts.test.ts`：节流按 `deviceId:errorType` 独立；类型切换立即再发
   - `apps/gateway/src/ws/error-classify.test.ts`（若有）补 `connection_closed` case

2. **端到端手动**：
   - 构造一个故意错密码的 SSH 设备 → 看到 tg 发 "认证失败"、前端卡片红徽标 "认证失败"、刷新页面徽标仍在
   - 把同一设备改成 host 不可达 → tg 再发一条 "主机不可达"（分类切换立即发）、徽标变为 "主机不可达"
   - 连上一个正常设备 → 手动 `kill` 远端 tmux 进程或物理断网 → 看到 close 通知、重连中倒计时徽标（黄色）、重试耗尽后变红
   - local 设备：临时重命名 `/opt/homebrew/bin/tmux` → 看到 "tmux 不可用" 通知

3. **回归**：
   - 正常场景 WS 开/关终端不应触发 tg（wsServer 自身的 `handleConnectionClose` 不应产生 push supervisor 通知）
   - reconnect 成功后 `deviceErrors` 应被清
   - typecheck：`bunx tsc --noEmit -p apps/gateway/tsconfig.json` / `apps/fe/tsconfig.json` 不引入新错误
   - 跑全部测试：`bun test`
