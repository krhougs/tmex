# Windows control command timeout handling plan

## 目标

让 control command 的 deadline 从命令成为队头时开始计算，并确保 `%error` 与 heartbeat rejection 不污染后续命令或遗留 pending 状态。

## 实施

1. 阅读 `apps/gateway/src/tmux-client/control-mode-capture.ts` 的 enqueue、response block 和 teardown 全路径，定位 timer 所有权。
2. 先增加三类失败测试：排队命令不提前计时、`%error` 后下一命令继续、heartbeat rejection 清理 pending。
3. pending entry 仅保存 timeout 配置；由队头激活函数创建唯一 timer，shift 后激活下一项。
4. `%error` 只 reject 当前 entry，协议损坏/EOF 才 teardown connection。
5. heartbeat 通过统一 completion cleanup 清除 pending 和 timer。
6. 运行聚焦 Bun 单测、Gateway 类型检查及相关既有测试。
7. 与 psmux 修复一起完成 Windows atomic capture、重连和 Companion 生命周期 E2E；所有 gate 通过后才允许创建上游 psmux PR。

## 验收

- 后续 command 在队列中等待时没有运行中的 timer。
- 当前 command 完成后，下一 command 获得完整 timeout 窗口。
- `%error` 不会关闭健康 control connection，后续 command 能成功。
- heartbeat 成功、失败和 teardown 路径均无 pending/timer 泄漏。
- 不增加 Windows 专用 timeout 常量或扩大现有 deadline。
