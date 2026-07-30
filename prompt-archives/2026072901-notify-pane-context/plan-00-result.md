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

## Review 修复(同日,codex review 三发现全修)

1. **改名 overlay 不达通知路径**:supervisor 缓存的是原始快照(overlay 只在 ws 广播面
   与 metadata projection 里),`customName ?? title` 恒退化。修复:projection 暴露
   `customNameOf`、runtime 转发 `getCustomName`,supervisor 解析 pane 上下文后补查
   (pane 级优先、window 级兜底)覆盖 `paneTitle`。
2. **borsh 线格丢字段**:Bell/Notification 事件 schema 与 convert 双向补
   `paneCurrentPath`(struct 尾部追加,同版本 gateway/fe 一体发布);新增
   `event-payload-roundtrip.test.ts` 锁住该协议边界。
3. **其余生产者透传**:watch `safeNotify` 与 `tmux_pane_close`(lifecycle-emitter,
   顺带 customName 优先)补 `paneCurrentPath`。

验证:push/tmux/tmux-client/watch/ws/shared 共 618 测试全绿(supervisor mock 无
`getCustomName` 用可选调用兼容);gateway tsc 仅 agent 模块基线既有报错。

## 备注

- webhook 通道 payload 全量透传,自动带上新字段,无需改动。
- 浏览器端 tmux-event(bell/notification)payload 类型同步加了字段,但前端 toast
  文案未消费,展示不变。
