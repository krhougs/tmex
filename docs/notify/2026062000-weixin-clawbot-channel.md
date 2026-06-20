# 微信（iLink / ClawBot）通知渠道

## 背景

tmex 通知系统原有两条出站渠道：通用 Webhook（HMAC 签名）与 Telegram Bot。本次新增第三条「微信」渠道，让用户在**真·个人微信号**（非企业微信群、非公众号）上收到 tmex 告警（终端响铃、终端通知、agent 完成/待确认、设备断连、watch 触发等）。

底层走腾讯 **iLink bot 协议**（`https://ilinkai.weixin.qq.com`）。未采用官方 `@tencent-weixin/openclaw-weixin-cli`（它只是 OpenClaw 框架的微信插件安装器，需常驻整个框架，过重），而是在仓库内自行 vendor iLink 协议（Bun 原生、零外部依赖）。

## 核心约束（决定 UX 上限）

**iLink 只能在会话激活窗口内回复**：每条 `sendmessage` 必须回传一个来自某条 inbound 消息的 `context_token`，否则消息被静默丢弃；协议**没有主动 push 能力**。

这与 Telegram Bot「可随时主动发消息」的模型根本不同。映射到 tmex 的「主动告警」场景，采用**半主动·最佳努力**语义：

1. 用户先给 bot 发一条消息「激活」会话；
2. 长轮询 daemon 缓存该用户最新 `context_token` 并落库；
3. 告警触发时用缓存的 token 发送；
4. token 失效（闲置过久 / 会话过期）时清凭证、标记 `needsReactivation`、**单次告警**（notify-once），前端引导用户重新给 bot 发消息激活。

> `context_token` 的失效 TTL 官方无文档，是本子系统**头号风险**，须经实测确定（见「验收」）。

## 设计

### 架构总览

通知分发从原先的硬编码（`EventNotifier` 内直接调 webhook + telegram）重构为 **`NotificationChannel` 注册表**：

```
EventNotifier.notify(eventType, event)
  → 节流(bell / notification)
  → Promise.all(channels.map(c => c.notify(eventType, fullEvent)))

channels = [WebhookChannel, TelegramChannel, WeixinChannel]
```

- `apps/gateway/src/events/index.ts`：`EventNotifier` 只保留节流 + 遍历分发。
- `apps/gateway/src/events/channels/`：`types.ts`（接口）、`webhook.ts`、`telegram.ts`、`weixin.ts`、`pane-url.ts`（共用的 pane 直链工具）。新增渠道照此加一个实现即可，无需改分发中枢。

### iLink 协议层（`apps/gateway/src/weixin/ilink/`）

- `types.ts`：wire 类型 + 领域类型（`WeixinCredentials` / `WeixinInboundMessage`）。
- `api.ts`：4 个端点的低层 HTTP（可注入 `fetchImpl` 以便测试）：
  - `GET /ilink/bot/get_bot_qrcode?bot_type=3` —— 取登录二维码（返回 `qrcode` 轮询 ID + `qrcode_img_content` base64 图像）。
  - `GET /ilink/bot/get_qrcode_status?qrcode=…` —— 轮询扫码状态（`wait`/`scaned`/`confirmed`/`expired`），`confirmed` 时返回 `bot_token`/`baseurl`/`ilink_bot_id`。
  - `POST /ilink/bot/getupdates` —— 长轮询收 inbound（游标 `get_updates_buf`）。
  - `POST /ilink/bot/sendmessage` —— 发出站消息（带 `context_token`）。
  - 鉴权头：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、`X-WECHAT-UIN: base64(随机 uint32)`（每请求重生成）。
  - `readJson` 对非 2xx 抛带 status 的错误（避免反代 5xx 空 body 被当成「成功空响应」）。
- `client.ts`：`WeixinClient`，封装 `login`（扫码 + 轮询，单次抖动重试到 deadline）、`start`（长轮询循环，**per-request 超时**防 TCP 黑洞挂起、指数退避、session 过期 `ret/errcode===-14` 抛 `WeixinSessionExpiredError`）、`sendText`（缓存 token，发送失败/过期抛错）。

### 服务层（`apps/gateway/src/weixin/service.ts`）

`WeixinService`（仿 `telegram/service.ts`）：

- 多账号：`refresh()` 与 DB 对账启停长轮询，**串行化**防并发交错泄漏游离 client。
- 扫码登录编排：`startLogin` 取二维码后立即返回、后台推进 `loginSession` 状态；`getLoginStatus` 供前端轮询。
- inbound 处理：新用户按 `allowAuthRequests` 建 pending 行 + 回执「待批准」；已存在用户刷新 `context_token` 并清 `needsReactivation`。
- `sendToAuthorizedUsers`：遍历授权用户用缓存 token 发送；`WeixinNoContextTokenError` / 发送失败 → 置 `needsReactivation`；`WeixinSessionExpiredError` → 清凭证 + 标记 + notify-once。

## 数据模型

迁移 `apps/gateway/drizzle/0010_lucky_kabuki.sql`：

- `weixin_accounts`：`id, name, enabled, allow_auth_requests, weixin_uin, bot_token_enc(加密), base_url, sync_buf(长轮询游标), …`。`bot_token_enc` 非空即「已登录」。
- `weixin_account_users`：`id, account_id(FK cascade), user_id, display_name, status(pending|authorized), last_context_token(最佳努力缓存), last_inbound_at, needs_reactivation, …`。`(account_id, user_id)` 唯一，每账号上限 16 用户。
- `site_settings` 新增 `enable_weixin_bell_push` / `enable_weixin_notification_push`，**默认 false**。

凭证经 `crypto/encrypt` 加密落库，`decryptWithContext({scope:'weixin_account'})` 解密；**绝不在 API 响应或日志输出明文 token**。

## API

均在 `apps/gateway/src/api/index.ts`，前缀 `/api/settings/weixin`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts` | 账号列表（含登录态 + pending/authorized/needsReactivation 计数） |
| POST | `/accounts` | 新建账号（仅 name；扫码登录另走 login/start） |
| PATCH/DELETE | `/accounts/:id` | 改名/启停 / 删除 |
| POST | `/accounts/:id/login/start` | 触发扫码登录，返回二维码 |
| GET | `/accounts/:id/login/status` | 轮询扫码状态 |
| GET | `/accounts/:id/users` | 用户列表 |
| POST | `/accounts/:id/users/:userId/approve` | 批准（userId 需 encodeURIComponent） |
| POST | `/accounts/:id/users/:userId/test` | 测试消息 |
| DELETE | `/accounts/:id/users/:userId` | 移除用户 |

## 扫码登录流程（前端）

`apps/fe/src/components/settings/weixin-account-login-modal.tsx`：调 `login/start` 渲染二维码 → 每 1.5s 轮询 `login/status` → `confirmed`/`loggedIn` 关闭弹窗 + 刷新列表 + toast；`expired`/`error` 给「刷新二维码」按钮。轮询带**代际计数 + AbortController**，关闭/切换/重启时中止在途请求并丢弃迟到 resolve，避免并行轮询链或对已关弹窗误弹 toast。

## 验收

- 单元/集成（默认 `bun test`）：iLink api/client、渠道注册表行为不变、weixin 服务半主动/notify-once、DB helpers、API 路由。
- **context_token TTL 实测**（头号风险，需人工）：
  1. 设置页扫码登录 bot，给它发一条消息激活；
  2. 从 gateway 日志或 `weixin_account_users.last_context_token` 取 token，连同 `bot_token` / `base_url` / `user_id` 填入 `test.env.local`（`TEST_WEIXIN_*`）；
  3. `bun run --filter @tmex/gateway test:live:weixin`（立即发送应成功）；
  4. 设 `TEST_WEIXIN_TTL_DELAY_MS` 跨多次运行二分失效时长，结论看日志 `expired=…`。
- 端到端：设置页加账号 → 扫码 → 激活 → 触发终端响铃 → 确认微信收到 → 闲置观察过期 + UI 重激活提示。

## 风险与注意事项

- iLink 为逆向 / 非官方用法（与官方插件同协议，封号风险低于 itchat/wechaty，但仍非官方），需向用户声明。
- 两个微信推送开关默认关闭，需用户在设置页显式开启。
- 二维码字段 `qrcode_img_content` 的具体格式需真实端点确认；缺图像内容时后端 fail-loud（不回退 token，避免前端坏图）。
- 子系统记忆见仓库外个人记忆 `project_weixin_clawbot_subsystem`。
