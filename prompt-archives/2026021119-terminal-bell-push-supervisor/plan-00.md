# Plan 00：独立 Push Supervisor 实现 tmux bell 推送

时间：2026-02-11

## 背景

当前 bell 通知链路依赖前端 WS 驱动的 tmux 连接，导致无前端在线时无法稳定推送。

用户明确要求：
1. 前端获取 tmux 数据方式不变。
2. 后端处理前端连接方式不变。
3. 推送能力通过独立 supervisor 模块实现。
4. 同一次 bell 事件可以同时触发网页 Toast 与 Telegram Bot 消息。

## 目标

1. 新增后端独立 Push Supervisor，常驻维护所有设备的 tmux 连接。
2. bell 检测改为基于 `%output/%extended-output` 解码后 `BEL(0x07)`，避免依赖不稳定控制通知。
3. 设备新增/修改/删除时，supervisor 连接应正确新建、重连、关闭。
4. 本地与 SSH 会话都支持断线重连（含 tmux 进程被外部杀掉）。

## 注意事项

1. 不修改前端协议与交互路径。
2. 不重构 `WebSocketServer` 现有连接生命周期，仅新增 push 链路。
3. 为防止双通道重复推送，Telegram/Webhook bell 推送统一由 supervisor 触发。
4. 复用现有 `eventNotifier` 节流与格式化逻辑。

## 实施任务

1. 在 parser/connection 增加基于 BEL 的 bell 事件产出。
2. 新增 `push/supervisor.ts`，实现设备常驻连接、重连状态机、bell 通知触发。
3. 在 `index.ts` 接入 supervisor 生命周期（start/stop）。
4. 在设备 API 的增删改流程接入 supervisor（upsert/reconnect/remove）。
5. 调整 WS bell 通知触发，保持网页事件不变，Telegram/Webhook 只走 supervisor。
6. 补充并运行测试，覆盖 bell 检测、supervisor 生命周期、API 联动。

## 验收标准

1. 前端页面行为与现有 WS 协议保持一致。
2. 无前端在线时 bell 仍可推送到 Telegram。
3. 有前端在线时同一次 bell 可同时出现网页 Toast 和 Telegram 消息。
4. 设备删除/修改后推送连接可正确释放/重连。
5. 本地/SSH 异常断线后 supervisor 可自动恢复。

