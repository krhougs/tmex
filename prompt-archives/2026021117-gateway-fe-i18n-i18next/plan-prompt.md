# Prompt Archive：gateway fe i18n i18next

## User Prompt 00

请为gateway和前端引入i18next，将所有最终客户可见的文案替换为i18n之后的文字。请准备zh_CN和en_US两个语言包。
前后端可以共用同一个语言包文件。
设置中加入一个语言选项，默认为en_US。
所有地方都不要做自动语言识别，严格按照设置中的语言选项展示文案。

## Clarification 01（由选项确认）

- 文案范围：全覆盖（前端全部可见文案 + Gateway API 错误 + WS 事件消息 + Telegram/Webhook 通知）。
- WS 错误展示策略：并排显示本地化摘要与 raw 原始错误。
- 语言设置生效时机：刷新后生效。

## User Prompt 02

存档这个plan，先别开工

## User Prompt 03

应该让e2e代码不依赖文案

## User Prompt 04

好的

## User Prompt 05

prompt-archives/2026021117-gateway-fe-i18n-i18next/plan-00.md 你的同事说他把这个plan完成了，请验证，并出一个报告

## User Prompt 06

请想办法完成这个plan，另外：
1. 引入drizzle orm，重建数据库schema，引入正规的db migration，db migration在gateway启动时执行。（可以不管之前的数据库）
2. 将gateway中的sql操作全部换成安全的orm操作

## User Prompt 07

Implement the plan.

## User Prompt 08

Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.
（该提示在会话中重复出现多次）

## User Prompt 09

Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work.
（附带了已完成项、未完成项、验证记录和建议执行顺序）
