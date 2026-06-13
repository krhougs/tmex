# 终端 AI Agent + Watch 监控 — 执行结果总结

完成于 2026-06-13，分支 `feature/terminal-agent-watch`。功能文档见
`docs/agent/2026061300-terminal-agent-overview.md` 与 `docs/watch/2026061300-watch-monitor-overview.md`
（含 plan-00.md 验证节逐条的覆盖方式对照表）。

## 各任务 commit 清单（按实施顺序）

### Task 0 存档
- `b411a38` docs(prompt-archives): archive terminal agent + watch plan

### Task 1 DB（7 表 + 查询助手 + migration）
- `b44965f` feat(gateway): add agent and watch db schema with query helpers
- `1d6d565` fix(gateway): guard confirmation decision with CAS and type enum columns
- `13b1394` test(gateway): refuse to run tests against production database（防护：测试拒绝生产库，事故修复）

### Task 2 capturePaneText
- `5b9c80d` feat(gateway): expose on-demand plain-text pane capture on tmux connections

### Task 3 AI SDK spike + provider registry + LLM REST
- `85294a2` feat(gateway): add ai sdk spike and llm provider registry
- `d573e5d` feat(gateway): add llm providers and agent settings rest api
- `340849b` fix(gateway): harden llm api input validation and unify shared types

### Task 4 WS 协议扩展 + AgentWsHub
- `5ee41c3` feat(shared): ws-borsh 协议新增 agent/watch 消息与通知事件类型
- `ce33f80` feat(gateway): AgentWsHub 订阅 hub 与 WS 接线
- `7cb98bb` fix(gateway): AgentWsHub 广播入口加事件类型护栏与 u8 越界断言

### Task 5 Agent runtime + REST（result：task-05-result.md）
- `a598175` feat(shared): agent session DTO、错误/通知 i18n 文案与 confirmation 可指定 id
- `e9d1998` feat(gateway): agent 终端/web 工具集与系统提示词
- `0d63681` feat(gateway): AgentRun/AgentSupervisor 服务端 agent runtime
- `61adc83` feat(gateway): agent session REST API
- `fac4efc` fix(e2e): playwright gateway webServer 钉死仓库内 TMEX_MIGRATIONS_DIR
- `744bff5` docs(prompt-archives): Task 5 执行结果存档
- `f5e2a79` fix(agent): 修复 runtime 质量审查发现的安全与健壮性问题

### Task 6 Watch service + REST（result：task-06-result.md）
- `7aa6764` feat(tmux-client): runTmux 增加 target-missing 静默形态供主动采样使用
- `2825bd9` feat(watch): 新增 match/unchanged 规则纯函数求值器
- `1799b5b` feat(watch): WatchService 周期采样编排与通知/WS 触发链路
- `2be3d39` feat(watch): Watch 规则 REST API 与 assist-regex
- `c195b7c` docs(prompt-archives): 存档 Task 6 prompt 与执行结果
- `c8a381c` fix(watch): 修复 in-flight tick 并发、死 runtime 复用与若干审查问题

### Task 7 右边栏骨架
- `bd076d6` feat(fe): agent panel container and skeleton (Task 7)

### Task 8 agent store + 对话 UI + 确认流（result：task-08-result.md）
- `d5bfb4b` feat(fe): agent store 与 WS 订阅、消息线程解析
- `c1c2d0e` feat(fe): agent 面板流式对话 UI 与确认流
- `4a4f1c0` test(fe): agent session e2e（mock LLM 全链路）
- `30ae073` docs(prompt-archives): 存档 Task 8 执行结果
- `5975221` fix(fe): Task 8 spec 审查修复
- `8ff695d` fix(agent): Task 8 质量审查修复

### Task 9 Settings 两 tab
- `6841437` feat(fe): add LLM providers and search settings tabs
- `9157a19` fix(fe): settings review fixes for llm/search tabs

### Task 10 Watch UI（result：task-10-result.md）
- `0698d4c` feat(fe): watch rule dialog with list/form/state views and pane entries
- `628b739` feat(fe): watch event notifications via WATCH_EVENT websocket
- `165519d` test(e2e): watch rules dialog CRUD, mocked assist-regex and real trigger toast
- `ce72255` docs(archive): task-10 watch frontend ui result
- `a3a2184` fix(fe): watch review fixes for provider mismatch display and toast length

### Task 11 端到端验证 + 补缺口 e2e + 文档（本次）
- `9d31a53` fix(gateway): web 工具测试消除新增 tsc 错误
- `3b90669` docs(agent,watch): 终端 AI Agent 与 Watch 监控总览文档
- `55fdc55` docs(prompt-archives): Task 11 prompt 与 plan-00 执行结果存档
- `9332464` test(e2e): agent 确认流 UI 全链路与移动端 agent/watch spot check

## 全量回归结果（Task 11）

- gateway `bun run test`：**429 pass / 0 fail**（41 文件；其中 agent/watch/llm 模块 157 例 + 对应 REST 71 例）
- shared `bun test`：**39 pass / 0 fail**
- fe e2e 全量（9885/9665）：**59 passed / 1 failed / 1 skipped**——唯一失败 `sidebar-delete` 为 MEMORY 既有基线失败（device-delete testid 在旧 Sidebar 组件），与本功能无关；本轮 terminal-selection-canvas / opencode 既有 flaky 未复现
- 三包 tsc 对照 main 基线：fe 0 错；shared 2 错（基线持平）；gateway 12 错 < 基线 12+2（分支顺带修复 runtime-registry.test 2 个基线错误；本任务消除了 web.test.ts 唯一新增错误）
- 新增/改动 e2e 复跑：agent-session 5 例 + mobile-agent-watch 2 例 **7/7 通过**，新增用例另行 `--repeat-each=3` 压测通过

## Task 11 新增 e2e

1. `agent-session.spec.ts` › confirm flow：mock LLM server 扩展 tool call SSE 形状
   （用户消息 `RUN_COMMAND <cmd>` → `send_input` tool call；本轮已有 tool 结果则回收尾文本）。
   断言：确认卡片出现 → 点允许 → `tmux capture-pane` 验证命令真实执行 → 续跑文本上屏 → idle；
   第二轮点拒绝 → denied 卡片 → 命令未写入 pane。
2. `mobile-agent-watch.spec.ts`（375x812）：agent 面板 Sheet 形态打开、输入框在视口内、
   session 切换菜单可弹出、Sheet 可关闭；WatchDialog 打开、表单可达（长表单滚动到保存按钮）。
3. 明确不重复做 e2e、由单测覆盖的项：gateway 重启恢复（supervisor.test）、SSH 断开
   fail-fast（run.test 终端工具连续失败）、watch unchanged 时序 / 降级策略（evaluator/service.test）。

## 规格偏差汇总（相对 plan-00.md，详见各 task result）

1. **同回合多确认须全部决定后合并一条 tool 消息再续跑**（AI SDK `collectToolApprovals` 只消费最后一条 tool 消息）。
2. **stop 取消 pending 走合成 `execution-denied` tool-result** 而非 approval-response（防悬空 approval 炸掉后续请求）。
3. **waiting_confirmation 时投递新消息返回 409**，要求先决策。
4. **重启恢复自愈**：waiting_confirmation 但 pending 丢失（crash 中间态）→ 按已决议补 response 续跑，否则置 idle；running 残留 pending 先作废。
5. **unchanged + once 不停用规则**，值变化后自动重新武装（match/llm + once 才停用）。
6. **pattern 编译错误计入 consecutiveErrors** 并走统一自动停用路径（plan 只规定 capture 失败）。
7. **llm 型规则不提供 confirmWithLlm/summarizeWithLlm**（模型本身是判断主体），通知文案用模型 reason。
8. confirmWithLlm 被否决不写触发标记，下周期重新确认（每周期最多一次确认调用）。
9. **MESSAGE_PERSISTED 不携带消息内容**，前端一律 afterSeq 增量 REST 拉取（stale barrier 机制去重残余 delta）。
10. 确认卡片前端兜底：approval 等待时无 TOOL_CALL 广播，用 CONFIRMATION_REQUEST payload 合成卡片。
11. 计划中的"手动 dev 验证"（双标签页/刷新恢复/确认流/移动端）全部改为自动化 e2e。
12. turn_finished 通知为 deps 级开关（默认开），未做用户级持久化设置项。

## 遗留债务清单

详细背景见两篇 overview 文档"已知限制与记债"节。

- **安全**：fetch_url 仅 hostname 级私网判断，未防 DNS rebinding；auto 模式中断重放风险（send_input journal 未实现）。
- **功能**：token 用量统计；Telegram inline 按钮直接确认；agent 跨多 pane；llm 型 watch 判断不带历史样本时序。
- **工程**：AGENT_EVENT 广播无订阅者级背压（前端 40ms 节流缓解）；agent error 重试链路全程 60-70s 前端无进度感知；watch 规则列表"最近触发"N+1 state 请求；TRIGGERED toast 整页跳转未走 SPA navigate；agent_turn_finished 无用户级开关。
- **环境**（非本功能引入）：`sidebar-delete` e2e 基线失败待修；gateway 12 个历史 tsc 噪声错误。
