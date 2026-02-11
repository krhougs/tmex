# Plan 00：终端输出重复（单次更新显示 5 次）修复

时间：2026-02-11

## 背景

用户反馈在近期修复后出现新回归：终端每次输出更新会被显示多次（约 5 次）。

只读排查显示核心风险点：

1. 后端 `handleDeviceConnect` 为异步建连，缺少同设备并发去重；短时间多条 `device/connect` 可能并发创建多个 `TmuxConnection`。
2. 前端存在 page/sidebar/重连补发等多入口触发 connect 的时序，可能放大并发概率。

## 目标

1. 消除同一输出被重复广播/重复渲染。
2. 保持现有协议与 API 不变。
3. 以最小改动修复并发竞态，增加可回归测试。

## 实施任务

### 任务 1：后端并发建连去重（主修）

- 文件：`apps/gateway/src/ws/index.ts`
- 方案：新增 pending map（按 deviceId 锁定建连过程），将 `handleDeviceConnect` 改为复用同一 in-flight Promise。
- 要点：
  - 已有连接直接复用。
  - 建连进行中时等待已存在 promise。
  - 创建失败后清理 pending，允许后续重试。

### 任务 2：前端 connect 短窗兜底

- 文件：`apps/fe/src/stores/tmux.ts`
- 方案：在首个引用触发 connect 发送时增加短窗去重（默认 500ms），避免抖动期重复 `device/connect`。

### 任务 3：后端竞态回归测试

- 文件：`apps/gateway/src/ws/index.test.ts`（新增）
- 场景：
  1. 同设备并发 `getOrCreateConnectionEntry` 只创建一次。
  2. 创建失败后 pending 清理，后续可重试成功。

### 任务 4：验证

- `bun test apps/gateway/src/ws/index.test.ts`
- `bun test apps/gateway/src/tmux/connection.test.ts`
- `bun run --cwd apps/gateway build`
- `bun run --cwd apps/fe build`

## 注意事项

1. 不改 shared 协议类型。
2. 不改终端输出协议格式。
3. 保持改动聚焦竞态问题，不扩展无关重构。
