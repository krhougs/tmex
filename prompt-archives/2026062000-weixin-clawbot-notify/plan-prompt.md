# Prompt 存档

## 背景

给 tmex 通知系统新增一条「微信」出站渠道，让用户在真·个人微信号（非企业微信群 / 非公众号）上收到 tmex 告警。现有渠道为通用 Webhook + Telegram Bot，分发中枢 `EventNotifier.notify()`。

调研三路结论（详见 plan-00.md）：
- 官方 `@tencent-weixin/openclaw-weixin-cli` 只是 OpenClaw 框架的微信插件安装器，过重，弃用。
- 底层为腾讯 iLink 协议（`ilinkai.weixin.qq.com`）。社区有独立逆向客户端 `photon-hq/wechat-ilink-client`（MIT）。
- **硬约束**：iLink 只能「会话窗口内回复」，每条发送必须回传 inbound 消息的 `context_token`，无主动 push 能力。token 失效 TTL 无文档，是头号风险，须实测。

## 用户原始 prompt（按时间顺序）

### 1. 触发任务

> 开新的worktree，研究一下通知系统怎么接入微信ClawBot。你不仅需要研究 @tencent-weixin/openclaw-weixin-cli@latest ，更需要搜索研究社区和github上已经有的方案

### 2. 计划阶段澄清（AskUserQuestion 选择）

- 微信渠道：选 **WeChat ClawBot（openclaw-cli）/ iLink**（真·个人微信），而非企业微信群机器人 / WxPusher。
- 渠道架构：选 **抽象成渠道注册表**（NotificationChannel 接口 + 注册表），而非照 Telegram 硬编码。

### 3. 放宽实现载体

> 不一定要用官方的clawbot实现，社区有现成的逆向产物

### 4. 两个落地抉择（AskUserQuestion 选择）

- 实现载体：**自行 vendor iLink 协议进 tmex**（Bun 原生、零外部依赖），而非直接依赖 `wechat-ilink-client`。
- 推送语义：**半主动·最佳努力**（缓存每用户最新 context_token 落库；告警用缓存 token 发；失效/sessionExpired 时前端提示「去给 bot 发条消息重新激活」+ 告警只发一次、恢复后重置）。

### 5. 批准并下达执行

> 干活
> （effort 设为 ultracode）

## 交付约束

- 在 git worktree 内实施（分支 `worktree-weixin-clawbot-notify`）。
- 先存档，再干活。
- 三套环境规范、严禁触碰本机生产 tmex（9883 常驻服务、`~/Library/Application Support/tmex/`），验证一律仓内临时实例（覆盖 `GATEWAY_PORT`/`TMEX_FE_DIST_DIR`/`TMEX_BIND_HOST`，e2e 用 9885/9665）。
- i18n 跑 `build:i18n` 重生成，禁止手改 / lint 生成文件。
- 渠道注册表重构须保持 webhook/telegram 行为不变 + 测试覆盖。
- 实测 context_token TTL 走 `*.integration.ts`（requireLiveEnv 守卫，凭证放 test.env.local）。
