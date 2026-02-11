# Plan 00：无鉴权设置中心 + Telegram 多 Bot + Bell 通知 + Gateway 韧性

时间：2026-02-11

## 背景

当前系统存在以下问题：
1. 缺少统一设置页，站点名/站点 URL 与通知相关配置无法在界面管理。
2. Telegram 仅有单 token + 订阅模型，不支持多 bot 审批授权流。
3. 错误提示分散，未统一使用 sonner。
4. SSH 连接失败可能影响网关稳定性。
5. bell 事件缺少前端可跳转提示与 Telegram 直达链接通知。
6. 用户确认系统默认部署在内网，要求移除密码鉴权。

## 目标

1. 移除前后端全部密码鉴权与登录流程。
2. 新增设置页，支持站点配置、bell 频控、SSH 重连参数、Telegram 多 bot 管理。
3. 建立 bot 维度的待授权/已授权 chat 审批流（每 bot 最多 8 个）。
4. bell 事件使用 sonner 提示并支持跳转 pane，同时向授权 chat 推送含直达链接消息。
5. Gateway 改为可平滑重启的主循环模型，连接失败仅影响单设备并支持自动重连。

## 关键决策

1. Telegram 使用 `gramio`，待授权来源仅 `/start`。
2. 授权按 bot 独立，不做跨 bot 共享。
3. 所有设置项存数据库；默认值：bell 6 秒、重连 2 次 / 10 秒。
4. 错误提示统一 sonner；页面内旧错误块不再承担主要错误提示职责。
5. 重启通过后端主循环协作式停止并重新启动，不用粗暴退出进程。

## 实施任务

1. 后端移除鉴权模块与相关路由/校验。
2. 扩展 shared 类型、数据库 schema（site_settings、telegram_bots、telegram_bot_chats）。
3. 新增 settings 与 Telegram bot/chat 管理 API。
4. 接入 gramio 服务层：bot 生命周期、/start 申请、授权后发送消息。
5. 重构 Gateway 入口为主循环 + 可重启控制器。
6. 改造 SSH 连接失败处理为设备级隔离与自动重连。
7. 扩展 bell 事件上下文与通知格式，提供 pane 直达链接。
8. 前端新增设置页与路由，接入站点名与 bot 授权管理。
9. 前端全局接入 sonner，并替换主要错误提示路径。
10. 补充测试并归档执行结果。

## 验收标准

1. 无需登录即可使用设备页、终端页、设置页与全部 API/WS。
2. 设置页可完整管理站点配置与 bot 审批流，数据刷新后保持一致。
3. bell 到达时网页出现可点击跳转的 sonner toast。
4. bell 会向所有授权 chat 发送含站点名、device/window/pane 与直达链接的通知。
5. SSH 失败不会导致 gateway 整体退出，自动重连按设置生效。
6. Gateway 重启按钮可触发平滑重启并恢复服务。
