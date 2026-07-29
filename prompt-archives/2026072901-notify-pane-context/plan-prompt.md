# 任务:通知事件补全 pane 上下文(当前路径 + 改名标题)

日期:2026-07-29。

## 背景

通知事件(bell / OSC 通知等)的 `WebhookEvent.tmux` 块已带 `paneTitle` / `paneCurrentCommand`,
但缺少 pane 当前工作目录;且 `paneTitle` 只取 OSC 标题,忽略了用户改名(customName),
与前端展示语义(customName 优先)不一致。下游通知通道(webhook / Telegram)因此无法
展示"进程在哪个目录里"这一关键上下文。

## 要求

1. `WebhookEvent.tmux`、`TmuxBellEventData`、`TmuxNotificationEventData` 增加
   `paneCurrentPath?: string`(数据源:快照 `TmuxPane.currentPath`,即
   `#{pane_current_path}`)。
2. `resolvePaneContext` 回填 `paneCurrentPath`;`paneTitle` 改为
   `customName ?? title`(用户改名优先)。
3. push supervisor 的 bell / notification 事件透传新字段。
4. Telegram 通道 pane meta 行补"目录"行(i18n 三语)。
