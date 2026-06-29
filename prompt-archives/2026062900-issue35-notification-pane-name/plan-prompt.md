# Issue #35: Notification shows pane index instead of name

## Prompt

为 GitHub issue #35 编写实现计划。

用户问题：通知 toast 只显示数字索引（pane N），多 pane 场景无法分辨。
根因：BellEventSchema / NotificationEventSchema 缺 paneTitle 和 paneCurrentCommand 字段，gateway 的 resolvePaneContext() 已解析出这些数据但 Borsh 序列化时丢弃。推送通知走 JSON 不受影响。

项目 owner 补充要求：记得做好 i18n。
