# SSH 错误全链路告警 — Prompt 存档

## 背景

用户在 macOS 本地部署的 tmex 生产实例被 launchd 反复拉起（`runs=16, last exit code=1`）。查日志定位到：单个 SSH 设备 (`730d8d12-f846-4c5e-a7f6-59a9fa8634a7`) 认证失败触发 unhandledRejection（`SSH command channel not ready`），Bun 1.3.12 strict rejection 策略把整个 gateway 进程带走，launchd `KeepAlive=true` 循环重启。

对话经过三轮演进：

1. 先做止血：加进程级 `unhandledRejection` / `uncaughtException` 兜底；修 `enqueueShellCommand` / `queuePipeTransition` 里悬挂的 rejection；SSH 认证错误加 telegram 通知 + 终端打印 + 5 分钟节流。
2. 追问："网络问题导致 ssh 连接失败/断线是怎么处理的？" —— 摸清 `scheduleReconnect` 节奏、`keepaliveInterval` 未设置、`handleClose` 链路不发通知等现状。
3. 本轮要求：把 auth-only 通知扩到**所有 SSH error**，并把前端对应逻辑（设备卡片常驻错误徽标）一起处理好。

## 本轮 Prompt 原文

> ssh auth error 相关的错误提示（log、tgbot）拓展为ssh error，所有ssh error都应该这么处理
> 前端对应的逻辑也得处理好

## 前置 Prompt（相关上下文）

**第一轮（止血）**：
> 部署在macos上的生产版本怎么看日志

> 帮我看看本地部署的版本为什么一直在重启

> 直接在当前分支按照你的"长期修复"来修
> 然后ssh认证错误需要打印在终端中，并通过tgbot发送

**第二轮（排查）**：
> 网络问题导致ssh连接失败/断线是怎么处理的？

## 关键澄清（本轮 AskUserQuestion）

- **前端展示**：加设备卡片常驻错误徽标（不只 toast，刷新后仍可见）
- **Telegram 节流**：按 `deviceId:errorType` 独立节流 5 分钟；分类切换立即再发
- **覆盖范围**：已连接后的掉线 + local 设备错误 + ssh-probe 探活错误（三项全选）

## 交付物

- `plan-00.md`：本次实现计划
- `plan-00-result.md`：实现完成后补写的执行结果总结
