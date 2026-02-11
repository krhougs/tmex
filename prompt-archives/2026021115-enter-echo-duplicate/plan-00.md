# Plan 00：回车后命令额外回显修复

时间：2026-02-11

## 背景

用户反馈在 tmex Web 终端中输入命令并按回车后，同一命令会额外回显一行；iTerm2 中无该现象。

结合现象（输入时正常，回车后重复；direct/editor 都有）与代码排查，重点怀疑后端 parser 同时转发 `%output` 与 `%extended-output`，导致提交行在两条通道被重复分发。

## 目标

1. 消除“回车后同一命令额外回显一行”。
2. 保持对不同 tmux 输出模式的兼容。
3. 不修改 shared 协议与前端输入 API。

## 实施任务

### 任务 1：后端 parser 输出模式锁定

- 文件：`apps/gateway/src/tmux/parser.ts`
- 方案：新增 `outputTransportMode`（unknown/output/extended）
  - 首次收到 `%output` 或 `%extended-output` 时锁定模式。
  - 锁定后忽略另一种模式，避免双通道重复转发。

### 任务 2：补充 parser 回归测试

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 场景：
  1. 先 `%output` 再 `%extended-output`，仅触发一次。
  2. 先 `%extended-output` 再 `%output`，仅触发一次。
  3. 同模式连续输出不受影响。

### 任务 3：验证

- `bun test apps/gateway/src/tmux/parser.test.ts`
- `bun run --cwd apps/gateway build`
- `bun run --cwd apps/fe build`

## 注意事项

1. 不改前端输入发送逻辑，避免扩大影响面。
2. 锁定策略按 parser 实例生效，连接重建会重新选择模式。
3. 如后续发现会话内动态切换输出模式，再追加自适应策略。
