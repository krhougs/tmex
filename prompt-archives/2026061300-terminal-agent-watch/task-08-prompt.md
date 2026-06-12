# Task 8 Prompt：前端 agent store + WS 接入 + 流式对话 UI + 确认流

你在 /Users/krhougs/LocalCodes/tmex 仓库的 feature/terminal-agent-watch 分支上实现 Task 8（共 11 个任务的第 8 个，前端核心）：agent store + WS 接入 + 流式对话 UI + 确认流。用简体中文沟通。一次性完成，禁止留 TODO。

## 项目背景与已就绪设施（先读）

- **后端 REST**（apps/gateway/src/api/agent.ts，已就绪）：GET/POST /api/agent/sessions（POST body {deviceId,paneId,providerId?,modelId?,writeMode?,...}）、GET/PATCH/DELETE /api/agent/sessions/:id、GET :id/messages?afterSeq=、POST :id/messages {text}（运行中 409）、POST :id/stop、GET :id/confirmations、POST /api/agent/confirmations/:id/decide {approved,reason?}（已决定 409）。DTO 类型在 @tmex/shared（AgentSessionDto 等，读 packages/shared/src/index.ts 确认实际名字/形状）
- **WS 协议**（已就绪）：C2S KIND_AGENT_SUBSCRIBE/KIND_AGENT_UNSUBSCRIBE {sessionId}；S2C KIND_AGENT_EVENT {sessionId,seq,eventType,payload(JSON bytes)}。eventType 常量与 payload 类型在 @tmex/shared（packages/shared/src/ws-borsh/agent.ts：AGENT_EVENT_SYNC=1/STATUS/TEXT_DELTA/REASONING_DELTA/TOOL_CALL/TOOL_RESULT/CONFIRMATION_REQUEST/CONFIRMATION_RESOLVED/MESSAGE_PERSISTED/ERROR/TURN_FINISHED=11 + AgentSyncEventPayload 等 interface——逐个读）。**订阅即回 sync**（status+进行中文本 inProgressText/inProgressReasoning+pending confirmations+lastMessageSeq）。**seq 语义注意**：run 内事件 seq 单调递增（每 run 从 0），supervisor 侧广播 seq 恒 0——不要用 seq 做跨事件全序；消息持久化序以 MESSAGE_PERSISTED 的 DB seq（payload 里）为准，瞬时事件按到达序
- **前端 WS 客户端**：apps/fe/src/ws-borsh/client.ts（getBorshClient 单例、onMessage 是 Set 多 store 共存、onStateChange、send 在非 READY 时入 pending 队列上限 100——**重连后必须挂 onStateChange(READY) 重新 SUBSCRIBE 而不能依赖队列**）、message-builder.ts（buildXxx 模式）
- **store 模板**：apps/fe/src/stores/tmux.ts（模块级 initialized 防重入约 :97/:124、client.onMessage 注册独立 handler 约 :145-243、READY 重连补发模式约 :254-262）
- **面板骨架**（Task 7 完成）：components/agent-panel/（agent-panel.tsx 的 ChatThread 接 messages prop、ChatInput 接 onSend/disabled、session-switcher props 接口）、components/ui/right-panel.tsx
- **REST 惯例**：fetch('/api/...') + @tanstack/react-query + parseApiError（看 SettingsPage.tsx 约 :69-76）
- **消息持久化格式**：agent_messages.content 是 AI SDK ModelMessage 原样 JSON（role user/assistant/tool；assistant content 是 string 或 parts 数组 text/tool-call/reasoning；tool content 是 tool-result/tool-approval-response parts）。前端要把 ModelMessage 序列渲染成对话流——写一个 parser 把 messages 数组转 UI 块（user 文本/assistant 文本+工具卡片序列），tool-call 与对应 tool 消息里的 result 按 toolCallId 配对
- **路由**：devices/:deviceId/windows/:windowId/panes/:paneId（main.tsx 路由表确认）；终端 label 工具 buildTerminalLabel（apps/fe/src/utils/terminalMeta.ts，确认实际导出）；pane 存活可查 useTmuxStore 的 snapshots

**红线**：严禁触碰生产 tmex；dev server 注意 NODE_ENV 毒化（env -u NODE_ENV）；e2e 用 9885/9665。

## 任务内容

### 1. `apps/fe/src/stores/agent.ts`（Zustand，仿 tmux.ts 模式）

State：sessions（Record<id, AgentSessionDto>）、sessionOrder、activeSessionId（persist localStorage 仅此字段+面板偏好）、messages（Record<sessionId, UiMessage[]> 内存）、inProgress（Record<sessionId, {text,reasoning,toolCalls…}> 流式中暂存）、pendingConfirmations（Record<sessionId, ConfirmationDto[]>）、sessionStatus、historyLoaded/loading
Actions（REST）：loadSessions、createSession（绑定当前路由 pane）、renameSession、deleteSession、setWriteMode、loadHistory(id)（GET messages → parser → UiMessage[]）、sendMessage（POST，409 时 toast 提示运行中）、stopSession、decideConfirmation（POST decide，409 静默刷新——已被别端处理）
Actions（WS）：subscribe(id)/unsubscribe(id)（发 KIND_AGENT_SUBSCRIBE/UNSUBSCRIBE）
WS handler（initialized 防重）：
- SYNC：覆盖 status/进行中文本/pending confirmations；若 lastMessageSeq > 本地最大 seq → loadHistory 增量（afterSeq）
- TEXT_DELTA/REASONING_DELTA：append 到 inProgress（**模块级 buffer + ~40ms 节流 flush 进 store**，每帧 set 会卡渲染）
- TOOL_CALL/TOOL_RESULT：inProgress 工具卡片即时更新
- MESSAGE_PERSISTED：按 payload 的 DB seq afterSeq 增量拉取或用事件携带内容就地落地（看 payload 实际形状）；落地后清对应 inProgress 部分
- CONFIRMATION_REQUEST/RESOLVED：pending 列表增删（RESOLVED 多标签同步靠它）
- STATUS/TURN_FINISHED/ERROR：sessionStatus 更新、error toast（sonner）
重连：onStateChange(READY) → 对 activeSession loadHistory(afterSeq=本地最大) + 重新 subscribe
订阅生命周期：activeSessionId 变化时 unsubscribe 旧 + subscribe 新；面板关闭不退订（后台仍可收通知性事件——简单起见保持订阅，说明权衡即可）

### 2. message-builder.ts 增 buildAgentSubscribe/buildAgentUnsubscribe

### 3. markdown 流式渲染

- `bun add react-markdown remark-gfm`（apps/fe）
- `components/markdown/streaming-markdown.tsx`：按双换行分块、每块 memo(MarkdownBlock)，流式时只最后一块重 parse；代码块用等宽+现有终端风格、链接 target=_blank rel=noopener
- agent 面板整体已 lazy（Task 7），react-markdown 进同一 chunk 即可

### 4. 对话流 UI（components/agent-panel/messages/ + 接线 agent-panel.tsx）

- user-message（右对齐气泡）/ assistant-message（StreamingMarkdown，流式中尾部光标闪烁）/ reasoning 折叠块（默认收起）
- tool-call-card：按 toolName 分发——send_input（等宽显示将发送的 text/keys；**pending approval 时内嵌 允许/拒绝 按钮**→decideConfirmation；resolved 显示结果）、read_screen（折叠的屏幕快照，Collapsible 展开）、web_search（查询+结果条目链接）、fetch_url（url+截断正文折叠）；运行中 spinner、error 红色态
- running-indicator（脉冲点）+ 停止按钮（status running 时输入框变停止）
- error-banner（lastError + 重试按钮=重发上一条 user 消息）
- ChatThread：吸底滚动（用户上滚则停止吸底，新消息时出"回到底部"按钮）
- SessionSwitcher 接真数据：列表（默认过滤当前 pane，提供"显示全部"切换）、新建（绑定当前路由 pane；非终端路由时禁用并提示）、重命名（inline 或 dialog）、删除（确认）
- 绑定 chip：session.deviceId/paneId 用 buildTerminalLabel 显示，点击导航到该 pane；**当前路由 pane ≠ session 绑定 pane 时**输入框上方警示条（跳转过去 / 重绑到当前 pane=PATCH paneId）；pane 不在 snapshots 中时 chip 置灰"已失效"
- writeMode 开关（Switch：自动执行/需确认）在 Header 或 session 菜单
- 隐私提示：创建 session 的入口处一次性提示（如新建菜单项 description 或首次创建 dialog）："会话将把终端屏幕内容发送给配置的 LLM 服务"

### 5. i18n（三语 + build:i18n）+ 验证

- tsc 无新增；biome 新文件过检
- e2e（tests/agent-session.spec.ts）：后端真起（e2e 基建会起 gateway——确认 fixture 有没有 LLM mock 的可能：**没有真 provider 时至少覆盖**——创建 session（先在 settings/API 造一个指向 mock 不可达地址的 provider 也行）、session 列表/重命名/删除、发消息后 status 流转到 error（provider 不可达）+ error banner 显示。**用 mock LLM server 的话**：playwright fixture 里起一个本地 mock OpenAI server（参照 gateway 的 ai-sdk.spike.test.ts mock 形状）注册成 provider，验证流式文本上屏全链路。尽力而为，做不到全链路就覆盖 UI 交互层并说明
- 手动 dev 验证（双标签页同步、刷新恢复）也做一轮，截图
- 独立 commit（建议拆：store+WS、UI、e2e）

## 开始前
有疑问先问。shared 类型/payload 实际形状与描述不符以代码为准并汇报。

## 自查后汇报
实现内容、测试结果、变更文件、与描述不符处、遗留问题。
