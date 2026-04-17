# prompt 存档：SSH pane exit 误报 + runtime 错误无法恢复

## 背景

上一轮（2026041800-ssh-error-unified-alerts）刚把 SSH 连接错误做了统一告警：分类 + 持久化到 `DeviceRuntimeStatus.lastError/lastErrorType` + WS 广播 + Telegram 节流推送，前端加常驻徽标。已 commit + 发布 tmex-cli@0.4.3 + push。

本轮用户在真实使用中发现新 bug：在 SSH device 的终端里主动 `exit`，device 就"再也连不上"，前端一直显示 `SSH pane reader closed unexpectedly: %2`。

## 本轮用户 prompt 原文

> ssh device里的终端主动exit退出之后，这个device就再也连不上了
>
> SSH pane reader closed unexpectedly: %2

（随后的对话：用户收到我的诊断 —— 三个层叠 bug（pane 正常退出误报 / connect 成功时 lastErrorType 没清 / hook reader 断开不触发 reconnect）—— 后问"具体怎么修"，进入 plan mode 写详细方案）

## 上下文代码位置

- `apps/gateway/src/tmux-client/ssh-external-connection.ts:797-809` — pane reader 的 `onClose` 误报
- `apps/gateway/src/tmux-client/ssh-external-connection.ts:428-432` — hook reader 的 `onClose` 只 fire onError，不触发 shutdown
- `apps/gateway/src/tmux-client/ssh-external-connection.ts:152-156` / `local-external-connection.ts:140-144` — connect 成功只清 `lastError` 没清 `lastErrorType`
- `apps/gateway/src/push/supervisor.ts:244-251` — onError 只 notify 不 reconnect（本轮结论是让底层自己分层，supervisor 不改）
