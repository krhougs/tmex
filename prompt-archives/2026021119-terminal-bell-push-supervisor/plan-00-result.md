# Plan 00 Result：独立 Push Supervisor 实现 tmux bell 推送

时间：2026-02-11

## 执行结论

已完成独立 Push Supervisor 实现，并满足以下目标：

1. 保持前端 tmux 数据链路与 WS 连接处理逻辑不变。
2. 新增后端独立推送链路，常驻维护设备级 tmux 连接并监听 bell。
3. bell 判定改为解析 `%output/%extended-output` 解码后的 `BEL(0x07)`。
4. 设备新增/更新/删除已接入 supervisor 生命周期联动（upsert/reconnect/remove）。
5. Gateway 启停已接入 supervisor start/stop。
6. 本地与 SSH 连接都具备断线重连机制（超出快重试后进入慢重试循环）。

## 主要改动

1. 新增 bell 上下文解析模块：
   - `apps/gateway/src/tmux/bell-context.ts`
2. 新增独立推送 supervisor：
   - `apps/gateway/src/push/supervisor.ts`
3. `TmuxConnection` 增加 BEL 检测并发出 `bell` 事件：
   - `apps/gateway/src/tmux/connection.ts`
4. WS 侧去除 Telegram/Webhook bell 推送，仅保留前端事件广播：
   - `apps/gateway/src/ws/index.ts`
5. API 设备增删改接入 supervisor 生命周期：
   - `apps/gateway/src/api/index.ts`
6. Gateway runtime 接入 supervisor start/stop：
   - `apps/gateway/src/index.ts`
7. parser 不再依赖 `%bell` 作为主路径：
   - `apps/gateway/src/tmux/parser.ts`

## 新增/更新测试

1. 新增：`apps/gateway/src/tmux/bell-context.test.ts`
2. 新增：`apps/gateway/src/push/supervisor.test.ts`
3. 更新：`apps/gateway/src/tmux/connection.test.ts`（BEL 触发 bell）
4. 更新：`apps/gateway/src/ws/index.test.ts`（bell 上下文扩展）

## 验证结果

执行命令：

1. `bun test apps/gateway/src`
2. `bun run --filter @tmex/gateway build`

结果：

1. `apps/gateway/src` 全量测试通过（54 pass, 0 fail）。
2. Gateway 构建通过。

## 风险与后续建议

1. 当前为“WS 连接 + PushSupervisor 连接”双连接模型，后续可评估是否需要连接复用以降低远端会话压力。
2. 当前慢重连间隔固定为 60 秒，如需可配置化，可扩展 site settings。
3. 如后续要在页面明确展示“由 supervisor 触发”的 bell 来源，可再增加观测指标与诊断事件。
