# Agent / 前端体验优化（worktree）

## Context

针对 tmex 的 Agent 与前端使用体验做一轮集中优化。问题分四块：

1. **Agent hosted tool**：调用中转后的 gpt 模型时 `image_generation` 报错，当前 agent 未注册任何 hosted tool（只有 terminal/run_command/web_search/fetch_url）。
2. **失败卡死**：hosted tool 调用失败后 agent 卡住、前端一直显示"等待模型输出"。预期是失败信息回喂模型，模型据实继续。
3. **布局 / 会话管理**：左右双 Sidebar 混乱；Agent 会话切换零散。
4. **设置页** LLM provider 表单混乱（尤其 Select 与 Input 不对齐）。

### Base 状态（已逐文件重核当前 HEAD）

- 当前 HEAD = **`8a168a7`**（== origin/main，`git fetch` 无更新）。其上叠加的最近两个提交均与本计划代码路径无关：`8a168a7` 是生产打包补拷 `ghostty-vt.wasm`（仅 `packages/app/*` + docs），`af437d7` 是 docs。功能基线仍是 `143891c`（run_command + headless ghostty）。**已 diff 校核 `143891c..8a168a7` 未触及任何 plan-critical 文件（run.ts/supervisor/stores/api/schema/tools/settings/ws-borsh 等）**，故前述逐文件核实仍然有效。worktree 从当前 HEAD 切分支即可。
- **已重读当前 `run.ts`（825 行）核对到行**，与计划一致：
  - `streamText` fullStream 事件循环在 **`run.ts:414-473`**，事件类型（text/reasoning-delta、tool-call/result/error、tool-output-denied、tool-approval-request、error、abort）与旧版一致 → A3 看门狗包裹此循环成立。
  - `buildTools` 在 **`run.ts:493-530`**：terminal 工具经 `createTerminalTools({...getEmulator})` 注入，随后 web_search、`fetch_url`。→ A1 hosted-tool 注入点就在此（terminal 块之后）。
  - per-run emulator 生命周期在 **`run.ts:288-335`**（`asEmulatorSource(runtime)` + `paneEmulatorRegistry.acquire/release`，失败退回 capture）。`onStepFinish` 增量落库在 `run.ts:391-411`（C4 队列 drain 接入点）。
  - 终端工具 = read_screen / send_input / get_pane_info / run_command（`tools/terminal.ts`、`tools/run-command.ts`）。
- **起源元数据源已核实**：`TerminalRuntimeLike.getPaneInfo(paneId): Promise<PaneInfo>`（`tools/terminal.ts:21`），`PaneInfo`（`tmux-client/capture-history.ts:36-43`）含 `currentCommand`（进程名）**但不含 title**（`PANE_META_FORMAT`@capture-history.ts:45 未取 `pane_title`）。runtime 由 `tmuxRuntimeRegistry.acquire(deviceId)` 获得（run.ts:281 同源）。→ D1 据此落地（见下）。

### 关键现状（已读代码确认）

- 后端 Agent 基于 Vercel AI SDK `streamText`，核心 `apps/gateway/src/agent/run.ts`（`AgentRun.runOnce`）；单 session 互斥调度 `apps/gateway/src/agent/supervisor.ts`，运行中再发消息抛 `AgentSessionBusyError`。
- `tool-error` part **不中断**流、会回喂模型——"卡死"应是 **流 stall（SSE 不终止）**：`for await (result.fullStream)` 永不结束 → run 不收尾 → status 停 `running`；run.ts 对流**无空闲超时保护**。
- hosted tool 未注册；`@ai-sdk/openai@3.0.71` 已暴露 `createOpenAI(...).tools.{imageGeneration,codeInterpreter,webSearch,fileSearch,localShell,...}`（已验证 d.ts）。
- session 已支持 per-session `providerId`/`modelId`（schema + REST PATCH 全在）；`useProviderWebSearch` boolean → hosted web_search（`provider-registry.ts:78 resolveProviderWebSearchTool`）。
- **pane 元数据**：`TmuxPane`（`packages/shared/src/index.ts`）有 `title`，**无进程名**；但后端 `apps/gateway/src/tmux-client/capture-history.ts` 已采集 `pane_current_command → currentCommand`（snapshot wire 不带，但一次性 pane-info 查询可得）。→ session 起源元数据（标题/进程名/时间）可在创建时由后端采集。
- 前端 React19 + RR7 + Zustand(persist) + TanStack Query + Tailwind4 + Base UI(shadcn)。布局 `apps/fe/src/main.tsx`：`AppSidebar`(左) + `RightPanel`(右,含 `AgentPanel`)。
- 左 `Sidebar`（`ui/sidebar.tsx`）**已支持拖拽调宽**（`tmex_sidebar_width`）——直接复用。
- 设备/pane 树 `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`：设备→window→pane，pane 节点 `onPaneClick → /devices/:deviceId/windows/:windowId/panes/:paneId`，数据来自 `useTmuxStore().snapshots`。
- Agent store `apps/fe/src/stores/agent.ts`：仅持久化 `activeSessionId`/`showAllSessions`；`createSession` 现在立刻 POST 落库。`resolveBinding`（agent-panel.tsx）判 valid/invalid/unknown；**无 orphan 概念**，`submitUserMessage` 对失效绑定**不拦截**。
- 设置 `apps/fe/src/components/settings/llm-providers-tab.tsx` 网格表单；`ui/select.tsx` 的 `SelectTrigger` 默认 `w-fit`+`h-8` 而 `ui/input.tsx` `h-8 w-full` → Select/Input 不对齐根因。
- DB：drizzle，schema `apps/gateway/src/db/schema.ts`，生成 `cd apps/gateway && bun run db:generate`，启动自动 migrate。

### 已确认决策（用户）

1. hosted tool：**当前要 image_generation + 内联渲染**，架构要**无缝兼容任意模型 hosted tools**（可扩展注册表）。
2. steer/队列：**默认 step 边界注入** + **手动 steer 立即注入**；队列项**可编辑/撤回**。
3. 会话**仍必须绑定 pane**。
4. 左 Sidebar 已支持拖拽调宽——复用。
5. **会话选择器并入 Panes 树**：session 作为其绑定 pane 的子分支列在 pane 下；选 session 自动切到对应 tmux pane；在 Agent 界面"切换 session"则切回 Panes tab。
6. **Orphan 会话历史**：需有地方展示孤立 agent 会话；history 记录"启动 session 时的终端标题 + 进程名 + 时间"（旧记录无则前端不显示）；前后端都要**屏蔽 orphan 会话继续输入**。

> 工作量大，按 work-stream 拆分。**先在 prompt-archives 存档再动手**；全程在新建 worktree 内。

---

## Work-stream 0：准备

- `git worktree` 从当前 HEAD（143891c）新建分支（如 `feat/agent-ux-overhaul`）。
- AGENTS.md：`prompt-archives/2026061300-agent-ux-overhaul/` 存 `plan-prompt.md` + `plan-00.md`，完成后 `plan-00-result.md`。
- 验证用仓库内临时实例，显式覆盖 `TMEX_FE_DIST_DIR`/`GATEWAY_PORT`/`TMEX_BIND_HOST`；**严禁触碰生产常驻 tmex（9883）**；实测用 `test.env.local`。
- 后端结构已按当前 HEAD（`8a168a7`）逐文件核实（见 Base 状态），计划行号即当前行号；`supervisor.ts` 自上次阅读未被 143891c 触及（该提交 diff 不含 supervisor.ts），沿用即可。

---

## Work-stream A：Agent hosted tools + 失败恢复（后端）

### A1. 可扩展 hosted tool 注册表
- 新增 `apps/gateway/src/agent/tools/hosted.ts`：`HOSTED_TOOL_FACTORIES` key → `(client)=>Tool` 工厂表，初始 `image_generation`、`code_interpreter`。"加一行即新增一个 hosted tool"。
- **API 已核实（@ai-sdk/openai@3.0.71 d.ts）**：provider 暴露 `.tools`（index.d.ts:1147）；`client.tools.imageGeneration(args?: { size?, quality?, outputFormat?: 'png'|'jpeg'|'webp', background?, partialImages?, model?, ... }) => Tool<{}, { result: string }>`——**input schema `{}`（hosted/provider-executed，模型无入参）、output `{ result: string }`（base64 图，默认 png）**。hosted 工具仅 Responses API 可用，与 `openai-responses` 协议 gating 一致。注册形如 `tools.image_generation = client.tools.imageGeneration()`。
- session 增列 `providerHostedTools`（`text json $type<string[]>`，default `[]`）承载通用 hosted tool 启用项（保留 `useProviderWebSearch` 不动避免回归）。schema.ts + `db/agent.ts` create/update/DTO 透传；`api/agent.ts` 校验（仅 `openai-responses` 允许，抽 `validateProviderHostedTools`，复用协议校验思路）。
- `provider-registry.ts` 抽 `resolveOpenAIProviderClient(providerId)`（返回 `createOpenAI({baseURL,apiKey})` 实例），hosted/web_search 共用（避免重复 decrypt/baseURL）。`run.ts buildTools`（**run.ts:493**，terminal 块之后、web_search 之前）：openai-responses provider 时遍历 `session.providerHostedTools` 用注册表注入 tools。

### A2. hosted tool 结果内联渲染（前端）
- image_generation tool-result `output = { result: "<base64>" }`（默认 png，`outputFormat` 可配），链路 `tool-result → AGENT_EVENT_TOOL_RESULT → handleToolResult → tool-call-card` 已能传输。
- `agent-thread.ts`（或同目录新文件）加**通用媒体提取器**：探测 tool output 里的 base64 image / data-url / image url（含 `output.result` 这类字段），产出结构化 media 块（通用化，便于未来其它 hosted tool 媒体）。partialImages 流式预览本轮不做，只渲染最终 `result`。
- `messages/tool-call-card.tsx`（及必要时 assistant-message）渲染 `<img src="data:image/...">`，带尺寸约束。DB 存大 base64 可接受，本轮不落盘。

### A3. 失败不卡死（#2 核心）
- **先复现**：新增 `agent-hosted-tool.integration.ts`（`*.integration.ts` 默认不发现），用 `test.env.local` 中转 gpt 跑 image_generation，捕获 fullStream part 序列/错误形态（守卫 `requireLiveEnv`）。
- **稳健修复**：`run.ts runOnce` 给 `for await (result.fullStream)`（**run.ts:414**）加**空闲看门狗**——超 `streamIdleTimeoutMs`（new dep，默认约 90s）无 part 到达即 `abortController.abort()` + `finishError`（明确文案"上游无响应/stream stalled"），保证永不无限挂起、status 落 error、前端解除等待。（实现：每收一个 part 重置定时器；循环退出清定时器。）
- 补 `streamText` 的 `onError` 日志；确认失败 hosted tool 走 `tool-error` 回喂；整轮 throw 已有 retry/finishError 链路。用 A3 test 验证失败后模型继续/收尾。

---

## Work-stream B：左 Sidebar Tab 化 + 删除右 Agent Panel

### B1. 左 Sidebar 顶部 Tab（持久化）
- `stores/ui.ts`（zustand persist）加 `sidebarTab: 'panes'|'agent'|'files'` + setter。
- `app-sidebar.tsx`：`SidebarHeader` 下加 Tab 切换条（复用 `ui/tabs.tsx`）。`SidebarContent` 按 tab 渲染：`panes`→改造后的 `SideBarDeviceList`（见 C1）；`agent`→Agent 内容（见 C）；`files`→`Coming Soon` 占位。
- Footer "Manage Devices" 保留。

### B2. 删除右 Agent Panel
- `main.tsx`：移除 `RightPanelProvider/RightPanel/AgentPanel` 挂载与 `PageWrapper` 的 `RightPanelTrigger`。`Cmd/Ctrl+J` 重映射为"展开 sidebar 并切到 agent tab"。
- `ui/right-panel.tsx` 退役（grep 确认无引用后删除）。
- `agent-panel.tsx` 重构为适配 sidebar tab 容器：去掉 standalone 外壳与关闭按钮。
- 移动端：左 sidebar 本是 Sheet，agent chat 随之进 Sheet；移除 topbar 右侧 panel trigger。

---

## Work-stream C：会话选择并入 Panes 树 + Agent Tab 体验

### C1. Session 作为 pane 子分支（核心交互改造）
- `sidebar-device-list.tsx`：每个 pane 节点下嵌套"绑定到该 pane 的 agent sessions"子分支——从 `useAgentStore().sessions` 按 `deviceId+paneId` 过滤渲染为子节点（标题 + 状态点 running/idle/error）。
- 点击 session 子节点：`setActiveSession(id)` + 导航到该 pane 路由（`/devices/:d/windows/:w/panes/:p`，自动切 tmux pane）+ 切 `sidebarTab='agent'` 显示该会话 chat。
- Agent tab 内"切换会话"动作 → 切回 `sidebarTab='panes'`（在树里选）。**移除 Agent tab 内的 SessionSwitcher 下拉与 `showAllSessions`**。

### C2. 快速新建 + 草稿会话（空 session 不落库）
- Agent tab header 放显眼"+ 新会话"按钮；pane 树节点旁也可加"+"快速为该 pane 建会话。
- agent store 引入 **draft session**（不 POST）：`draft:{deviceId,paneId,providerId,modelId}|null`。无 active session 或点新建 → 进 draft：直接显示空 chat（空 thread + 输入框 + 模型选择 + pane 绑定信息），取消独立"选择/创建会话"界面。
- 首次 `sendMessage`：先 `createSession`(draft) 落库再 POST 消息；**空 draft 永不持久化**。
- 仍需绑 pane：draft 默认取当前路由 pane；无 pane 时提示去 Panes tab 选 pane（或内嵌 pane 选择器）。

### C3. per-session 模型选择（完成后可切）
- Agent tab header 加 provider+model 选择器，数据来自 `GET /api/llm/providers`（仅 effective 启用模型，见 D4）。
- draft → 写 draft.providerId/modelId；已存在 session → `store.setSessionModel` → `PATCH /api/agent/sessions/:id`（后端已支持）。运行中禁用切换，idle/stopped/error 允许。

### C4. Steer + 消息队列（可编辑/撤回）
**数据**：新表 `agent_queued_messages`(id, sessionId FK cascade, seq, text, createdAt)——落库保证多端同步 + 重启不丢 + 可编辑/撤回。

**后端**：
- `supervisor.submitUserMessage`：session active 时**不再抛 busy**，改入队 + 广播队列更新；非 active 维持原逻辑。（orphan 拦截见 D-orphan，优先级高于入队。）
- 新增 `steer(sessionId, immediate)`：入队后 `immediate=true` 调 `run.requestSteer()` 立即 abort；`immediate=false`（默认）仅入队等下一自然 step 边界。
- `run.ts` 改为**队列感知连续 run**：注入 `drainQueue`；`onStepFinish` 末尾检测队列非空 → 置 `pendingSteer` + abort（优雅，等当前 step 落库）。`runOnce` 退出后若是 steer 触发（非 stop/error）→ drain 队列成 user 消息落库广播 → 再次 `runOnce`（execute 加 `continue` 分支），status 持续 running 无缝衔接。手动 steer = mid-step abort，post-loop 同样 drain→继续。
- WS：新增 `AGENT_EVENT_QUEUE_UPDATED`（队列项列表）；`SYNC` payload 增 `queuedMessages`。`packages/shared/src/ws-borsh/agent.ts` 加常数 + 类型。
- REST：`POST /api/agent/sessions/:id/queue`({text,steer?})、`PATCH /api/agent/queue/:itemId`(编辑)、`DELETE /api/agent/queue/:itemId`(撤回)。

**前端**：运行中输入框 → 入队（非报错）；队列项 chips 显示于输入框上方，支持内联编辑 + ✕ 撤回 + "立即 steer"按钮。agent store 加 `queued[sessionId]` + handlers（`AGENT_EVENT_QUEUE_UPDATED`/SYNC）+ `enqueue/editQueued/withdrawQueued/steer`。

---

## Work-stream D：Orphan 会话历史 + 屏蔽输入

### D1. 起源元数据采集（创建时，机制已核实）
- agentSessions 加列 `originPaneTitle`(text null)、`originProcessName`(text null)；时间复用 `createdAt`。**nullable，旧记录为 null → 前端不显示该字段**。
- 进程名直接可得：`handleCreateSession` 里 `const rt = await tmuxRuntimeRegistry.acquire(deviceId); const info = await rt.getPaneInfo(paneId)` → `info.currentCommand`，用后 `releaseRuntime`。acquire 失败/device 离线 → 留 null（不阻塞建会话，静默降级）。
- **title 当前不在 `PaneInfo`**：选其一——(优先) 扩展 `PANE_META_FORMAT`(capture-history.ts:45) 增 `#{pane_title}` + `PaneInfo.title` + `parsePaneMeta`（同步更新其单测/调用方），使 `getPaneInfo` 一次返回 title+currentCommand；或前端 create 请求附带 snapshot 的 `pane.title` 作 `originPaneTitle`，进程名仍由后端取。
- 注意：getPaneInfo 不依赖 emulator（emulator 是 run 期产物），可在 create 期独立调用；acquire/release 一次性开销可接受。

### D2. Orphan 判定与历史展示
- **Orphan 定义**：`deviceId==null`（设备被删，FK set null）或 `getDeviceById(deviceId)==null`；或 device 在线但 pane 不在快照（pane 被关）。前端有全量快照可精确判 invalid；后端可靠判 deviceId/device 缺失。
- 这些会话无 live pane，不挂在树上 → Panes tab 底部加可折叠 **"孤立会话 / History"** 区：列出 orphan session，显示 `originPaneTitle`、`originProcessName`、`createdAt`（缺失项隐藏），点击可只读查看历史 chat。

### D3. 屏蔽 orphan 继续输入（前后端）
- 后端：新增 `AgentSessionOrphanedError`（409），`supervisor.submitUserMessage` + 队列 enqueue + steer 入口先判 orphan（deviceId null / device 缺失）即拒绝；`api/agent.ts mapSupervisorError` 映射。
- 前端：session 为 orphan（deviceId null 或 binding invalid）时 ChatInput + 队列**禁用**，chat 显示只读历史 + 一条"会话已孤立"说明 banner。

---

## Work-stream E：设置页 LLM Provider 重构

### E1. 列表化
- `llm-providers-tab.tsx` 重写为 provider **列表**：每行 name、protocol badge、baseUrl(脱敏)、enabled 开关、模型数、操作（刷新模型/编辑/删除）。

### E2. 添加/编辑 Modal + 修复表单样式
- 用 `ui/dialog.tsx` 承载 add/edit 表单。
- **修复 Select/Input 不对齐**（根因 SelectTrigger `w-fit`/`h-8` vs Input `h-8 w-full`）：表单内统一字段尺寸——Input 与 SelectTrigger 都 `w-full` + 同高（如 `h-9`）。优先表单局部传 className，不改 `ui/select.tsx` 默认值以免影响其它用法。统一排查 modal 内全部控件高度/圆角/间距一致。

### E3. 列表内快速开关 / 刷新模型
- enabled → `PATCH /api/llm/providers/:id {enabled}`；刷新 → `POST .../refresh-models`。inline loading + toast。

### E4. 手动加模型 + 禁用读取到的模型
- schema：`llm_providers` 加 `manualModels`(json string[] default [])、`disabledModels`(json string[] default [])；`db/llm.ts` create/update/DTO 透传。
- effective 启用列表 = `(modelsCache ∪ manualModels) − disabledModels`；刷新只覆盖 `modelsCache`，manual/disabled 不被冲掉。
- DTO 暴露结构化模型（id + source `fetched|manual` + enabled）供设置 UI 勾选；Agent/默认模型选择器只用 effective 启用列表。
- UI：编辑 modal 内列出发现模型逐个启停 + 输入框手动添加 model id。`resolveLanguageModel` 不校验模型清单，禁用纯前端过滤。

---

## Work-stream F：迁移 / i18n / 收尾

- **DB 迁移**：schema.ts 改完（agentSessions.`providerHostedTools`/`originPaneTitle`/`originProcessName`；llm_providers.`manualModels`/`disabledModels`；新表 `agent_queued_messages`）后 `cd apps/gateway && bun run db:generate` 生成迁移，启动自动 migrate。**勿手改已有迁移**。
- **i18n**：新文案加到 i18n **源**后 `bun run build:i18n` 重生成；**不要 lint/format 生成的 `resources.ts`/`types.ts`**。
- 共享类型 `packages/shared/src/index.ts`：新增 DTO/Request 字段（hostedTools、origin 元数据、queued message、provider 模型结构）。

---

## 关键文件清单

**后端**：`agent/run.ts`(hosted 注入/看门狗/队列连续 run)、`agent/supervisor.ts`(入队/steer/drain/orphan 拦截)、`agent/tools/hosted.ts`(新)、`llm/provider-registry.ts`(抽 client)、`api/agent.ts`(校验/queue 端点/orphan 错误/起源采集)、`db/{schema,agent,llm}.ts` + `drizzle/*`、`tmux-client/capture-history.ts`(pane-info 查询)、`packages/shared/src/{ws-borsh/agent.ts,index.ts}`。

**前端**：`main.tsx`、`ui/right-panel.tsx`(退役)、`page-layouts/components/app-sidebar.tsx`(Tab)、`page-layouts/components/sidebar-device-list.tsx`(session 子分支 + orphan 区)、`stores/ui.ts`(sidebarTab)、`stores/agent.ts`(draft/模型/队列/orphan)、`components/agent-panel/*`(适配 tab/模型选择/队列 chips/媒体渲染/只读 orphan)、`components/settings/llm-providers-tab.tsx` + provider 子组件、新增 files-tab(Coming Soon)。

---

## 验证

- **A**：`test:live:*` 跑 `agent-hosted-tool.integration.ts`，确认 image_generation 注册可调用、失败回喂、看门狗超时落 error 不卡死。
- **单测**：run.ts 队列连续 run/看门狗、supervisor 入队/steer/drain/orphan 拦截，沿用 `agent*.test` 风格注入 fake deps。
- **手测**（仓库内临时实例，避开 9883）：
  - 三 Tab 切换 + 持久化；右 panel 已移除；Files=Coming Soon。
  - Panes 树下嵌 session 子分支；点 session 切 pane + 切 Agent tab；Agent tab"切换会话"回 Panes tab。
  - 新会话→草稿(不落库)→选模型+绑 pane→首条消息才落库；运行中入队/编辑/撤回/step 边界注入/手动 steer；完成后切模型；image_generation 内联出图。
  - Orphan：删设备/关 pane 后会话进底部历史区，显示 title/进程名/时间(缺失隐藏)，输入被前后端屏蔽。
  - 设置：列表 + add/edit modal + Select/Input 对齐 + 快速开关/刷新 + 手动加模型 + 禁用发现模型。
- 现有 Playwright（`apps/fe/tests/*.spec.ts`）相应更新。

## 风险与注意
- base 含 run_command/ghostty 重构——已逐文件重核（HEAD `8a168a7`），行号/结构已对齐；后端注入点确定（buildTools run.ts:493、stream 循环 run.ts:414、getPaneInfo 起源采集）。实现时仍以实际文件为准。
- AI SDK hosted tool API/输出已亲验（imageGeneration → `Tool<{},{result:string}>`，output 为 base64）；唯一待运行期确认的是注册 key 与 fullStream 回传 toolName 的映射（实现时跑 A3 integration test 即可观测）。
- 队列连续 run 改 run.ts 控制流较核心：覆盖 steer 与 stop/error/确认等待并发、abort 语义、`store:false` 多轮回放完整性（approval 链 + tool-result 不拆散）。
- 中转 gpt 不一定支持 image_generation：本项目只负责正确注册 + 优雅失败（tool-error 回喂 + 看门狗兜底）。
- 布局大改触及移动端 Sheet / 安全区 / 虚拟键盘避让，注意回归。
- orphan 起源采集失败要静默降级为 null，不能阻塞建会话。
