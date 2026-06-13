# 终端 AI Agent 总览

## 背景与目标

tmex 在页面右边栏提供一个 AI Agent 对话面板。Agent 运行在 gateway 服务端，绑定到某个 tmux pane，可以读屏、写终端（受确认机制约束）、做 web 搜索、抓取网页。设计目标：

- **服务端运行**：浏览器页面关闭不影响 agent 继续跑，多客户端通过 WS 订阅天然同步。
- **设备故障 fail-fast**：SSH 设备断开属于故障场景，终端工具调用立即失败反馈给模型/用户，不挂起硬等重连。
- **多 Provider**：支持任意 OpenAI 兼容 LLM（Chat Completions / Responses 两种协议），自动拉取模型列表，API key 加密落库（AES-256-GCM，复用 `apps/gateway/src/crypto/`）。
- **对话历史持久化**：消息按 step 边界落库（AI SDK ModelMessage 原样），流式 delta 只广播不落库。

实现计划与执行记录见 `prompt-archives/2026061300-terminal-agent-watch/`。

## 架构

代码位于 `apps/gateway/src/agent/`（服务端）与 `apps/fe/src/components/agent-panel/` + `apps/fe/src/stores/agent.ts`（前端）。

### 服务端组件

| 组件 | 文件 | 职责 |
|---|---|---|
| AgentSupervisor | `agent/supervisor.ts` | 单例调度：单 session 互斥（`Map<sessionId, ActiveRun>`）、用户消息入队启动 run、确认决策续跑、stop、重启恢复 |
| AgentRun | `agent/run.ts` | 单轮 turn 执行器：`streamText` + `stopWhen: stepCountIs(maxStepsPerTurn)`，消费 fullStream 广播 delta，`onStepFinish` 落库完整消息 |
| 终端工具 | `agent/tools/terminal.ts` | `read_screen`（capturePaneText 纯文本取屏）、`send_input`（hex send-keys + keys 枚举，写后回读屏幕尾部） |
| Web 工具 | `agent/tools/web.ts` | `web_search`（Tavily/Brave，未配 key 不注册）、`fetch_url`（15s 超时 / 2MB 体积上限 / 正文截 16KB / 最多 3 跳重定向） |
| AgentWsHub | `agent/ws-hub.ts` | `sessionId → Set<ServerWebSocket>` 订阅管理；SUBSCRIBE 即回 `sync` 事件（由 supervisor 提供 syncProvider） |
| Provider 注册 | `llm/provider-registry.ts` | 按 protocol 分发：`openai-responses` → `createOpenAI().responses()`；`openai-chat` → `createOpenAICompatible().chatModel()` |
| REST | `api/agent.ts`、`api/llm.ts` | session CRUD、消息投递、stop、确认决策、provider/settings 管理 |

依赖：Vercel AI SDK（`ai` + `@ai-sdk/openai` + `@ai-sdk/openai-compatible`），确认流使用 AI SDK 的 tool approval 机制（`needsApproval`）。

### 数据表（`apps/gateway/src/db/schema.ts`）

- `llm_providers`：协议、baseUrl、apiKeyEnc（加密）、模型列表缓存。
- `agent_settings`（单行）：搜索 provider 及 key、全局默认 provider/model。
- `agent_sessions`：绑定 deviceId/paneId、provider/model、writeMode（`confirm`/`auto`，默认 confirm）、status（`idle`/`running`/`waiting_confirmation`/`stopped`/`error`）、maxStepsPerTurn（默认 25）。
- `agent_messages`：会话内 seq 单调递增，content 为 AI SDK ModelMessage 原样 JSON。
- `agent_confirmations`：id 即 AI SDK approvalId，status `pending`/`approved`/`denied`/`cancelled`，决策走 CAS 防并发重复决定。

### 接口分工

- **REST**：用户消息（`POST /api/agent/sessions/:id/messages`，运行中 409）、停止、确认决策（`POST /api/agent/confirmations/:id/decide`）。确认走 REST 是为了统一路径（通知链接、未来 Telegram 按钮）。
- **WS（Borsh）**：客户端只有 `AGENT_SUBSCRIBE`(0x0601)/`AGENT_UNSUBSCRIBE`(0x0602)；服务端单一 `AGENT_EVENT`(0x0603)，`eventType: u8` + JSON payload，避免协议 lockstep。eventType 见 `packages/shared/src/ws-borsh/agent.ts`：1=sync 2=status 3=text_delta 4=reasoning_delta 5=tool_call 6=tool_result 7=confirmation_request 8=confirmation_resolved 9=message_persisted 10=error 11=turn_finished。

### 事件流（一轮带确认的 turn）

```
用户发消息 (REST POST messages)
  → supervisor.submitUserMessage：落库 user 消息，startRun
  → AgentRun：acquire 设备连接 → streamText
      ├─ fullStream: text/reasoning delta → hub 广播（不落库）
      ├─ tool_call / tool_result → 广播
      └─ onStepFinish → 落库完整 ModelMessage → 广播 message_persisted
  → 模型请求 send_input 且 writeMode=confirm：
      写 agent_confirmations(pending) → status=waiting_confirmation
      → 广播 confirmation_request + eventNotifier('agent_confirmation_pending')
      → run 结束、release 连接（确认挂起零成本，无悬挂请求/连接）
用户点允许/拒绝 (REST decide)
  → CAS 写决策 → 同回合全部确认就绪后合并一条 tool 消息落库 → 起新 run 续跑
      （approve：续跑 initial 阶段真实执行工具；deny：模型收到拒绝结果后继续）
  → 正常结束 status=idle + turn_finished（可选通知）
```

断线恢复不做 delta 级回放：前端重连后 REST 按 `afterSeq` 增量拉历史，SUBSCRIBE 时服务端立即回 `sync`（当前 status + 进行中文本 + pending confirmations + lastMessageSeq）。

## 生命周期语义

- **页面关闭**：run 在服务端继续；重开页面靠历史 + sync 恢复，进行中的流式文本无缝接上。
- **SSH/设备断开（fail-fast）**：终端工具执行时设备不可用立即向模型返回错误（`runTmux` 的 `'silent'` 形态抛 `TmuxTargetMissingError`，不触发连接告警）；同一 run 内终端工具连续失败 2 次（`run.ts` `TERMINAL_FAILURE_LIMIT`）终止 run，status=error + `agent_error` 通知。绝不静默挂起等重连。
- **gateway 重启恢复**（`supervisor.start()`）：
  - `running`：先作废残留 pending 确认（crash 中间态）并补 execution-denied result，再从已落库消息重新发起 run（等价重试最后 step）。
  - `waiting_confirmation`：pending 仍在则保持等待，**不重发通知**；pending 丢失则尝试按已决议确认补 response 续跑，否则自愈置 idle。
- **stop 语义**：`stopSession` abort 活动 run 并落库已累积文本（标记 truncated），status=stopped；waiting_confirmation 时取消 pending 并落**合成 execution-denied tool-result**（而非 approval-response，保证消息流自洽，详见下文已知限制 5）。进程 shutdown（`supervisor.stop()`）只 abort 不改 status，留给下次启动恢复。
- **异常重试**：网络/5xx 整轮指数退避重试（默认 3 次，`AgentRunDeps.llmMaxRetries`），仍失败 status=error + 通知。

## 安全与隐私

- **写终端确认**：`send_input` 的 `needsApproval` 按 session writeMode 判定，默认 confirm；pane 绑定在 session 上而非工具参数，模型无法越界写其它 pane。
- **SSRF 防护**：`fetch_url` 默认拒绝回环/链路本地/私有网段地址，重定向逐跳重新校验（最多 3 跳）；env `TMEX_AGENT_ALLOW_PRIVATE_FETCH=1` 放行。本项目内网部署无鉴权，此防护是防 agent 被诱导打内网的关键。
- **隐私提示**：`read_screen` 会把终端可见内容（可能含密钥回显）发给第三方 LLM，session 切换菜单底部常驻提示文案。
- **auto 模式中断重放风险**：进程死在"终端已写入但 step 未落库"窗口时，重启恢复会重写一遍输入。confirm 模式有确认兜底；auto 模式接受此风险（可选优化：send_input 前写 journal，未实现）。
- **API key**：providers / 搜索 key 均加密落库，REST 只写不回显（掩码展示）。

## 已知限制与记债

1. **DNS rebinding**：fetch_url 的私网判断基于 hostname 字面/解析一次，未做连接时二次校验，恶意 DNS 可绕过（与 SSRF env 开关同属 `tools/web.ts`）。
2. **token 用量统计**：未实现（usage 数据 AI SDK 有暴露，表结构未留字段）。
3. **Telegram inline 按钮直接确认**：当前通知只带跳转链接，确认须回到页面操作。
4. **agent 跨多 pane 操作**：单 session 单 pane 绑定，跨 pane 需多 session。
5. **同回合多确认须全部决定后才续跑**：AI SDK 的 `collectToolApprovals` 只消费最后一条 tool 消息的 approval responses，supervisor 按"全部决定后合并一条 tool 消息"处理（`appendApprovalResponsesIfReady`）。
6. **WS 背压**：delta 广播未做按订阅者背压控制，慢消费者可能积压（前端有 40ms 节流缓解）。
7. **waiting_confirmation 时投递新消息返回 409**：要求先决策，避免悬空 approval-request 炸掉下一轮模型请求。
8. **error 重试链路时长**：SDK 内部重试 × run 级重试全程约 60-70s，前端无进度感知，可后续暴露配置。
9. **agent_turn_finished 通知**：仅 deps 级开关（默认开），无用户级持久化设置项。

## 验收标准对照（plan-00.md 验证节）

| 验证项 | 覆盖方式 | 位置 |
|---|---|---|
| capturePaneText | 单测 | `tmux-client/{local,ssh}-external-connection.test.ts`、`device-session-runtime.test.ts` |
| provider-registry 协议分发 | 单测 | `llm/provider-registry.test.ts` |
| AI SDK 能力闸门（streamText/approval/stepCountIs） | 单测（spike） | `llm/ai-sdk.spike.test.ts` |
| confirm 流允许/拒绝 | 单测 + e2e | `agent/supervisor.test.ts`（approve 续跑/deny/CAS 重复决策）；`apps/fe/tests/agent-session.spec.ts` confirm flow 用例（UI 卡片 → 允许 → 工具真实执行上屏；拒绝 → 不执行） |
| auto 模式直接执行 | 单测 | `agent/run.test.ts` |
| 停止按钮 / stop 语义 | 单测 | `agent/supervisor.test.ts`（abort 落库 truncated、waiting_confirmation 取消） |
| 关页面继续跑 + 历史恢复 + sync | e2e | `agent-session.spec.ts`（刷新后历史恢复用例）；sync 单测 `agent/ws-hub.test.ts` + supervisor syncProvider |
| 双标签页同步 | e2e | `agent-session.spec.ts` two tabs 用例（含截图存档） |
| gateway 重启恢复 running/waiting_confirmation | 单测 | `agent/supervisor.test.ts` 重启恢复分支（e2e 重启 gateway 成本高，不重复做） |
| SSH 断开 fail-fast | 单测 | `agent/run.test.ts`（终端工具连续失败 2 次终止 run + error 通知） |
| provider 不可达 error banner | e2e | `agent-session.spec.ts` provider unreachable 用例 |
| 面板开关/拖宽/持久化 | e2e | `agent-panel.spec.ts` |
| session CRUD（建/重命名/删） | e2e | `agent-session.spec.ts` |
| settings provider CRUD + 默认模型 + 搜索 key | e2e | `settings-llm.spec.ts` |
| 移动端视口（Sheet 面板、输入可见） | e2e | `mobile-agent-watch.spec.ts`（375x812） |
| 移动端虚拟键盘避让 | e2e（既有） | `mobile-keyboard-avoidance.spec.ts`（机制级，Sheet portal 到 body 不受 SidebarInset transform 影响） |
