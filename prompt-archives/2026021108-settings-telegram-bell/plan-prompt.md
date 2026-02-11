# Prompt Archive

时间：2026-02-11
目录：2026021108-settings-telegram-bell

## 用户需求（原始）

做如下改进：
1. 新增设置页：
1.1 支持调整站点名称，即标题栏和sidebar上的tmex字样
1.2 支持设置站点访问URL用于给bot发的消息拼的字符串
1.3 支持设置多个telegram bot key，对于每个bot，支持最多8个授权的chat（已授权+待授权），授权需要在网页中选择批准或拒绝（拒绝即删除），列表中要显示申请时间、chat id、人名/群组名，对于已授权的chat显示测试消息按钮和撤销授权按钮
2. 所有错误提示应该使用 shadcn 的sonner展示
3. ssh连接失败会导致整个gateway退出，需要改进
4. 对于tmux终端中传来的bell，网页中需要使用sonner展示，点击sooner toast可跳转去对应的pane，同时需要给所有授权的bot chat发送通知，通知中包括 device window panel 站点名 等信息，同时包含直达pane的链接

## 后续澄清

1. Telegram 授权来源使用轮询 `getUpdates`。
2. 授权关系按 bot 独立。
3. 站点配置存数据库并可网页修改。
4. bell 频控做成设置项，默认 6 秒。
5. SSH 失败改为自动重连，新增重连次数与等待时间设置，默认 2 次 / 10 秒。
6. Telegram bot 功能优先使用 `gramio`。
7. 每个 bot 增加“允许申请授权”开关。
8. 设置页提供“重启 Gateway”按钮，重启语义为主循环平滑停副作用后自拉起。
9. 站点名全站统一替换。
10. 密码鉴权和相关代码可完全删除，默认内网部署。

## 执行指令

Implement the plan.
