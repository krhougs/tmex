# Task 5 执行结果：服务端 Agent runtime

完成于 2026-06-13，5 个 commit（a598175 / e9d1998 / 0d63681 / 61adc83 / fac4efc）。

## 交付内容

- `apps/gateway/src/agent/`：run.ts（单轮 turn 执行器）、supervisor.ts（单例调度）、prompts.ts、tools/terminal.ts、tools/web.ts
- `apps/gateway/src/api/agent.ts` + index.ts 分发接线；runtime.ts 启停接线
- `packages/shared`：Agent DTO/请求类型、DEFAULT_AGENT_SESSION_TITLE、三语 i18n（apiError.agent*、notification.agent.*）
- `db/agent.ts`：createAgentConfirmation 支持指定 id（= AI SDK approvalId）
- `llm/provider-registry.ts`：resolveProviderWebSearchTool（openai-responses 透传内置搜索）
- 测试 98 个（terminal 9 / web 37 / run 11 / supervisor 13 / REST 28），gateway 全量 338 过，tsc 三包无新增错误

## 与任务描述不符 / 实现决策（重要）

1. **AI SDK 续跑约束**：`collectToolApprovals` 只消费**最后一条 role=tool 消息**中的 approval responses → 同回合多个确认必须等全部决定后**合并一条 tool 消息**落库再续跑（supervisor.appendApprovalResponsesIfReady）。
2. **cancelled 走合成 tool-result**：stopSession 取消 pending 时若落 approval-response 而不续跑，该 response 一旦不在最后一条消息将永不被消费，悬空 tool call 会被真实 provider 拒绝。改落合成 `execution-denied` tool-result，消息流自洽。
3. **waiting_confirmation 时投递消息返回 409**（AgentAwaitingConfirmationError），要求先 decide——避免悬空 approval-request 炸掉下一轮请求。
4. **恢复 waiting_confirmation 但 pending 丢失**（crash 中间态）：先尝试按已决议 confirmations 补 responses 续跑，否则自愈置 idle。
5. turn_finished 通知开关：做成 AgentRunDeps.notifyTurnFinished（默认 true），未做持久化配置项。
6. deps 注入 llmMaxRetries（默认 3），测试设 0 避免 SDK 内部真实退避拖慢测试。

## 环境坑（已修复）

shell 继承安装版 app.env 的 `TMEX_MIGRATIONS_DIR` 导致 e2e gateway 用旧 migrations 建库缺 agent 表——playwright gateway webServer env 已钉死仓库内 `apps/gateway/drizzle`（fac4efc）。e2e 需用 9885/9665 端口（9883 被生产常驻占用）。e2e 50 过 1 挂（sidebar-delete，MEMORY 记录的既有 flaky）。

## 遗留

- agent_turn_finished 通知未提供用户级开关（设置项留给后续任务）
- fetch_url SSRF 仅 hostname 字面判断，未做 DNS 解析级防护（任务范围如此）
- web_search 自建与 provider 内置互斥仅在 REST 校验，run 内兜底降级为不注册
