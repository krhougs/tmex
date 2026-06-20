# 执行结果总结：通知系统接入微信 ClawBot（iLink）

分支：`worktree-weixin-clawbot-notify`。状态：实现完成，已通过多 agent 对抗式 review + 修复，全量验证绿。

## 一、最终方案（与计划一致）

- **不用**官方 `@tencent-weixin/openclaw-weixin-cli`（它只是 OpenClaw 框架的微信插件安装器，过重）。
- **自行 vendor 腾讯 iLink bot 协议**进 `apps/gateway/src/weixin/ilink/`（Bun 原生、零外部依赖），参照社区逆向产物与官方 `Tencent/openclaw-weixin`。
- 通知分发重构为 **NotificationChannel 注册表**（webhook / telegram / weixin），行为字节级保持。
- **半主动·最佳努力**推送语义：长轮询缓存每个授权用户最新 `context_token` 落库，告警复用；失效 / sessionExpired 时清凭证、标记 `needsReactivation`、单次告警（notify-once），前端引导重新扫码激活。

## 二、核心约束（已落地）

iLink 只能在会话激活窗口内回复：每条 `sendmessage` 必须带来自 inbound 的 `context_token`，无主动 push。映射到 tmex：用户先给 bot 发条消息激活 → 缓存 token → 后续告警复用。**token 失效 TTL 官方无文档，是头号风险，须实测**（见验证）。

## 三、改动清单

**iLink 协议**（新）：`weixin/ilink/{types,api,client}.ts` + 单测。4 端点（get_bot_qrcode / get_qrcode_status / getupdates / sendmessage）、鉴权头、长轮询、context_token 缓存、扫码登录。

**服务 + 渠道**：`weixin/service.ts`（多账号、扫码登录编排、长轮询、inbound 配对/缓存、半主动发送 + notify-once）；`events/channels/weixin.ts`（纯文本格式化 + 开关 gating）。

**渠道注册表**：`events/index.ts`（EventNotifier 只剩节流 + 遍历分发）+ `events/channels/{types,webhook,telegram,pane-url}.ts`（webhook/telegram 逻辑原样迁移）。

**DB**：`db/schema.ts` 加 `weixinAccounts` / `weixinAccountUsers` 两表 + `siteSettings.enableWeixin{Bell,Notification}Push`（默认 false）；`db/index.ts` 加全套 helpers；迁移 `drizzle/0010_lucky_kabuki.sql`。

**API**：`api/index.ts` 加 `/api/settings/weixin/*`（账号 CRUD + 扫码登录流 login/start|status + 用户授权/测试/删除）。

**前端**：`apps/fe/src/components/settings/weixin-account{s-tab,-row,-form-modal,-login-modal,-users-modal}.tsx` + `SettingsPage.tsx`（2 个推送开关 + 微信子 tab）+ `stores/site.ts` 默认值。

**i18n**：en/zh/ja 三 locale 加 `weixin.*`（61 key）+ `settings.enableWeixin*Push`，`build:i18n` 重生成。

**接线 + 实测**：`runtime.ts` 接 `weixinService.refresh/stopAll`；`send-live.integration.ts` + `test:live:weixin` 脚本探测 context_token TTL。

## 四、对抗式 review 修复（9 条确证缺陷全部已修）

| 级别 | 问题 | 修复 |
|---|---|---|
| high | 长轮询无 per-request 超时 → TCP 黑洞永久挂起 | `getUpdates` 加 `AbortSignal.timeout`（服务端窗口 + margin），超时按失败走 backoff 重连 |
| high | `readJson` 不检查 `resp.ok` → 5xx 被当成功（热循环 + 误判已送达清掉 needsReactivation） | 非 2xx 抛带 status 错误 |
| high | `refresh()` 无重入保护 → 并发 token 变更泄漏游离 client | refresh 串行化（promise 链）+ doRefresh 清理孤儿登录会话 |
| high | FE 登录轮询无 abort/代际守卫 → 关开抖动产生并行轮询链 + 对已关弹窗弹 toast | 代际计数 + AbortController，迟到 resolve/排程一律丢弃 |
| medium | login 单次抖动即整体失败（8 分钟扫码窗口） | getQrcodeStatus 瞬时失败重试到 deadline |
| medium | backoff 阈值复位 → 长退避形同虚设 | 指数退避封顶，仅成功后复位 |
| medium | FE cleanup 不中止在途 fetch | 同 high-④ 一并修 |
| low | 删账号遗留 loginSession + 最长 8 分钟上游轮询 | doRefresh 按 activeIds 中止孤儿登录会话 |
| low | 二维码 fallback 到 token → 坏图 | 后端缺图像内容时 fail-loud，不回退 token |

新增 4 个回归测试（5xx 抛错 ×2、per-request 超时重连、login 瞬时重试）。

## 五、验证结果

- 完整 gateway 测试：**644 pass / 0 fail（66 文件）**。
- gateway tsc：我的新文件 **0 类型错误**（其余为 main 预存错误，与本改动无关）。
- FE tsc：clean。
- biome lint：全部改动文件 clean。
- 启动冒烟：`createGatewayRuntime()` 完整 boot（迁移 + 全 service refresh）+ weixin 路由 GET 200 / POST 201 + stop() 干净。

## 六、仍需人工验证（无法自动化）

1. **真实扫码登录**：设置页加账号 → 扫码 → 给 bot 发消息激活 → 触发终端响铃确认微信收到。二维码字段格式（`qrcode_img_content`）需真实端点确认。
2. **context_token TTL 实测**（头号风险）：凭证填 `test.env.local`，`test:live:weixin` + `TEST_WEIXIN_TTL_DELAY_MS` 跨多次运行二分失效时长。
3. **前端视觉**：设置页微信 tab + 二维码弹窗的渲染（未跑无头截图，因二维码需真实端点）。

## 七、注意事项

- iLink 为逆向 / 非官方用法（与官方插件同协议，封号风险低于 itchat/wechaty，但仍属非官方），需向用户声明。
- 默认两个微信推送开关均 false，需用户在设置页显式开启。
- 严禁触碰本机生产 tmex（9883 常驻服务），验证一律仓内临时实例。
