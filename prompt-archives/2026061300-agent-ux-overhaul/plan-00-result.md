# Agent / 前端体验优化 — 执行结果

基线 HEAD `8a168a7`（功能基线 `143891c` run_command/ghostty），分支 `feat/agent-ux-overhaul`。

## 完成情况总览

| 工作项 | 状态 | 验证 |
|---|---|---|
| DB schema + 迁移 | ✅ | 迁移 `0005` 应用干净；建/改会话测试绿 |
| #1 Agent hosted tools（image_generation 等） | ✅ | 注册表 + openai-responses gating；live 实测脚本 `test:live:hosted-tool` |
| #2 失败不卡死（看门狗） | ✅ | 单测「流空闲看门狗」绿（stall→abort→error） |
| A2 内联图片渲染 | ✅ | tool-call-card 通用图片探测渲染；fe build 绿 |
| B 左 Sidebar 三 Tab + 删右 Panel | ✅ | fe vite build 绿 |
| C1–C3 会话并入 Panes 树 + 草稿 + 模型选择 | ✅ | fe build 绿 |
| C4 steer + 消息队列（编辑/撤回） | ✅ | 单测「运行中入队→step 边界注入续跑」绿 |
| D Orphan 历史 + 屏蔽输入 | ✅ | 单测「orphan 拒绝发消息」绿 |
| E 设置页 Provider 列表 + Modal + 模型管理 | ✅ | fe build 绿 |
| F i18n / 测试 / 验证 | ✅ 基本完成 | i18n 三语 + 重建；gateway 498 + shared 49 测试绿；e2e spec 更新见下 |

**构建/测试**：gateway `bun test` 498 pass / 0 fail；shared 49 pass；`@tmex/fe` vite 生产构建通过；gateway `bun build` 通过。

## 后端要点

- **Hosted tools**：`apps/gateway/src/agent/tools/hosted.ts` 可扩展工厂表（`image_generation`/`code_interpreter`，已核 `@ai-sdk/openai@3.0.71` d.ts：`Tool<{}, {result:string}>`）。`provider-registry.ts` 抽 `resolveOpenAIResponsesProvider` 复用于 web_search/hosted；`run.ts buildTools` 注入；`api/agent.ts` 校验（仅 responses 协议、已知 key）。session 加列 `provider_hosted_tools`。
- **看门狗**：`run.ts runOnce` 给 fullStream 加空闲定时器（`streamIdleTimeoutMs` 默认 90s），超时 abort 并 `finishError(agent.error.streamStalled)`，永不无限挂起。
- **队列 + steer**：新表 `agent_queued_messages` + CRUD；`supervisor.submitUserMessage` 运行中改入队（返回 `{kind,record}`）、`editQueuedMessage`/`withdrawQueuedMessage`/steer；`run.ts` 改为**队列感知连续 run**（每迭代重建 abortController，`onStepFinish` 检测队列→优雅中断 drain→续跑，手动 steer 立即中断；`RunOnceResult='steer'` 不逃逸 execute）；WS `AGENT_EVENT_QUEUE_UPDATED(13)` + SYNC `queuedMessages`；REST `GET/POST /sessions/:id/queue`、`PATCH/DELETE /queue/:id`。
- **Orphan + 起源元数据**：session 加列 `origin_pane_title`/`origin_process_name`，创建时经 `tmuxRuntimeRegistry.acquire().getPaneInfo().currentCommand` 采集（失败静默 null）；`AgentSessionOrphanedError` 在 submit/queue/steer 拦截（deviceId 空/设备缺失）。

## 前端要点

- **布局**：`ui` store 加 `sidebarTab` 持久化；`app-sidebar.tsx` 顶部 Panes/Agent/Files 三 Tab；`main.tsx` 移除 RightPanel；`right-panel.tsx`/`agent-panel.tsx`/`session-switcher.tsx` 退役删除。新增 `agent-tab.tsx`（草稿/模型/队列/orphan 整合）、`files-tab.tsx`（Coming Soon）。
- **会话树**：`sidebar-device-list.tsx` pane 节点下挂会话子分支（点击→setActive+导航 pane+切 Agent tab）+ 内联「+」建草稿；底部「孤立会话」可折叠区（显示标题/进程名/时间，缺失字段隐藏，只读）。
- **草稿**：agent store `draft` + `startDraft/updateDraft/materializeDraft`；空草稿不落库，首条消息才 `createSession`。
- **模型选择**：`model-picker.tsx`，草稿走 `updateDraft`、真实会话走 `setSessionModel`（PATCH），运行中禁用。
- **队列 UI**：`queue-chips.tsx`，编辑/撤回/立即 steer；ChatInput 运行中入队、闪电 steer、停止三态。
- **图片**：tool-call-card 通用 base64/data-url/图片 URL 探测，内联 `<img>`，并抑制原始 base64 文本转储。
- **设置**：`llm-providers-tab.tsx` 列表化 + `llm-provider-form-modal.tsx`（修复 Select/Input 对齐：统一 `h-9 w-full`）+ `llm-provider-models.tsx`（逐模型启停 + 手动加模型，PATCH manualModels/disabledModels）+ 行内启停/刷新。

## i18n
新增 gateway 错误 key（`apiError.agentHostedTool*`/`agentSessionOrphaned`/`agentQueuedMessageNotFound`、`agent.error.streamStalled`）与前端 key（`sidebar.tab.*`/`sidebar.orphanedSessions`、`agent.model.*`/`agent.queue.*`/`agent.orphan.*`/`agent.files.comingSoon`/`agent.session.switch|selectPaneHint`、`settings.llm.editProvider|formHint|models|modelManual|addModelPlaceholder`），三语录入并 `build:i18n` 重建。

## 测试
- gateway 单测新增：队列续跑、orphan 拦截、流看门狗。
- live 实测脚本 `test:live:hosted-tool`（需 `test.env.local` 的 responses 中转 gpt，默认 `bun test` 不发现）。
- e2e（已实跑全绿）：`agent-panel.spec.ts`(1)、`agent-session.spec.ts`(6，含恢复的 rename/delete)、`mobile-agent-watch.spec.ts`(2)、`settings-llm.spec.ts`(1) 全部更新并通过；侧栏回归 sanity `sidebar-rename`/`sidebar-close-confirm`/`devices`/`mobile-nav`(5) 全绿，证明 Tab 化未影响 Panes 树。
- 唯一 e2e 失败 `sidebar-delete.spec.ts` 为**既有**问题：它点击的 `device-delete-<id>` 只存在于**未被引用的遗留组件** `src/components/Sidebar.tsx`（本分支未触碰），实际渲染的侧栏 `sidebar-device-list.tsx`（main 与本分支皆）无设备删除入口——与本次改动无关，超出本 plan 范围（设备管理）。
- 会话 rename/delete UI 在重构中一度随 session-switcher 删除而丢失，已在 `sidebar-device-list.tsx` 补回（`SessionActionsMenu` + rename Dialog + delete AlertDialog）。

## 风险/注意
- 中转 gpt 是否真支持 image_generation 取决于上游；本项目只负责正确注册 + 优雅失败（tool-error 回喂 + 看门狗兜底）。
- 队列续跑改了 `run.ts` 控制流核心：abort/stop/steer/确认等待并发、`store:false` 多轮回放完整性均沿用既有不变量，498 测试覆盖。
- 生产部署照常走发版 + `tmex upgrade`；本次仅在 worktree 内开发与验证，未触碰本机 9883 常驻实例。
