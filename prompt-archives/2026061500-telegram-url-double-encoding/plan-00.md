# Plan-00：修复 Telegram 推送 pane URL 双重编码

## 问题现象

- 浏览器正确 URL：`/devices/<id>/windows/@0/panes/%250`
  - `%250` = `encodeURIComponent("%0")`，pane id 为 tmux `%0`，单次编码。
- Telegram 推送实际 URL：`/devices/<id>/windows/%2540/panes/%25250`
  - `%25250` = `encodeURIComponent` 作用两次于 `%0`（`%0`→`%250`→`%25250`）。
  - 即 Telegram 链接被多编码了一次。

## 根因（已确认）

`apps/gateway/src/events/index.ts`：

1. 提交 `88d02d1 "fix: tg url"` 引入 `encodePercentForTelegramUrl(url) = url.replace(/%/g, '%25')`。
   当时 `buildPaneUrl` 对 windowId/paneId **不做编码**（原样拼接），
   该函数负责把原始 tmux id（含 `%`/`@`）做**唯一一次**百分号编码，结果正确。
2. 提交 `890a7fc "wip: fe"` 把 `buildPaneUrl` 改成
   `encodeURIComponent(windowId)` / `encodeURIComponent(paneId)`，
   URL 自身已正确编码，但 `encodePercentForTelegramUrl` 被遗留，
   导致 Telegram 链接被**二次编码**。

`bell-context.ts` 的 `paneUrl`（原生推送）只用一次 `encodeURIComponent`，正确，不受影响。

## 修复方案

仅改 `apps/gateway/src/events/index.ts`：

- 删除 `encodePercentForTelegramUrl` 函数。
- 三处 `const tgSafePaneUrl = encodePercentForTelegramUrl(paneUrl);` 改为直接使用 `paneUrl`
  （`formatTelegramBellMessage` / `formatTelegramNotificationMessage` / `formatTelegramMessage`）。

测试 `apps/gateway/src/events/index.test.ts`：

- 现有断言期望的是 buggy 双编码值（`windows/%25401/panes/%25251`），
  改为正确单编码值（`windows/%401/panes/%251`）。

## 验收标准

- `bun test apps/gateway/src/events/index.test.ts` 通过，断言为单编码 URL。
- Telegram 链接 = 浏览器 URL（语义等价，`@`/`%` 单次 encodeURIComponent）。
- 原生推送路径（bell-context → supervisor）不受影响。

## 风险

- 极低。改动局部、有单测覆盖；不触碰生产。
