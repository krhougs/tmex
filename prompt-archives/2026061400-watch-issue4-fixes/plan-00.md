# Issue #4：watch 功能两个问题 + 通知增强

## Context（背景）

GitHub issue [krhougs/tmex#4](https://github.com/krhougs/tmex/issues/4) 报告了 watch（监控）功能的两个 bug 和一个增强，来源是一条实际发出的 Telegram 通知：

```
👁️ 👁️ Watch 规则错误
站点：shanghai\-macmini
设备：local \(local\)
窗口：0 \(@137\)
Pane：0 \(%242\)
直达：https://sh\-dev\.01\.do/...
信息：监控「卡住」连续失败 10 次，已自动停用：can't find pane: %2965
```

三件事：

1. **Telegram 消息未正确 escape**（消息里出现了字面反斜杠 `\-` `\(` `\)`）。要求复用已有 escape 逻辑，并顺手排查同类问题。
2. **pane 销毁后 watch 任务未正确清理**。用户猜测 watch 存的 pane key 是纯数字而非 tmux 字符串 id。
3. **增强**：所有同类提示（含 OSC 通知、bell 通知、watch 通知）都应包含 pane 当前标题和进程。

### 调研结论（已验证）

- **问题 1 根因**：`apps/gateway/src/events/index.ts` 的 `formatTelegramMessage()`（L268-319）对每行调用 `sanitizeMarkdownV2()` 加转义，但发送时（L196-197 `sendTelegramNotifications` 末尾）**未带 `parse_mode`**。Telegram 把无 parse_mode 的文本当纯文本，于是转义反斜杠被原样显示。对照之下 bell/notification 走 HTML 模式（`escapeTelegramHtmlText` + `<a>` 链接 + `parseMode: 'HTML'`），是正确范式。
- **问题 2 根因**：用户的"纯数字 key"猜测**不成立**——`watch_rules.paneId` 存的就是 tmux 字符串 id（`schema.ts` `text('pane_id')`，测试用 `%1`）。真正问题有两层：
  - watch tick（`watch/service.ts` `runTick` L421-456）采样已销毁 pane 时，`capturePaneText` 抛 `TmuxTargetMissingError`（`tmux-client/target-missing.ts`），被 `recordRuleError` 当成普通错误计数，直到**连续失败 10 次**才 `disableRuleForErrors` 停用——既慢又给出误导性的"连续失败"文案。
  - 通知里 `Pane：0 (%242)` 与错误里 `can't find pane: %2965` **不一致**：规则 pane（`%2965`）已销毁，`bell-context.ts` 的 `resolvePaneContext`（L58-68）找不到它就**回退到该窗口里另一个存活 pane（`%242`）**，导致通知指向无关 pane。
- **问题 3 数据源**：snapshot 的 `list-panes` 格式（local L836 / ssh L877）已含 `#{pane_title}`，但**不含** `#{pane_current_command}`。`TmuxPane`（`shared/src/index.ts` L242-250）有 `title?` 无进程字段。`resolvePaneContext` 返回的 `PaneLocationContext`（`bell-context.ts` L10-13）只含 id/index/url，不含 title/进程。

### 用户已确认的决策

- **Pane 销毁 → 立即删除规则**（不是停用），并发一条清晰的清理通知。
- **标题/进程数据源 → 复用快照**（扩展 `list-panes` 格式，零额外 tmux 往返）。

---

## 前置：归档（先存档，再干活）

按 AGENTS.md：在 `prompt-archives/` 下新建 `2026061400-watch-issue4-fixes/`，创建 `plan-prompt.md`（存本次 issue 调研 prompt）并把本计划拷为 `plan-00.md`。完成后写 `plan-00-result.md`。

---

## 任务 1：修复 Telegram 转义（issue 问题 1）

**目标**：`formatTelegramMessage` 改用 HTML 模式，复用既有 `escapeTelegramHtmlText` / `escapeTelegramHtmlAttribute`，与 bell/notification 保持一致。

文件：`apps/gateway/src/events/index.ts`

- 重写 `formatTelegramMessage()`（L268-319）：
  - 每行的动态内容（site name、device name/type、window/pane label、`payload.message`）用 `escapeTelegramHtmlText()` 转义；删除 `sanitizeMarkdownV2()` 调用。
  - "直达"链接改成 `<a href="...">` 形式，复用 `normalizeHttpUrl` + `encodePercentForTelegramUrl` + `escapeTelegramHtmlAttribute`（照搬 `formatTelegramBellMessage` L225-232 的写法）。
- 在 `sendTelegramNotifications()` 末尾发送处（L196-197）补 `parseMode: 'HTML'`。
- 若 `sanitizeMarkdownV2`（L6-8）变为无引用则删除，避免死代码。
- **顺手排查同类问题**：grep `sendToAuthorizedChats` / `bot.api.sendMessage` 全部调用点（含 `apps/gateway/src/telegram/service.ts` 的 bot 命令回复），确认凡传动态内容的都带正确 parse_mode + 对应 escape；不一致的一并修。

**验证**：构造含 `_ * [ ] ( ) - . !` 等字符的 device name / rule name，触发 watch_rule_error 通知，Telegram 收到的文本不再有字面反斜杠，且 HTML 不破版。

---

## 任务 2：pane 销毁立即删除规则（issue 问题 2）

**目标**：watch 采样遇到 pane 已销毁时，立即删除该规则并发清理通知，不再走"连续失败 10 次"。

文件：`apps/gateway/src/watch/service.ts`（+ `db/watch.ts` 已有 `deleteWatchRule`）

- `WatchServiceDeps` 增加 `deleteRule: (id: string) => void`，`defaultDeps` 注入 `deleteWatchRule`（来自 `db/watch.ts` L140）。
- `runTick` 的 catch（L438-444）区分错误类型：用 `isTargetMissingMessage(toErrorMessage(error))`（`tmux-client/target-missing.ts`，比 `instanceof` 更稳，兼容跨边界重抛）判定 pane 已销毁。
  - 命中 → 调用新方法 `handlePaneGone(rule)`，**return**，不进 `recordRuleError`。
  - 未命中 → 维持现有 `recordRuleError` 逻辑（连续失败计数仍用于 LLM/网络等真实故障）。
- 新增 `private async handlePaneGone(rule)`：
  1. `this.deps.deleteRule(rule.id)`（删 DB 行）。
  2. `await this.removeRule(rule.id)`（摘调度 + 清 samples + release 设备引用，复用现有 L236-239）。
  3. 发清理通知：新 i18n 文案 `notification.watch.paneGone`，事件类型复用 `watch_rule_error`，WS 复用 `wsBorsh.WATCH_EVENT_RULE_ERROR`（避免改 borsh/EventType schema）。
  4. 该通知的 pane 上下文**不要**走会回退到无关 pane 的 `resolvePaneContext` 路径——直接带 `rule.paneId`（文案里点明"pane 已销毁"），避免重演 `%242` vs `%2965` 误导。
- 同步澄清：在结果文档里写明"paneId 本就是 tmux 字符串 id，用户猜测不成立，真因是缺主动清理 + context 回退误导"。

**注意**：`capturePaneText` 仅在 tmux 已连接且明确返回 "can't find pane/window" 时抛 target-missing；连接不可用是另一条 `tmux connection not available` 普通错误，不会误判，故立即删除是安全的。

**验证**：`watch/service.test.ts` 加用例——`setCaptureError(new Error("can't find pane: %1"))` 后单次 `tickRule` 即应：规则从 DB 删除、`isRuleScheduled` 为 false、产生 1 条 `watch_rule_error`（paneGone 文案）。同时保留原"非 pane-missing 错误累计到 10 次才停用"的用例。

---

## 任务 3：通知带 pane 标题与进程（issue 增强）

**目标**：bell / OSC notification / watch 三类通知都附带 pane 当前标题（`pane_title`）和进程（`pane_current_command`），数据复用快照。

### 3.1 快照采集进程名

- `shared/src/index.ts`：`TmuxPane`（L242-250）增 `currentCommand?: string`。
- `tmux-client/local-external-connection.ts`（L836 格式串、L928 起 `parseSnapshotPanes`）与 `ssh-external-connection.ts`（L877 格式串、L971 起解析）：`list-panes -F` 末尾加 `#{pane_current_command}`，对应调整字段切分数量与索引，解析进 `pane.currentCommand`。
  - 注意分隔符差异：local 用 `\t`、ssh 用 `|`；进程名一般无这些字符，但仍放末位最安全。

### 3.2 上下文透传 title/进程

- `tmux/bell-context.ts`：`PaneLocationContext`（L10-13）增 `paneTitle?` `paneCurrentCommand?`；`resolvePaneContext` 从 `targetPane` 读 `title` / `currentCommand` 一并返回（仅在 snapshot 命中真实 pane 时填充，回退 pane 不填，避免误导）。
- `shared/src/index.ts`：`WebhookEvent.tmux`（L354-361）、`TmuxBellEventData`（L263-269）、`TmuxNotificationEventData`（L273-282）各增 `paneTitle?` `paneCurrentCommand?`。

### 3.3 三处通知接线

- `push/supervisor.ts` `notifyBell` / `notifyNotification`：把 `resolvePaneContext` 结果里的 `paneTitle` / `paneCurrentCommand` 透传进 `tmux` 字段。
- `watch/service.ts` `safeNotify`（L761-794）：`tmux` 字段补 `paneTitle: paneContext.paneTitle`、`paneCurrentCommand: paneContext.paneCurrentCommand`。
- `events/index.ts` 三个格式化函数（`formatTelegramBellMessage` / `formatTelegramNotificationMessage` / 任务 1 重写后的 `formatTelegramMessage`）：在合适位置追加"标题"和"进程"行（有值才加），动态值同样走 HTML escape。webhook 透传随 `WebhookEvent.tmux` 自动带上。

### 3.4 i18n

源在 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（**禁止手改生成物 `resources.ts`/`types.ts`**，改完跑 `bun run build:i18n` 重建）：

- `notification` 下加 `paneTitle`（"标题"）、`process`（"进程"）。
- `notification.watch` 下加 `paneGone`（如 `"监控「{{name}}」的 Pane（{{paneId}}）已销毁，规则已自动删除"`）。
- 三个 locale 同步加；`en_US`/`ja_JP` 给对应翻译。

**验证**：起仓库内临时实例（显式覆盖 `TMEX_FE_DIST_DIR`/`GATEWAY_PORT`/`TMEX_BIND_HOST` 等，**绝不碰生产 9883/安装目录**），触发 bell / OSC 通知，确认 Telegram 与 webhook payload 均含标题、进程。

---

## 受影响文件一览

- `apps/gateway/src/events/index.ts`（任务 1、3.3）
- `apps/gateway/src/watch/service.ts`（任务 2、3.3）
- `apps/gateway/src/db/watch.ts`（任务 2，已有 `deleteWatchRule`，仅接线）
- `apps/gateway/src/tmux/bell-context.ts`（任务 3.2）
- `apps/gateway/src/tmux-client/local-external-connection.ts` / `ssh-external-connection.ts`（任务 3.1）
- `apps/gateway/src/push/supervisor.ts`（任务 3.3）
- `packages/shared/src/index.ts`（任务 2、3.1、3.2）
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（任务 2、3.4）
- 测试：`apps/gateway/src/watch/service.test.ts`、`tmux-client/*-external-connection.test.ts`（快照解析新字段）

## 整体验证

1. `bun run build:i18n` 重建 i18n，类型不报错。
2. `bun test`（仓库内 `test` 环境）：watch/service、events、tmux-client 解析相关用例全绿；新增 pane-gone 用例通过。
3. 仓库内临时实例端到端：制造一个 watch 规则 → kill 其 pane → 观察规则被立即删除 + 收到 paneGone 通知（无字面反斜杠、含标题/进程）。
4. lint/format（注意跳过生成文件）。
