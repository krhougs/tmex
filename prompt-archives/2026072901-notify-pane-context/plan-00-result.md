# 执行结果(2026-07-29)

## 改动

1. **shared 类型**:`WebhookEvent.tmux`、`TmuxBellEventData`、`TmuxNotificationEventData`
   增加 `paneCurrentPath?: string`。
2. **`resolvePaneContext`**(gateway `tmux/bell-context.ts`):回填
   `paneCurrentPath = targetPane?.currentPath`;`paneTitle` 改取
   `targetPane?.customName ?? targetPane?.title`(用户改名优先,对齐前端展示语义)。
3. **push supervisor**:bell / notification 事件的 `tmux` 块透传 `paneCurrentPath`。
4. **Telegram 通道**:pane meta 行新增"目录"行(`notification.currentPath` 三语:
   目录 / Directory / ディレクトリ),`bun run build:i18n` 重建生成物。

## 验证

- gateway bell-context / supervisor / event-notify-broadcast 测试 14/14
  (bell-context 用例扩展:customName 优先 + currentPath 回填断言);
- gateway events channels 测试 27/27;shared 测试 98/98。

## 备注

- webhook 通道 payload 全量透传,自动带上新字段,无需改动。
- 浏览器端 tmux-event(bell/notification)payload 类型同步加了字段,但前端 toast
  文案未消费,展示不变。
