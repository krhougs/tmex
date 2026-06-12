# 终端 AI Agent + Watch 监控 — 实现计划

## Context（背景）

tmex 是 Bun.js monorepo 的 tmux Web 终端管理器（`apps/gateway` 服务端 + `apps/fe` React 19 前端 + `packages/shared` 协议/类型/i18n）。本计划为其新增两个能力：

1. **终端 AI Agent**：页面右边栏作为 agent 对话面板（与现有左 sidebar 对称，可拖宽/隐藏），agent 运行在服务端——**浏览器页面关闭不影响 agent 运行**；但 agent 绑定的 SSH 设备连接断开属于故障场景：终端工具调用应当**立即失败**并反馈给模型/用户，设备持续不可达时 run 以 error 结束并通知，不挂起硬等重连。agent 可读写绑定的 tmux pane、web search、fetch 网页；支持多个 OpenAI 兼容 LLM Provider（Chat Completions / Responses 两种协议），自动拉取模型列表；对话历史持久化，多客户端同步。
2. **Watch 监控**（与 agent session 无关的独立功能）：对某个 pane 添加规则，服务端周期采样屏幕，三种触发类型：`match`（正则命中触发）、`unchanged`（正则提取值连续 N 分钟不变 → 判定卡住，核心 use case：下载/上传卡住超过 xx 分钟提醒）、`llm`（自然语言条件，由模型周期看屏判断）；**每条规则独立选择 provider/model**，用于：llm 型周期判断、match/unchanged 可选的触发后 LLM 二次确认（减少误报）、可选的 LLM 生成通知摘要、以及 assist-regex 生成正则；**模型不可用时按降级策略处理且告警通知只发一次**（恢复后重置）。触发走现有 Webhook/Telegram/浏览器通知体系。

### 用户已确认的决策
- Agent 框架：**Vercel AI SDK**（`ai` + `@ai-sdk/openai` + `@ai-sdk/openai-compatible`），Bun 下可用（纯 fetch + Web Streams）
- Web search：**Tavily / Brave API**（用户配 key）+ **Provider 内置搜索透传**（仅 Responses 协议，`openai.tools.webSearch()`，与自建搜索互斥）
- 写终端安全策略：**每 session 可配置 auto/confirm，默认 confirm**；页面不在时确认请求挂起并经通知体系提醒
- Watch 条件：**正则（match + unchanged 多样本时序）+ LLM 辅助生成正则界面**

### 关键现状（已由 3 个 Explore + 2 个 Plan agent 验证）
- WS 协议：Borsh，`packages/shared/src/ws-borsh/{kind,schema,convert,codec}.ts`（29 个 Kind；新增步骤固定：kind.ts 常量 + VALID_KINDS(:46) + kindToString(:82) → schema.ts → 双端接线 → 更新 `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`）
- DB：SQLite + Drizzle，`apps/gateway/src/db/schema.ts`（6 表），drizzle-kit migration，启动时 `runMigrations()`
- 加密：`apps/gateway/src/crypto/index.ts` AES-256-GCM（`TMEX_MASTER_KEY`），API key 复用
- 通知：`eventNotifier.notify(eventType, event)`（`apps/gateway/src/events/index.ts:71`）→ Webhook(HMAC)+Telegram；浏览器通知走 WS
- 后台任务范式：`apps/gateway/src/push/supervisor.ts`（PushSupervisor）
- tmux 连接共享：`tmux-client/runtime-registry.ts` 按 deviceId 引用计数 acquire/release
- **capture-pane 目前只在私有方法里用**（`local-external-connection.ts:740` / `ssh-external-connection.ts:779`），需新增公开的 `capturePaneText()`
- 前端左 sidebar 全部模式在 `apps/fe/src/components/ui/sidebar.tsx`（拖宽 :323-368、localStorage 宽度 :82-100、cookie 展开态 :116、移动端 Sheet :236-268、`side="right"` 分支已存在）
- REST 惯例：页面内 `fetch('/api/...')` + react-query；Settings 是 Button 组 tab（`SettingsPage.tsx:83-85, 304-341`）
- i18n：只改 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 源文件后跑 `bun run build:i18n`，**严禁手改/lint 生成的 resources.ts/types.ts**
- **生产红线**：验证一律起临时实例（覆盖 `GATEWAY_PORT`/`DATABASE_URL`/`TMEX_FE_DIST_DIR` 等），严禁触碰 9883 常驻服务与 `~/Library/Application Support/tmex/`

### 接口分歧裁决（前后端设计统一）
- 用户消息 / 停止 / 确认决策 **走 REST**（确认可能来自通知链接、二期 Telegram 按钮，统一路径）；WS 只有 SUBSCRIBE/UNSUBSCRIBE（C2S）和 AGENT_EVENT/WATCH_EVENT（S2C）
- 断线恢复：**REST 拉全量历史 + SUBSCRIBE 时服务端立即回 `sync` 事件**（当前 status + 进行中 assistant 消息已累积文本 + pending confirmations），不做 delta 级 seq 回放（delta 不持久化）
- AGENT_EVENT 用单一 Kind + `eventType: u8` + `payload: bytes(JSON)`（先例：`TmuxEventSchema.eventData`），避免协议频繁 lockstep

---

## 第 0 步：存档（AGENTS.md 要求，先存档再干活）

创建 `prompt-archives/2026061300-terminal-agent-watch/`：
- `plan-prompt.md`：本任务的用户 prompt（含补充的 watch 多样本需求）及后续对话 prompt
- `plan-00.md`：本计划全文
- 实现完成后补 `plan-00-result.md`

---

## 一、数据库（`apps/gateway/src/db/schema.ts` 追加 7 张表）

查询助手按域拆新文件：`src/db/llm.ts`、`src/db/agent.ts`、`src/db/watch.ts`。

1. **`llm_providers`**：id, name, protocol(`'openai-chat'|'openai-responses'` + check), baseUrl, apiKeyEnc(encrypt 产物), enabled, modelsCache(json string[]), modelsFetchedAt, createdAt/updatedAt
2. **`agent_settings`**（单行 id=1，仿 siteSettings）：searchProvider(`'none'|'tavily'|'brave'`), tavilyApiKeyEnc, braveApiKeyEnc, defaultProviderId(FK set null), defaultModelId, updatedAt。启动时仿 `ensureSiteSettingsInitialized()` 插默认行
3. **`agent_sessions`**：id, title, deviceId(FK set null), paneId(可空，pane 消失置 null), providerId(FK set null), modelId, systemPrompt, writeMode(`'confirm'|'auto'` 默认 confirm), useProviderWebSearch, status(`'idle'|'running'|'waiting_confirmation'|'stopped'|'error'`), lastError, maxStepsPerTurn(默认 25), createdAt/updatedAt
4. **`agent_messages`**：id, sessionId(FK cascade), seq(会话内单调递增, unique(sessionId,seq)), role, content(json = AI SDK ModelMessage 原样), createdAt。**只在 step 边界落完整 ModelMessage，不持久化流式 delta**
5. **`agent_confirmations`**：id(=AI SDK approvalId), sessionId(FK cascade), toolName, toolCallId, inputJson, status(`'pending'|'approved'|'denied'|'cancelled'`), reason, decidedAt, createdAt
6. **`watch_rules`**：id, name, deviceId(FK cascade), paneId, enabled, triggerType(`'match'|'unchanged'|'llm'`), pattern/patternFlags/extractGroup(正则类用；unchanged 取第 N 捕获组), conditionPrompt(llm 型的自然语言条件), **providerId(FK set null) + modelId（per-rule 模型，空则用 agent_settings 全局默认）**, confirmWithLlm(match/unchanged 触发后二次确认开关), summarizeWithLlm(通知摘要开关), intervalSeconds(默认 30、下限 5；llm 型默认 60、下限 30), unchangedMinutes, noMatchBehavior(`'reset'|'ignore'`), fireMode(`'once'|'repeat'`), cooldownSeconds(默认 600), createdAt/updatedAt
7. **`watch_rule_state`**（运行态分离，仿 deviceRuntimeStatus）：ruleId(PK,FK cascade), lastSampledAt, lastValue, lastValueChangedAt, triggeredSinceChange, lastTriggeredAt, consecutiveErrors, lastError, **modelUnavailableNotified(boolean，模型不可用告警"只发一次"标记，模型调用恢复成功后重置)**。近期样本曲线只放内存 ring buffer（~120 条），不进库

Migration：`bun run --filter @tmex/gateway db:generate`，纯新增表无破坏性变更。

## 二、WS 协议扩展（`packages/shared/src/ws-borsh/`）

| kind | 名称 | 方向 | payload |
|---|---|---|---|
| 0x0601 | AGENT_SUBSCRIBE | C2S | `{ sessionId }` |
| 0x0602 | AGENT_UNSUBSCRIBE | C2S | `{ sessionId }` |
| 0x0603 | AGENT_EVENT | S2C | `{ sessionId, seq: u32, eventType: u8, payload: bytes(JSON) }` |
| 0x0701 | WATCH_EVENT | S2C | `{ ruleId, deviceId, paneId, eventType: u8, payload: bytes(JSON) }` |

AGENT_EVENT.eventType：1=sync 2=status 3=text_delta 4=reasoning_delta 5=tool_call 6=tool_result 7=confirmation_request 8=confirmation_resolved 9=message_persisted 10=error 11=turn_finished。

接线：服务端 `apps/gateway/src/ws/index.ts:296` handleBorshMessage 加 case，`handleClose`(:238) 清订阅；HELLO capabilities(:411) 加 `'tmex-agent-v1'`；前端 `apps/fe/src/ws-borsh/message-builder.ts` + store handler。同步更新协议文档 kind 表。

## 三、REST API（新文件 `apps/gateway/src/api/{llm,agent,watch}.ts`，在 `api/index.ts:158` 分发链注册）

```
GET/POST  /api/llm/providers            PATCH/DELETE /api/llm/providers/:id
POST      /api/llm/providers/:id/refresh-models     # GET {baseURL}/models 拉取并缓存
GET/PATCH /api/llm/settings             # search key 只写不回显（同 device 密码先例）

GET/POST  /api/agent/sessions           GET/PATCH/DELETE /api/agent/sessions/:id
GET       /api/agent/sessions/:id/messages?afterSeq=
POST      /api/agent/sessions/:id/messages   # { text } 发用户消息并启动一轮 run（运行中返 409）
POST      /api/agent/sessions/:id/stop
POST      /api/agent/confirmations/:id/decide  # { approved, reason? }

GET/POST  /api/watch/rules              GET/PATCH/DELETE /api/watch/rules/:id
GET       /api/watch/rules/:id/state    # 运行态 + 内存近期样本
POST      /api/watch/assist-regex       # { description, deviceId?, paneId? } → LLM 一次性生成
```

DTO 类型加到 `packages/shared/src/index.ts`。

## 四、Agent Runtime（新目录 `apps/gateway/src/agent/`）

文件：`supervisor.ts`（单例，仿 PushSupervisor）、`run.ts`（单轮 turn 执行器）、`tools/terminal.ts`、`tools/web.ts`、`ws-hub.ts`（订阅管理+广播）、`prompts.ts`。

- **AgentSupervisor**：`runtime.ts` 启动时 `start()`（pushSupervisor 之后）——重启恢复：`status='running'` 的会话从已落库 messages 重新发起一轮；`'waiting_confirmation'` 加载 pending confirmations 入内存（不重复发通知）。`stop()` 时 abort 所有活动 run 并落库已累积文本。内存 `Map<sessionId, ActiveRun>`，单 session 互斥。
- **AgentRun.execute()**：`tmuxRuntimeRegistry.acquire(deviceId)` → 载入 ModelMessages → `streamText({ model, tools, stopWhen: stepCountIs(maxSteps), abortSignal, maxRetries: 3, onStepFinish: 落库+广播 message_persisted })` → 消费 fullStream 广播 delta（只广播不落库）→ 结束分支：
  - 含 tool-approval-request（AI SDK v6 `needsApproval`）：写 confirmations(pending)，status→waiting_confirmation，`eventNotifier.notify('agent_confirmation_pending')`，run 结束 release（挂起零成本，无悬挂请求）
  - 正常结束 status→idle + turn_finished；abort→落库截断文本 status→stopped；异常→指数退避重试整轮（限网络/5xx），仍败 status→error + notify
  - 确认到达（REST decide）：写 approval 决策 → 追加 `tool-approval-response` ModelMessage 落库 → 起新 run 继续
  - **SSH/设备断开语义**：终端工具执行时设备连接不可用 → 工具**立即返回错误**给模型（不等待 runtime registry 的后台重连），模型可向用户汇报；同一 run 内终端工具连续失败（如 2 次）→ 终止 run，status→error + `eventNotifier.notify('agent_error')`。远程机器挂了就应该失败，绝不静默挂起等恢复
- **ws-hub**：`sessionId → Set<ServerWebSocket>`，订阅即回 `sync`（status + 进行中消息累积文本 + pending confirmations），多标签页天然同步
- **工具**（pane 绑定在 session 上，不作为工具参数，防模型越界写别的 pane）：
  - `read_screen({ historyLines })`：调新增的 `capturePaneText`，返回 screen/capturedAt/cols/rows
  - `send_input({ text?, keys? })`：`needsApproval: () => writeMode==='confirm'`；text 走现有 send-keys -H hex 通道，keys 枚举（enter/escape/ctrl_c/方向键等）映射字节序列；执行后 sleep ~300ms 回读屏幕尾部作为 result
  - `web_search`：按 settings 分发 Tavily(`POST api.tavily.com/search`) / Brave(`GET …/res/v1/web/search`)，未配 key 不注册；Responses 协议 + useProviderWebSearch 时改注入 `openai.tools.webSearch()`（与自建互斥，创建 session 时校验）
  - `fetch_url`：fetch + 15s timeout + 2MB 上限，Bun `HTMLRewriter` 抽正文截断 ~16KB；默认拒绝回环/链路本地地址（env 开关放行）
- **前置改造（唯一动现有 tmux 层处）**：`device-session-runtime.ts:9-23` 接口加 `capturePaneText(paneId, { historyLines? })`，`local-external-connection.ts` / `ssh-external-connection.ts` 各实现 `tmux capture-pane -t <pane> -p -J [-S -N]`（**不带 -e**，纯文本）
- **Provider 注册**（新 `apps/gateway/src/llm/provider-registry.ts`）：protocol 分发 `createOpenAI({baseURL,apiKey}).responses(modelId)` vs `createOpenAICompatible(...).chatModel(modelId)`；新依赖（apps/gateway）：`ai`、`@ai-sdk/openai`、`@ai-sdk/openai-compatible`、`zod`
- **通知扩展**：`packages/shared/src/index.ts` EventType 加 `'agent_confirmation_pending'|'agent_turn_finished'|'agent_error'|'watch_triggered'|'watch_model_unavailable'`；`events/index.ts:272` emojiMap 补条目；i18n locale 加 key 后 build:i18n；通知正文带直达链接（仿 buildPaneUrl）

## 五、Watch Service（新目录 `apps/gateway/src/watch/`）

- `evaluator.ts` 纯函数（输入 screen+rule+state → 新 state+是否命中，便于单测；LLM 调用不在 evaluator 内，由 service 编排）：
  - 取屏幕上**最后一个**正则命中（进度行通常在底部）；无命中按 noMatchBehavior reset（进度行消失=任务结束停止计时）或 ignore
  - unchanged：`value = match[extractGroup]`，值变则重置计时；`now - lastValueChangedAt ≥ unchangedMinutes` 触发（once 用 triggeredSinceChange 防重，repeat 受 cooldown）
  - match：命中即触发；once 触发后置 enabled=false（可重新启用）
- **LLM 介入点与降级策略**（`service.ts` 编排，模型经 provider-registry 解析 per-rule providerId/modelId，空则全局默认）：
  - `llm` 型规则：周期采样调模型 `generateObject({ matched: boolean, reason })` 判断 conditionPrompt 是否满足，matched 即触发（同样受 fireMode/cooldown）。**模型是判断主体**：调用失败计入 consecutiveErrors（超阈值暂停采样），并发 `watch_model_unavailable` 告警
  - match/unchanged + `confirmWithLlm`：正则命中后调模型二次确认，确认才通知；**模型不可用 fail-open**——直接发通知并在文案注明"未经 LLM 确认"（宁误报不漏报）
  - `summarizeWithLlm`：通知文案由模型总结屏幕（如"wget 下载在 73% 停滞 32 分钟"）；模型不可用降级为原始匹配文本
  - **模型不可用告警只发一次**：首次失败 notify `watch_model_unavailable` 并置 state.modelUnavailableNotified=true，后续失败不再发；任一次模型调用成功后重置标记
- `service.ts`：启动加载 enabled 规则按 deviceId 分组 acquire 连接；每规则独立 setInterval 调 capturePaneText；每次采样 UPDATE watch_rule_state 一行（重启后计时延续）；CRUD 后 `refreshRule()` 热更新；连续错误超阈值（10 次）暂停并 notify；**规则全禁用时务必 release 设备连接**
- 触发：`eventNotifier.notify('watch_triggered', {...ruleName, value, stuckMinutes, summary?})` + WATCH_EVENT WS 广播
- assist-regex：用规则选定（或全局默认）模型，可带当前屏幕做 few-shot，`generateObject({ schema: {pattern, flags, extractGroup, explanation} })` 一次调用，返回前服务端编译校验 + 在样本屏幕试跑给 preview；规则保存时记录所用 providerId/modelId（即 per-rule 模型字段，后续确认/摘要复用）

## 六、前端 — 右边栏 Agent 面板

- **新建 `apps/fe/src/components/ui/right-panel.tsx`**（约 200 行），复制 sidebar.tsx 模式而非复用 SidebarProvider（cookie/宽度 key 是模块级常量会冲突；SidebarInset 的 peer 选择器会被第二个 peer 干扰）：宽度 localStorage `tmex_agent_panel_width`（默认 360，280–640）、cookie `agent_panel_state`、拖拽柄照 :323-368（side=right 分支已有）、移动端 `Sheet side="right"` 全屏、快捷键 Cmd/Ctrl+J（含 .xterm 焦点豁免，仿 :127-147）
- **接入点 `apps/fe/src/main.tsx:54-75`**：SidebarProvider 内、SidebarInset 同级加 `<RightPanelProvider>` + `<AgentPanel />`（放 RootLayout 跨路由常驻）；`main.tsx:93-110` PageActions 后加 `<AgentPanelTrigger />`；面板整体 `React.lazy` 隔离
- **组件**（`components/agent-panel/`）：agent-panel（Header=SessionSwitcher+绑定 chip / ChatThread / ChatInput）、session-switcher（下拉：切换/新建/重命名/删除，默认过滤当前 pane 的 sessions + "显示全部"）、session-binding-chip（buildTerminalLabel 显示绑定 pane，点击导航；pane 失效置灰）、chat-thread（吸底滚动）、chat-input（textarea+发送/停止+自动执行 Switch）、messages/*（user/assistant 流式 markdown/tool 卡片四种/error-banner/running-indicator）；写终端卡片内嵌 允许/拒绝 按钮
- **路由 pane ≠ 绑定 pane 时**：输入框上方警示条 + 跳转/重绑（PATCH session paneId）两动作；非终端路由只读看历史
- **store `stores/agent.ts`**（仿 stores/tmux.ts：initialized 防重 + client.onMessage 注册）：sessions/messages(内存)/pendingApprovals/activeSessionId(persist)；text_delta 经模块级 buffer ~40ms 节流 flush；`onStateChange(READY)` 时 loadHistory(REST) → SUBSCRIBE（恢复靠 sync 事件）；approval 被其它标签页处理靠 confirmation_resolved 清卡片
- **markdown**：新依赖 `react-markdown` + `remark-gfm`（纯 React 输出无 XSS 负担）；按空行分块 memo，只重 parse 最后未闭合块
- **Settings**（`SettingsPage.tsx:83-85, 304-341` 加 tab；新组件 `components/settings/llm-providers-tab.tsx`、`search-tab.tsx`，不再内联）：Provider 卡片照 BotCard 模式（key 只回显掩码、留空不改）；保存成功链式 refresh-models → 模型 Select；全局默认 provider/model Select；Search tab 两个 key 输入

## 七、前端 — Watch UI

- 入口①：DevicePage PageActions（`DevicePage.tsx:1132-1218`）加 Radar 图标按钮 → WatchDialog（上下文取 useParams；有启用规则时角标）；入口②：sidebar pane 行 DropdownMenu（`sidebar-device-list.tsx`）加"监控此终端"
- WatchDialog：规则列表（名称/类型 Badge/启停 Switch/删除/最近触发）+ 新建表单 + 触发历史。表单：类型三选一（match | unchanged | llm 自然语言条件）；**模型 Select（per-rule provider+model，默认跟随全局默认）**；match/unchanged 附 confirmWithLlm、summarizeWithLlm 两个开关（开启任一或选 llm 型时模型选择必填/高亮）；NL 描述 + Sparkles 按钮调 assist-regex 回填 pattern 并显示解释和试跑 preview
- `watch-events-init.tsx` 挂 RootLayout：收 WATCH_EVENT → sonner toast（带跳 pane action，照 tmux.ts:358-368 bell 模式）+ Notification API（权限在首次创建规则的用户手势内申请；iOS 需 16.4+ PWA，降级 toast + 服务端 Telegram/Webhook）

## 八、i18n 与文档

- 三个 locale 源 json 加 `agent.*`、`watch.*`、`llm.*`、`search.*`、`notification.eventType.*` → `bun run build:i18n`（禁手改生成物）
- 更新 `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` kind 表；按 AGENTS.md 规范在 `docs/` 新增本功能设计文档

## 用户未提到但已纳入设计的考虑点

1. **隐私**：read_screen 会把终端可见内容（可能含密钥回显）发给第三方 LLM——session 创建 UI 明示提醒
2. **AI SDK v6 版本闸门（最大不确定项）**：`needsApproval`/approval 流是 v6 能力。实施第一步先跑 spike（bun test 验证 streamText/approval/`stepCountIs` 实际导出）；若只有 v5：降级为 tool execute 内 await 自建确认 Promise + 重启按 confirmations 表恢复，外部接口不变
3. **auto 模式中断重放风险**：进程死在"终端已写入但 step 未落库"时重启会重写一遍——confirm 模式有确认兜底；auto 模式风险写入文档（可选优化：send_input 前写 journal）
4. **多客户端/多标签页**：同一 session 事件经 ws-hub 广播给所有订阅者，天然同步
5. **会话标题**：后端在首条用户消息后用 LLM 自动生成 title（一次性），前端只展示/重命名
6. **桌面端右栏挤压终端**：拖拽中已有 isResizing 关 transition 模式；验证现有 ResizeObserver/resize 去抖足够，必要时 pointerup 才落最终宽度
7. **iOS/移动端是一等公民**：Sheet 内 ChatInput 需虚拟键盘避让（main.tsx:48-67 有 transform/fixed 包含块的踩坑注释，Sheet portal 到 body 不受 SidebarInset transform 影响、要单独处理）
8. **SQLite 写放大**：消息 step 粒度落库、watch 状态单行 UPDATE、绝不持久化 delta
9. **长寿命 SSH 连接成本**：WatchService 对有规则设备持有连接（refcount），SSH 设备默认采样 30s、下限 5s
10. **SSRF**：fetch_url 默认拒回环/内网地址（本项目内网无鉴权，更要防 agent 被诱导打内网）
11. 暂不做（记入文档备将来）：token 用量统计、Telegram inline 按钮直接确认、agent 跨多 pane 操作

## 实施顺序

1. 存档（prompt-archives/2026061300-terminal-agent-watch/）
2. DB schema + db/{llm,agent,watch}.ts + migration + agent_settings 初始化
3. `capturePaneText` 三处（接口 + local + ssh）+ 单测
4. AI SDK spike（版本闸门）→ `llm/provider-registry.ts` + Provider/Settings REST
5. shared 协议扩展（kind/schema/EventType/DTO/i18n）+ ws-hub + 服务端 WS 接线
6. Agent supervisor/run/tools + Agent REST + 通知接入
7. Watch evaluator（先单测）+ service + REST + assist-regex
8. 前端 right-panel + AgentPanel 骨架 + main.tsx 接入
9. agent store + WS handler + 流式 markdown + 确认流 + 断线恢复
10. Settings 两个 tab
11. Watch UI（dialog + events-init + 通知）
12. 移动端适配 + e2e + 文档 + 结果存档（plan-00-result.md）

## 验证

- 单测（bun test）：watch evaluator 纯函数（match/unchanged/reset/cooldown 各分支）、watch LLM 编排降级逻辑（fail-open/摘要降级/告警只发一次，mock 模型调用）、capturePaneText、provider-registry 协议分发、AI SDK spike
- 本地起临时实例（显式覆盖 GATEWAY_PORT=9885、临时 DATABASE_URL、TMEX_FE_DIST_DIR；**严禁碰 9883 生产**）：
  - 配一个真实 OpenAI 兼容 provider → 建 session 绑定本地 pane → 让 agent 跑 `ls` 验证 confirm 流（允许/拒绝）、auto 模式、停止按钮
  - 关页面让 agent 继续跑 → 重开页面验证历史恢复 + sync；开两个标签页验证同步；重启 gateway 验证 running/waiting_confirmation 恢复
  - SSH 设备故障：agent 运行中切断 SSH 设备连接 → 验证终端工具立即报错、run 以 error 结束并发出通知（不挂起等待）
  - watch：起一个假下载脚本（循环打印进度后停住），建 unchanged 规则验证 N 分钟卡住触发 + Telegram/浏览器通知；match 规则 once/repeat/cooldown；llm 型规则的周期判断；confirmWithLlm/summarizeWithLlm 链路
  - watch 模型不可用降级：把规则绑定的 provider 改成无效 key → 验证 confirmWithLlm 规则 fail-open 直接通知并注明、`watch_model_unavailable` 告警只发一次、模型恢复后标记重置
  - 移动端视口（Playwright webkit）验证 Sheet 面板与键盘避让
- e2e（`apps/fe/scripts/run-e2e.ts`，9885/9665 端口，沿用 data-testid 约定）：面板开关/拖宽、session CRUD、settings provider CRUD、watch 规则 CRUD
