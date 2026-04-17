# plan-00 执行结果

## 完成项

- Gateway 新增 `pane-stream-parser`，支持裸 `BEL`、`OSC 9`、`OSC 777`、`OSC 1337`、标题类 `OSC 0/1/2` 与 `ESC k` 序列解析。
- 本地与 SSH tmux 连接改为对所有 pane 同时维护 `pipe-pane` 读取器，不再在 `selectPane` 时切换单一 pipe。
- tmux 会话连接时新增 `extended-keys`、`extended-keys-format`、`focus-events` 选项配置；`allow-passthrough` 改为通过 `TMEX_TMUX_ALLOW_PASSTHROUGH=true` 显式开启，默认关闭以降低终端逃逸面。
- 共享类型、Borsh 编解码、Gateway 推送/WS 广播/节流、数据库设置、站点设置 API、前端设置页与浏览器 toast 已联动支持 `terminal_notification`。
- i18n 源文件已补充通知相关文案，并执行 `bun run build:i18n` 重建生成文件。
- README 已补充 SSH `MaxSessions` 限制说明，以及 passthrough 默认关闭/显式开启方式。
- Webhook 创建 UI 已补充 `eventMask` 开关列表，包含 `terminal_notification` 选项，前端创建的 webhook 不再默认是空订阅。
- Borsh 解码已移除未知 tmux event tag 回退到 `output` 的兼容分支，未知事件会直接抛错。
- WS 层已在广播前丢弃 `title` 与 `body` 同时为空的 notification，避免前端收到空通知 toast。
- tmux hook 现在除 `alert-bell` / `pane-exited` / `pane-died` 外，还会监听 `after-new-window` / `after-split-window` 触发 snapshot，同步把运行中新增的 pane/window 纳入 reader 集合，避免 push-only 场景漏掉后续新 pane。
- ws-borsh 协议文档 `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` 已补上 `TMUX_EVENT` 的 `output` / `notification` tag 和 notification schema 说明。

## 关键实现说明

- `resolveBellContext` 已直接改名为 `resolvePaneContext`，供 bell 与 notification 共用 pane/window/url 补齐逻辑。
- 浏览器端 bell/notification 现在直接使用 `sonner` 的 `toast()` / `toast.error()`，不再依赖无监听器的 `tmex:sonner` 自定义事件。
- 数据库新增三个站点设置字段：
  - `notification_throttle_seconds`
  - `enable_browser_notification_toast`
  - `enable_telegram_notification_push`
- 生成的 migration 为 `apps/gateway/drizzle/0002_broad_vengeance.sql`。

## 验证记录

- `bun test apps/gateway/src/tmux-client/pane-stream-parser.test.ts`
- `bun test packages/shared/src/ws-borsh/convert.test.ts apps/gateway/src/tmux/bell-context.test.ts apps/gateway/src/events/index.test.ts apps/gateway/src/push/supervisor.test.ts`
- `bun test apps/gateway/src/ws/index.test.ts apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts`
- `bun run --filter @tmex/gateway test`
- `bun run --filter @tmex/shared test`
- `bun run build`
- `TMEX_E2E_GATEWAY_PORT=19663 TMEX_E2E_FE_PORT=19883 bun --cwd apps/fe scripts/run-e2e.ts tests/settings.spec.ts tests/mobile-settings.spec.ts`：2 个与本次设置/Webhook 改动直接相关的前端 E2E 全通过。
- `bun --cwd apps/fe scripts/run-e2e.ts`（手工启动独立 Gateway/FE 后执行）：37 个用例通过，2 个失败，失败点为既有 `sidebar-delete.spec.ts` 与 `terminal-selection-canvas.spec.ts`，与本次通知功能改动无关。

## 风险与备注

- 前端现有 Playwright `webServer` 在当前环境下会残留子进程并误判端口占用，因此前端 E2E 采用手工起服务后再执行测试。
- 对于 `OSC` 终结符中的 `BEL`，解析层已消费并避免本地 parser 误报 bell；tmux hook 侧若仍报告 bell，则统一走同一去重窗口。
- 由于 shell 回显与 tmux `send-keys` 组合在集成测试里难以稳定构造“后台 pane 原始 OSC 字节”场景，本轮把关键验证重点放在 parser 单测、WS/推送单测、连接层 reader 生命周期测试以及前端设置/E2E 上，而未保留脆弱的后台 pane OSC 集成用例。
