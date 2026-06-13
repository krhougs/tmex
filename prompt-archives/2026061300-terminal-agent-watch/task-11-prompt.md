# Task 11 Prompt — 端到端验证、补缺口 e2e、文档与存档

你在 /Users/krhougs/LocalCodes/tmex 仓库的 feature/terminal-agent-watch 分支上执行 Task 11（最后任务）：端到端验证、补缺口 e2e、文档与存档。用简体中文沟通。

## 背景

"终端 AI Agent + Watch 监控"功能已全部实现（Task 1-10）：DB 7 表、capturePaneText、AI SDK provider 层、WS 协议扩展、Agent runtime（supervisor/run/tools/REST）、Watch service（evaluator/service/REST/assist-regex）、前端右边栏+对话流+确认流、Settings 两 tab、Watch UI。计划全文在 `prompt-archives/2026061300-terminal-agent-watch/plan-00.md`（读它了解全貌与验收标准）。

已有验证覆盖：gateway 429+ 单测（含 approval approve/deny 续跑、abort、fail-fast、watch evaluator/service 全分支、重启恢复）、fe e2e（agent-panel、agent-session 含 mock LLM 流式/刷新恢复/双标签同步/error banner、settings-llm、watch 含真实触发链路）。

**红线**：严禁触碰生产 tmex（9883/19883、Application Support、用户 tmux 会话 tmex）；e2e 必须显式 TMEX_E2E_FE_PORT=9885 TMEX_E2E_GATEWAY_PORT=9665（playwright.config 已有裸跑防护）；gateway 测试用 bun run test。

## 任务内容

### 1. 全量回归
- gateway/shared/fe（bun test 单测）+ fe e2e 全量（9885/9665）。已知既有 flaky：sidebar-delete（基线失败）、terminal-selection-canvas autoscroll/:220、opencode 相关（MEMORY 清单）。判定回归前先看失败项是否在清单内；拿不准就对该 spec 跑基线对照
- 三包 tsc 对照基线无新增

### 2. 补缺口 e2e（务实评估，每项先判断成本，做不动就明确标注"由单测覆盖"）
- **确认流 UI e2e**（价值最高）：tests/agent-session.spec.ts 的 mock LLM server 已有，扩展它发 tool call（send_input needsApproval）→ UI 出现确认卡片 → 点允许 → 工具执行续跑 → 文本上屏；再来一轮点拒绝。mock server 需支持 tool call SSE 形状（参考 gateway 的 ai-sdk.spike.test.ts mock）。注意 session 默认 writeMode=confirm
- **移动端视口 spot check**：375x812 视口下打开 agent 面板（Sheet）、输入框可见、WatchDialog 可用——加进现有 spec 或新 spec
- **gateway 重启恢复 / SSH 断开 fail-fast / watch unchanged 时序**：单测已覆盖（supervisor.test、run.test、evaluator/service.test），e2e 不重复做，在文档里注明覆盖位置

### 3. 文档（docs/ 按 AGENTS.md 规范：模块文件夹+日期编号命名、简体中文、专业简洁、初级工程师可读）
- `docs/agent/2026061300-terminal-agent-overview.md`：背景目标、架构（supervisor/run/tools/hub/REST/WS 事件流图——文字描述即可）、生命周期语义（页面关闭 vs SSH 断开 fail-fast、重启恢复、确认挂起零成本）、安全（writeMode 确认、SSRF 防护、隐私提示屏幕内容外发、auto 模式中断重放风险）、已知限制与记债（DNS rebinding、token 用量统计、Telegram inline 确认、多 pane、ws 背压）
- `docs/watch/2026061300-watch-monitor-overview.md`：三种 triggerType 语义（含 unchanged 卡住检测 use case）、LLM 介入点与降级策略（fail-open/摘要降级/告警只发一次）、采样调度与连接管理、assist-regex
- 各文档含验收标准对照（plan-00.md 的验证节逐条标注覆盖方式：单测/e2e/文档说明）

### 4. 存档
- `prompt-archives/2026061300-terminal-agent-watch/plan-00-result.md`：执行结果总结——各任务 commit 清单（git log 整理）、测试规模、规格偏差汇总（各 task result 文件里有，汇总之）、遗留债务清单
- 全部独立 commit

## 汇报
回归结果（数字）、新增 e2e、文档清单、遗留债务清单。
