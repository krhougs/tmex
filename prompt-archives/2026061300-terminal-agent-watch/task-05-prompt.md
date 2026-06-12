# Prompt 存档：Task 5 — 服务端 Agent runtime

## 任务 prompt（2026-06-13）

在 feature/terminal-agent-watch 分支上实现 Task 5（共 11 个任务的第 5 个，核心任务）：服务端 Agent runtime。

### 已就绪设施

- DB：`apps/gateway/src/db/agent.ts`（session CRUD/按状态查、appendAgentMessage 自动 seq、listAgentMessages(afterSeq)、confirmation create/listPending/decideAgentConfirmation——CAS 式）、`db/llm.ts`、schema 类型
- LLM：`resolveLanguageModel(providerId|null, modelId|null)`；AI SDK v6（ai@6.0.203）已 spike 验证（`src/llm/ai-sdk.spike.test.ts`：needsApproval → tool-approval-request part；续跑追加 response messages + tool-approval-response；stepCountIs）
- WS hub：`agentWsHub` 单例（broadcastAgentEvent 泛型签名、setSyncProvider 待注入真实实现）
- shared 事件类型：`packages/shared/src/ws-borsh/agent.ts`（AGENT_EVENT_* 1-11）
- tmux：`DeviceSessionRuntime.capturePaneText` / `sendInput`（hex send-keys）；`tmux-client/registry.ts` acquire/release 引用计数
- 通知：`eventNotifier.notify(eventType, event)`，EventType 已有 agent_confirmation_pending/agent_turn_finished/agent_error
- 后台任务范式：`push/supervisor.ts`；启动序列 `runtime.ts`

### 任务内容

新目录 `apps/gateway/src/agent/`：supervisor.ts、run.ts、tools/terminal.ts、tools/web.ts、prompts.ts。

- AgentSupervisor（单例，仿 pushSupervisor）：start() 重启恢复（running → 重新发起 run；waiting_confirmation → 校验 pending 仍在即保持等待、不重发通知）；stop() abort 所有活动 run（已累积文本落库标记 truncated、status 保持 running）；单 session 互斥（409 语义）；submitUserMessage / stopSession / resolveConfirmation（CAS decide → 落库 tool-approval-response → 续跑）；注入真实 syncProvider
- AgentRun：acquire runtime → 载入 ModelMessages → streamText（system/messages/tools/stopWhen stepCountIs/abortSignal/maxRetries 3/onStepFinish）；fullStream 消费：delta 聚合节流广播（30-50ms 合帧）、tool-call/result 即时广播；onStepFinish 落库 + message_persisted（只在 step 边界落库）；结束分支（approval 挂起 / 正常 idle / abort 落库 truncated / 异常指数退避外层重试 3 次 → error + notify）；SSH fail-fast（终端工具连续 2 次失败终止 run）；标题自动生成（generateText 一次性，失败静默）
- 工具（pane 绑定取自 session）：read_screen（historyLines 0-2000）；send_input（text/keys 枚举映射字节、needsApproval=writeMode==='confirm'、执行后 300ms 回读尾部 15 行）；web_search（tavily/brave 分发、none/无 key 不注册、useProviderWebSearch + openai-responses 时注册 openai.tools.webSearch()）；fetch_url（http/https、15s timeout、2MB 上限、HTMLRewriter 抽正文 16KB、SSRF 防护、TMEX_AGENT_ALLOW_PRIVATE_FETCH=1 放行）
- REST `apps/gateway/src/api/agent.ts`：sessions CRUD、messages、stop、confirmations、decide；DTO 加 packages/shared；错误 i18n key 三语 + build:i18n
- 测试：run 核心循环（mock LLM server + stub tmux）、supervisor 恢复/互斥/stop、tools keys 映射/SSRF/未配置不注册、REST CRUD + 409；全量 bun run test + tsc 无新增；独立 commit 拆 2-3 个

红线：严禁触碰生产 tmex（9883、Application Support）；测试 LLM 一律 mock server、tmux 用注入 stub。
