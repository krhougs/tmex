# Prompt Archive

## 用户需求（摘录）

1. 设置中增加两个选项：
   - 开启浏览器中的 bell toast
   - 开启 Telegram Bot 的 bell 推送
2. Telegram 推送格式（需要 i18n）：

```text
🔔 Bell from ${siteName}: ${terminalTopbarLabel}

<a href="${link}">点击查看</a>
```

3. 要求上网确认 Telegram HTML 消息格式和 escape 规则。

## 已确认约束

- 维持当前前端 tmux 数据获取方式不变。
- 维持后端处理前端连接方式不变。
- bell 推送由独立 supervisor 链路触发（已有实现）。
- 同一 bell 事件可同时触发网页 Toast 与 Telegram 推送（由开关控制）。

## 外部规范核对

已核对 Telegram Bot API 官方文档：
- `https://core.telegram.org/bots/api#sendmessage`
- `https://core.telegram.org/bots/api#formatting-options`

关键点：
- `parse_mode=HTML` 时支持有限标签（含 `<a href="...">`）。
- 文本中的 `<`、`>`、`&` 需转义。
- 仅保证命名实体 `&lt;`、`&gt;`、`&amp;`、`&quot;`；建议优先使用这些。
