# Plan 00 执行结果：终端输出重复（单次更新显示 5 次）修复

时间：2026-02-11

## 根因结论

本次问题根因是后端连接创建竞态：

- `handleDeviceConnect` 在 `connections` 尚未写入前，允许并发进入 `createDeviceConnectionEntry`。
- 同一 `deviceId` 在短时收到多条 `device/connect`（page / sidebar / ws 重连补发）时，会并发创建多个 `TmuxConnection`。
- 多个连接同时 `onTerminalOutput`，导致同一输出被重复广播与显示（可表现为 5 次）。

前端存在放大因子：短时多入口 connect 消息触发，虽然有 ref 管理，但在竞态窗口内仍可能重复发送。

## 实际改动

### 1）后端主修：并发建连去重

- 文件：`apps/gateway/src/ws/index.ts`
- 新增字段：`pendingConnectionEntries`
- 新增方法：`getOrCreateConnectionEntry(deviceId, ws)`
- 行为：
  - 已有连接直接返回。
  - 建连进行中复用同一 Promise。
  - 创建结束后清理 pending。
  - 失败后可重试。
- `handleDeviceConnect` 改为通过 `getOrCreateConnectionEntry` 获取 entry，避免并发重复创建。
- `closeAll` 增加 pending 清理。

### 2）前端兜底：connect 短窗去重

- 文件：`apps/fe/src/stores/tmux.ts`
- 新增：
  - `CONNECT_DEDUP_WINDOW_MS = 500`
  - `lastConnectSentAt` map
  - `shouldSkipDuplicateConnect(deviceId)`
- 应用点：
  - websocket `onopen` 重连补发 connect 前。
  - `connectDevice` 首次引用发送 connect 前。
  - `disconnectDevice` 时清理对应时间戳。

### 3）新增后端竞态单测

- 文件：`apps/gateway/src/ws/index.test.ts`
- 新增用例：
  1. 同设备并发创建只触发一次实际创建。
  2. 首次创建失败后 pending 清理，后续可重试成功。

## 验证结果

### 单测

- `bun test apps/gateway/src/ws/index.test.ts`：2 pass
- `bun test apps/gateway/src/tmux/connection.test.ts`：4 pass

### 构建

- `bun run --cwd apps/gateway build`：通过
- `bun run --cwd apps/fe build`：通过（存在既有 CSS warning，非本次引入）

## 结果

已完成“后端主修 + 前端兜底”方案。根据代码链路，重复输出的并发根因已被消除，前端补充了额外防抖保护，降低重现概率。
