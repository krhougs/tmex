# tmex 通知系统接入微信 ClawBot（iLink 协议）方案

## 一、背景（Context）

tmex 现有通知系统已支持两条出站渠道：通用 **Webhook**（HMAC 签名）和 **Telegram Bot**（多实例、加密 token、授权会话、长轮询）。分发中枢是 `EventNotifier.notify()`，对终端响铃 / 终端通知 / tmux 关闭 / 设备断连 / agent 完成 / watch 触发等事件做节流后，`Promise.all` 并发推送到各渠道。

目标：新增一条**微信渠道**，让用户能在**真·个人微信号**（非企业微信群、非公众号）上收到 tmex 告警。

### 关键调研结论（已交叉验证，决定方案形态）

1. **不用官方 `@tencent-weixin/openclaw-weixin-cli`**：它只是 OpenClaw（AI Gateway 框架）的微信插件**安装器**（npm v2.1.4，peer dep `openclaw>=2026.3.0`），要把整个 OpenClaw Gateway 当常驻进程跑。过重，弃用。

2. **走 iLink 协议 + 社区逆向**：官方插件底层是腾讯 iLink 协议（`https://ilinkai.weixin.qq.com`）。社区已有独立逆向客户端 `photon-hq/wechat-ilink-client`（MIT、零依赖、Node>=20）。**本项目 Bun-only，决定自行 vendor 协议进 tmex**（参照官方 `Tencent/openclaw-weixin` 的 `src/api/api.ts`+`types.ts` 与 `hao-ji-xing/openclaw-weixin` 的 `weixin-bot-api.md`），不引入外部依赖。

3. **硬约束：iLink 只能"会话窗口内回复"，无主动推送**。源码级证据（`wechat-ilink-client/client.ts`）：
   ```ts
   private contextTokens = new Map<string, string>();
   // send 时：const ct = contextToken ?? this.contextTokens.get(to);
   // if (!ct) throw new Error(`No context_token for user ${to}. Receive a message from them first.`);
   // 长轮询 onMessage：收到消息时 this.contextTokens.set(from_user_id, context_token)
   ```
   每条 `sendmessage` 必须回传一个来自 inbound 消息的 `context_token`，否则静默丢弃。**token 失效 TTL 官方无文档，是头号风险，必须实测验证**。

4. **采用"半主动·最佳努力"语义**（用户已确认）：daemon 长轮询缓存并落库每个授权用户的最新 `context_token`；告警用缓存 token 发出；token 失效 / `sessionExpired` 时前端提示"去给 bot 发条消息重新激活"，同类故障**只告警一次**、恢复后重置（契合项目 fail-fast / notify-once 原则）。

5. **架构：抽象成渠道注册表**（用户已确认）：把 webhook / telegram / weixin 统一成 `NotificationChannel` 接口 + 注册表，`EventNotifier` 遍历分发，消除硬编码。

## 二、iLink 协议要点（vendor 实现依据）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | GET | 取登录二维码 |
| `/ilink/bot/get_qrcode_status?qrcode=xxx` | GET | 轮询扫码确认，`confirmed` 时返回 `bot_token` + `baseurl` |
| `/ilink/bot/getupdates` | POST | 长轮询收 inbound（最多挂 35s），游标 `get_updates_buf` |
| `/ilink/bot/sendmessage` | POST | 发出站消息 |

- **鉴权头**：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`、`X-WECHAT-UIN: base64(String(random uint32))`（每请求重生成）。
- **发送体**：`{ msg: { to_user_id, message_type:2, message_state:2, context_token, item_list:[{type:1, text_item:{text}}] }, base_info:{channel_version} }`。
- **消息类型**：text(type 1) 起步；图片/文件(需 CDN 加密上传) 与 bot 卡片(type 12, markdown) 后置。
- 凭证持有方为调用者：保存 `bot_token` / `accountId` / `baseUrl` + 长轮询游标。

## 三、改动清单（基于真实代码结构）

### A. 渠道注册表重构（先做，保证行为不变 + 测试覆盖）
- `apps/gateway/src/events/index.ts:46-350`：抽出 `NotificationChannel` 接口
  ```ts
  interface NotificationChannel {
    readonly id: 'webhook' | 'telegram' | 'weixin';
    refresh?(): void | Promise<void>;
    notify(eventType: EventType, event: WebhookEvent): Promise<void>;
  }
  ```
  `EventNotifier` 持有 `channels: NotificationChannel[]`；`notify()` 保留现有节流逻辑（`shouldPassBellThrottle` / `shouldPassNotificationThrottle`），再 `Promise.all(channels.map(c => c.notify(...)))`。
- 新增 `apps/gateway/src/events/channels/`：
  - `webhook.ts`：迁移现有 `sendWebhooks` / `sendWebhook` / `generateHmac`（行为字节级不变）。
  - `telegram.ts`：迁移现有 `sendTelegramNotifications` + 全部 `formatTelegram*Message` 格式化函数（行为字节级不变）。
  - `weixin.ts`：新渠道，详见 D。
- **回归风险点**：webhook / telegram 是已稳定链路，重构后须用单测断言"各渠道被调用 + 节流生效 + 格式化输出不变"。

### B. 数据模型（`apps/gateway/src/db/schema.ts` + `db/index.ts`）
- 新增 `weixinAccounts` 表（仿 `telegramBots`）：`id, name, accountId, botTokenEnc, baseUrl, enabled, allowAuthRequests, syncBuf(长轮询游标), createdAt, updatedAt`。`botToken` 用 `crypto/decryptWithContext({scope:'weixin_account', entityId, field:'bot_token_enc'})` 加密落库。
- 新增 `weixinAccountUsers` 表（仿 `telegramBotChats`）：`id, accountId(FK), userId(from_user_id), displayName, status('pending'|'authorized'), lastContextToken(最佳努力缓存), lastInboundAt, needsReactivation(boolean), appliedAt, authorizedAt, updatedAt`。
- `siteSettings` 单例新增：`enableWeixinBellPush`、`enableWeixinNotificationPush`（默认 `false`）。
- `db/index.ts` 补 CRUD helper（仿 `getAllTelegramBots` / `listAuthorizedTelegramChatsByBot` / `createOrUpdatePendingTelegramChat`）。
- **迁移**：按 telegram 表当初引入的同一迁移机制落 schema（先查 `db/` 现有迁移方式再照做）。

### C. iLink 协议 vendor（新目录 `apps/gateway/src/weixin/ilink/`）
- `types.ts`：`WeixinMessage`、`SendMessageReq/Resp`、`GetUpdatesReq/Resp`、item 类型。
- `api.ts`：4 个端点的低层 HTTP（Bun `fetch`），封装鉴权头与 `X-WECHAT-UIN` 生成。
- `client.ts`：`WeixinClient`
  - 构造：`new WeixinClient({ accountId, botToken, baseUrl })`，免扫码恢复会话。
  - `login({onQRCode})`：取二维码 + 轮询 `get_qrcode_status`，返回凭证。
  - `start({signal, loadSyncBuf, saveSyncBuf})`：长轮询循环，收消息时更新 `contextTokens` Map 并回调持久化。
  - `stop()`、`sendText(to, text, ct?)`、事件 `message` / `sessionExpired` / `error`。
  - 启动时从 DB 注水 `contextTokens`（重启不丢激活态）。

### D. 微信服务 + 渠道（`apps/gateway/src/weixin/service.ts` + `events/channels/weixin.ts`）
- `WeixinService`（仿 `telegram/service.ts`）：多账号管理、`decryptWithContext` 解密凭证、`refresh()` 启停 `WeixinClient`、长轮询。
  - inbound 消息 → 缓存+落库 `lastContextToken`、`lastInboundAt`；首发者按 `allowAuthRequests` 走 pending/authorized 配对（仿 telegram `/start`）。
  - `sendToAuthorizedUsers({text})`：遍历 `status='authorized'` 且有缓存 token 的用户发送。
  - 发送抛 `No context_token` / `sessionExpired` → 置 `needsReactivation`，**只告警一次**，恢复后重置。
- `weixin.ts` 渠道：检查 `enableWeixin*Push` 开关 → 调 `formatWeixinMessage(event)`（纯文本版，参照 `formatTelegram*Message` 结构但去 HTML/链接转纯文本，附 pane 直链文本）→ `weixinService.sendToAuthorizedUsers`。

### E. API 路由（`apps/gateway/src/api/index.ts`，仿 telegram）
- 账号 CRUD：`/api/settings/weixin/accounts` GET/POST/PATCH/DELETE。
- 扫码登录流：`POST /api/settings/weixin/accounts/:id/login/start`（触发 `login`，返回二维码）+ `GET .../login/status`（轮询确认，成功落库凭证）。
- 用户：`/api/settings/weixin/accounts/:id/users` GET、authorize/revoke、测试消息。

### F. 前端设置 UI（`apps/fe/src/components/settings/`，仿 telegram 一套）
- `weixin-accounts-tab.tsx` + `weixin-account-row.tsx` + `weixin-account-form-modal.tsx`（含二维码展示 + 扫码状态轮询）+ `weixin-account-users-modal.tsx`（授权用户 + "会话已过期/去激活"提示）。
- `apps/fe/src/pages/SettingsPage.tsx` notifications tab 内新增"微信"子 tab 与 Bell/Notification 推送开关。
- 二维码渲染：iLink 返回 qrcode 串 → 前端用 QR 组件渲染（先查 FE 是否已有 QR 依赖，无则评估引入或服务端生成图）。

### G. i18n（`packages/shared/src/i18n/`）
- 新增 `weixin.*` 文案（激活提示、配对 pending/success、会话过期）与 weixin 消息模板键。
- **跑 `bun run build:i18n` 重生成，禁止手改 `resources.ts` / `types.ts`**。

### H. 共享类型（`packages/shared/src/index.ts`）
- 导出 weixin 渠道相关类型（账号/用户 DTO）；`EventType` 复用不变。

## 四、验收（Verification）

> 严禁触碰本机生产 tmex（端口 9883、`~/Library/Application Support/tmex/`）。一律在仓库内起临时实例，显式覆盖 `TMEX_FE_DIST_DIR` / `GATEWAY_PORT` / `TMEX_BIND_HOST`，e2e 用 9885/9665。

1. **单元测试**：iLink `api.ts`（mock fetch、断言鉴权头与发送体）；`client.ts` 的 context_token 缓存与"无 token 抛错"；渠道注册表分发（各渠道被调用、节流生效、webhook/telegram 输出与重构前一致）；`formatWeixinMessage`。
2. **实测集成测试**（`*.integration.ts`，`requireLiveEnv` 守卫，凭证放 `test.env.local`，仅 `test:live:*` 跑）：真实扫码登录 + 发送；**重点实测 `context_token` 失效 TTL**（头号风险），记录闲置多久后发送失败。
3. **手工 E2E**：设置页加账号 → 扫码 → 给 bot 发条消息激活 → 触发终端响铃 → 确认微信收到 → 闲置观察过期行为与 UI 提示。
4. **视觉自验**：无头浏览器截图 + 像素断言验收设置页"微信"tab 与二维码弹窗（不甩给用户手动看）。

## 五、风险

1. **`context_token` TTL 未知**（核心）：以"半主动·最佳努力 + UI 重激活 + 实测测量"兜底。
2. **iLink 为逆向/非官方用法**：与官方插件同协议，封号风险低于 itchat/wechaty，但仍属非官方，需声明。
3. **Bun fetch 与协议头兼容**（`X-WECHAT-UIN`、Content-Length 已知 issue）：vendor 时实测。
4. **渠道注册表重构回归** webhook/telegram：保持行为字节级不变 + 测试覆盖。
5. **二维码扫码登录是新 UX 面**：长轮询 daemon 生命周期（启动注册、关停、重连）仿 telegram + connection-alerts 的 fail-fast。

## 六、落地前置（先存档，再干活）

1. **开新 git worktree**（off `main`，如分支 `feat/weixin-clawbot-notify`）。
2. **建归档目录** `prompt-archives/2026062000-weixin-clawbot-notify/`，写入 `plan-prompt.md`（存档本轮所有 prompt）与 `plan-00.md`（本计划）。实现完成后补 `plan-00-result.md`。
