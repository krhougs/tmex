# 执行结果：watch issue #4 修复

分支：`fix/watch-issue4`（基于 `main`）。三件事全部完成，全量测试通过，已过对抗式代码审查（可合并）。

## 调研澄清

- **用户对问题 2 的猜测不成立**：watch 规则的 `paneId` 本就以 tmux 字符串 id（如 `%242`）存储（`watch_rules.pane_id` 为 `text`），不是纯数字。
- **通知里 `%242` 与错误里 `%2965` 不一致的真因**：规则 pane（`%2965`）已销毁，`resolvePaneContext` 找不到它就回退到该窗口里另一个存活 pane（`%242`），导致通知指向错误 pane。已通过「pane-gone 通知直接带 `rule.paneId`、不走回退解析」修正。

## 改动清单

### 问题 1：Telegram 转义
- `apps/gateway/src/events/index.ts`：`formatTelegramMessage` 由「MarkdownV2 转义却以纯文本发送」改为 HTML 模式——动态内容统一过 `escapeTelegramHtmlText`，直达链接改 `<a href>`（复用 `escapeTelegramHtmlAttribute` + `encodePercentForTelegramUrl`，与 bell/notification 既有逻辑一致），发送补 `parseMode: 'HTML'`；删除已无引用的 `sanitizeMarkdownV2`。
- 顺手排查：`telegram/service.ts`、`agent/supervisor.ts`、`push/connection-alerts.ts` 的纯文本发送均未做 markdown 预转义，无同类 bug，无需改。

### 问题 2：pane 销毁立即删除规则
- `apps/gateway/src/watch/service.ts`：
  - `runTick` catch 用 `isTargetMissingMessage()` 区分 pane 已销毁 vs 一般错误；前者走新 `handlePaneGone`（`deleteRule` + `teardownRule` + 清 samples + 发 `notification.watch.paneGone` 通知（事件类型复用 `watch_rule_error`、WS 复用 `WATCH_EVENT_RULE_ERROR`）+ 广播），后者维持原 `recordRuleError` 累计。
  - `WatchServiceDeps` 加 `deleteRule`（`defaultDeps` 注入 `deleteWatchRule`）。
  - pane-gone 通知显式传 `{ paneId: rule.paneId }`，绕过会回退到无关存活 pane 的 `resolvePaneContext`。
  - 在 tick 内用 `teardownRule`（非 `teardownRuleAndWait`）避免自等死锁。

### 增强：通知带 pane 标题/进程（数据源复用快照）
- `packages/shared/src/index.ts`：`TmuxPane.currentCommand?`；`WebhookEvent.tmux` / `TmuxBellEventData` / `TmuxNotificationEventData` 加 `paneTitle?` `paneCurrentCommand?`。
- `tmux-client/local-external-connection.ts` / `ssh-external-connection.ts`：`list-panes -F` 末尾加 `#{pane_current_command}`；ssh 的 `splitSnapshotFields` 增 `fieldCount===9` 分支（title 仍为唯一可变字段、尾部 5 个固定字段）；解析填入 `pane.currentCommand`。
- `tmux/bell-context.ts`：`PaneLocationContext` 与 `resolvePaneContext` 透传 `paneTitle`/`paneCurrentCommand`（跟随实际解析到的 pane，快照缺失留空）。
- `push/supervisor.ts`：`notifyBell`/`notifyNotification` 透传到 `tmux` 字段。
- `events/index.ts`：新增 `buildPaneMetaLines`，三类格式化函数都追加「标题/进程」行（有值才输出、HTML 转义）。
- i18n：`zh_CN`/`en_US`/`ja_JP` 加 `notification.paneTitle`、`notification.process`、`notification.watch.paneGone`，`bun run build:i18n` 重建 `resources.ts`/`types.ts`。

## 测试

- 更新 `watch/service.test.ts`：原「连续失败累计」用例改用非 pane-missing 错误（`capture timeout`）；新增「pane 销毁单次 tick 即删除规则 + 通知/广播」用例。
- 更新 `events/index.test.ts`：原断言「非 bell 通知无 parse_mode」改为 issue #4 回归用例（HTML 模式、无字面反斜杠、`<>&` 正确转义、含标题/进程、原始中文消息完整）。
- 更新 `bell-context.test.ts`：fixture 加 `currentCommand`，断言含 `paneTitle`/`paneCurrentCommand`。
- 更新 `local/ssh-external-connection.test.ts`：mock list-panes 补进程字段 + 断言 `currentCommand`。

结果：
- gateway 全量 **508 pass / 0 fail**；shared **53 pass / 0 fail**。
- tsc：改动文件零新增类型错误（仓库预存 15 个错误均在无关文件）。
- 对抗式审查：可合并，无 Critical/Major，仅 2 条可接受 Minor（进程名含分隔符的固有风险 = 既有 title 同级风险；删除顺序安全）。

## 注意事项 / 未尽事项

- **格式（biome）**：仓库存在大量预存 biome 格式债，且不作为 CI 门禁（连接文件全文都待 biome 重排）。本次只让新引入的构造（如 `PaneLocationContext` 联合类型）符合 biome，**未**对既有代码做格式化，保持 diff 收敛于 issue #4。
- **端到端实测未跑**：起真实 tmux + gateway + Telegram 的活实例验证成本高且涉本机生产（9883/安装目录）风险，未执行；pane-gone 删除、转义回归、标题/进程透传均已被单测充分覆盖。如需活验证，应在仓库内临时实例（显式覆盖 `GATEWAY_PORT`/`TMEX_BIND_HOST`/`TMEX_FE_DIST_DIR` 等），制造 watch 规则 → kill 其 pane → 观察规则被删 + 收到 paneGone 通知。
- 未提交、未推送（等用户确认）。`apps/*/dist`、`packages/app/dist` 仍含旧 `sanitizeMarkdownV2`，属正式发版 `bun run build` 时重建，非本次范围。
