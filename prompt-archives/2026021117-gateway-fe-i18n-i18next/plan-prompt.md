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
