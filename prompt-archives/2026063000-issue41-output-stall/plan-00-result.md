# Plan-00 执行结果

## 实现完成

所有 4 个任务按计划实现完成，6 个文件变更（3 源码 + 3 测试），+540 行。

### 改动摘要

| 文件 | 改动 |
|------|------|
| `control-mode-subscription.ts` | +7 行：`onPause`/`onContinue` 可选回调 + `handleNotification` 分发 |
| `local-external-connection.ts` | +74 行：`write` 接口、心跳机制（start/stop/send/onResponse）、`onPause` 处理、pump 自恢复 |
| `ssh-external-connection.ts` | +91 行：`write` 接口、`openReaderChannel` 返回 `{stop, write}`、心跳机制、`onPause` 处理 |
| `control-mode-subscription.test.ts` | +26 行：`%pause`/`%continue` 回调测试 |
| `local-external-connection.test.ts` | +248 行：心跳发送/回复/超时、`%pause` continue、pump 异常、disconnect 清理 |
| `ssh-external-connection.test.ts` | +106 行：心跳发送/超时、`%pause` continue |

### 测试结果

- 改动文件测试：60 pass, 0 fail
- 全量单测：888 pass, 1 flaky fail（`pane-emulator.test.ts` 既有问题，单独跑 7/7 pass）

### 对抗审查结果

6 个维度全部 PASS：
1. 资源泄漏：所有 timer 在 disconnect/shutdown 路径正确清理
2. 竞态条件：JS 单线程 + `controlProcess !== proc` 守卫 + `heartbeatPending` 标志覆盖
3. 异常安全：write 方法 try-catch 覆盖、kill 重复调用安全
4. 协议正确性：`display-message -p "tmex-hb"\n` 和 `refresh-client -A %N:continue\n` 格式正确
5. 重连预算交互：心跳 kill 走 `handleControlClientExit` → `CONTROL_STABLE_RESET_MS`(10s) 重置计数器，不会快速耗尽
6. onBlockEnd 判别：`!block.isError && lines.length === 1 && lines[0] === 'tmex-hb'` 精确匹配，`refresh-client -A` 回复块为空不会误判
