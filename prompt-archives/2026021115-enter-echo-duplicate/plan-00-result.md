# Plan 00 执行结果：回车后命令额外回显修复

时间：2026-02-11

## 根因结论

根据前后端链路排查与现象特征（输入时正常、回车后同一命令额外出现一次，direct/editor 都复现），本次根因定位为后端 parser 输出通道重复：

- parser 同时支持 `%output` 和 `%extended-output`。
- 在部分 tmux 输出行为下，同一提交行可能同时出现在两类事件中。
- 两类事件均被直接转发到前端，导致回车后命令额外回显。

## 代码改动

### 1）后端 parser：输出模式锁定

- 文件：`apps/gateway/src/tmux/parser.ts`
- 新增：
  - `type OutputTransportMode = 'unknown' | 'output' | 'extended'`
  - `outputTransportMode` 状态字段
  - `shouldAcceptOutputMode(nextMode)` 方法
- 行为：
  - 首次收到 `%output` 或 `%extended-output` 时锁定模式。
  - 锁定后忽略另一模式，避免双通道重复转发。
  - `flush()` 时重置锁定状态。

### 2）后端测试：回归覆盖

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 新增用例：
  1. `%output` 锁定后忽略 `%extended-output`
  2. `%extended-output` 锁定后忽略 `%output`
  3. 同模式连续输出不受影响
  4. `flush()` 后可重新锁定新模式

## 验证结果

### 单测

- `bun test apps/gateway/src/tmux/parser.test.ts`
- 结果：14 pass，0 fail

### 构建

- `bun run --cwd apps/gateway build`：通过
- `bun run --cwd apps/fe build`：通过（保留既有 CSS warning，非本次引入）

## 结论

本次修复已从后端解析层消除 `%output` 与 `%extended-output` 双通道重复转发问题，可对应修复“回车后同一命令额外回显一行”的现象。前端无需改输入发送逻辑。
