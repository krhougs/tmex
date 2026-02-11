# Plan 00：Bell 双通道开关与 Telegram HTML 文本升级

时间：2026-02-11

## 背景

当前 bell 事件已由独立 push supervisor 触发 Telegram/Webhook 通知，前端通过既有 WS 事件展示 Toast。
本次需要在不变更连接架构的前提下，补齐开关控制并升级 Telegram 消息格式。

## 目标

1. 站点设置新增两个布尔开关（默认都开启）：
   - `enableBrowserBellToast`
   - `enableTelegramBellPush`
2. 前端 bell Toast 受 `enableBrowserBellToast` 控制。
3. Gateway bell Telegram 推送受 `enableTelegramBellPush` 控制。
4. bell Telegram 文本改为 HTML parse mode 并支持 i18n，含可点击链接。
5. 按官方规则处理 HTML 转义与链接安全。

## 注意事项

1. 不改变前端 tmux 数据获取和后端 WS 连接处理路径。
2. 仅对 `terminal_bell` 应用 Telegram 开关；不影响其它事件推送。
3. 保持默认行为兼容（升级后仍可同时收到 Toast + Telegram）。

## 实施步骤

1. 扩展 shared 类型与 site settings API 输入。
2. 扩展 DB schema、初始化、读取、更新逻辑。
3. 设置页新增两个开关并持久化。
4. tmux store 的 bell toast 分支增加开关判断。
5. EventNotifier 增加 bell telegram 开关判断与 HTML 消息构建。
6. TelegramService `sendToAuthorizedChats` 支持可选 `parseMode`。
7. 新增 i18n 文案键并补充测试。

## 验收标准

1. 两开关都开启时：同一 bell 同时产生网页 Toast 与 Telegram 推送。
2. 关闭任一开关只影响对应通道。
3. Telegram 推送为 HTML 链接格式，动态文本安全转义。
4. 现有推送链路与其它事件行为保持兼容。
