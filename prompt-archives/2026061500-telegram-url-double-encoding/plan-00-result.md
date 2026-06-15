# Plan-00 执行结果

## 结论

Telegram 推送 pane 链接被**二次百分号编码**，根因是 `apps/gateway/src/events/index.ts`
中遗留的 `encodePercentForTelegramUrl`。

## 根因（git 时间线）

1. `88d02d1 "fix: tg url"` 引入 `encodePercentForTelegramUrl(url)=url.replace(/%/g,'%25')`。
   当时 `buildPaneUrl` 对 windowId/paneId 原样拼接（不编码），该函数承担唯一一次编码，正确。
2. `890a7fc "wip: fe"` 把 `buildPaneUrl` 改为 `encodeURIComponent(windowId/paneId)`，
   URL 自身已正确编码，但 `encodePercentForTelegramUrl` 未删除 → 二次编码。

验证链路（pane `%0`）：
`encodeURIComponent("%0")` → `%250` → `.replace(/%/g,'%25')` → `%25250`，
与用户上报的 telegram 段 `%25250` 完全一致。

## 改动

仅 `apps/gateway/src/events/index.ts`：
- 删除 `encodePercentForTelegramUrl` 函数。
- 三处链接构造（bell / notification / 通用）改为直接使用 `paneUrl`，去掉 `tgSafePaneUrl`。

测试 `apps/gateway/src/events/index.test.ts`：
- 两处断言由双编码 `windows/%25401/panes/%25251` 改为正确单编码 `windows/%401/panes/%251`。

## 验证

- `bun test apps/gateway/src/events/index.test.ts`：5 pass（TDD：先红后绿）。
- `bun test push/supervisor.test.ts tmux/bell-context.test.ts`：7 pass（原生推送路径不受影响）。
- 用户场景：window `@0`→`%400`（解码回 `@0`，与浏览器语义等价），pane `%0`→`%250`（与浏览器完全一致）。
- `tsc --noEmit`：`events/index.ts` 无报错（其余为仓库既有、与本次无关的报错）。

## 备注

- `bell-context.ts` 的 `paneUrl`（→ supervisor 原生推送）只编码一次，本就正确，未改动。
- 全程未触碰生产环境；通过单测复现，未实际开关生产窗口。
