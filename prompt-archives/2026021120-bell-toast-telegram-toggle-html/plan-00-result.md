# Plan 00 执行结果

时间：2026-02-11

## 完成项

1. 站点设置新增两个布尔开关并全链路生效（shared type / DB / API / FE）：
   - `enableBrowserBellToast`
   - `enableTelegramBellPush`
2. 前端 `event/tmux` 的 bell Toast 已接入 `enableBrowserBellToast` 开关控制。
3. Gateway bell Telegram 推送已接入 `enableTelegramBellPush` 开关控制。
4. bell Telegram 消息改为 HTML 模式，格式为：
   - `🔔 Bell from ${siteName}: ${terminalTopbarLabel}`
   - 空行
   - `<a href="${link}">点击查看/Click to view</a>`（随语言）
5. 新增 Telegram HTML 转义与 URL 安全处理：
   - 文本转义：`& < >`
   - 属性转义：在文本转义基础上追加 `"`
   - URL 仅允许 `http/https`
6. 已新增/更新 i18n 文案（中英文）。
7. 已新增 Gateway 测试覆盖 bell 开关与 HTML 格式逻辑。
8. 已生成数据库迁移：`apps/gateway/drizzle/0001_lowly_the_twelve.sql`。

## Telegram 官方规则核对

已按官方文档落实：
- `https://core.telegram.org/bots/api#sendmessage`
- `https://core.telegram.org/bots/api#formatting-options`

关键规则：
- `parse_mode=HTML` 支持有限 HTML 标签（含 `<a href="...">`）。
- 动态文本必须转义 `<`、`>`、`&`。
- 链接需做协议校验与属性转义。

## 验证记录

1. Gateway 全量测试（带测试环境变量）通过：

```bash
DATABASE_URL=/tmp/tmex-gateway-test.db TMEX_BASE_URL=http://127.0.0.1:8085 bun run --filter @tmex/gateway test
```

结果：`57 pass, 0 fail`

2. Gateway 构建通过：

```bash
bun run --filter @tmex/gateway build
```

3. Frontend 构建通过：

```bash
bun run --filter @tmex/fe build
```

4. 变更文件通过 Biome 检查：

```bash
bunx @biomejs/biome check <changed-files>
```

## 备注

- 直接运行 `bun run --filter @tmex/gateway test` 时，若未设置 `DATABASE_URL`，测试环境可能因默认 `/data/tmex.db` 不可写而失败。
