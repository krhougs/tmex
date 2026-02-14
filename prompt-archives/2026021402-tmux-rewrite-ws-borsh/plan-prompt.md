# Prompt Archive

## 用户原始需求

> 现在的 tmux 控制部分的代码写的和麻花差不多，我们需要进行大的重构以保证：
> 1. window/pane 状态同步，window/pane 切换行为正常
> 2. pane 初始化/切换/resize 能正确处理 pty 长宽变化
> 3. 正确处理复杂控制字符以兼容 vim、opencode 等应用的鼠标操作
> 4. pane 初始化/切换能正常处理历史记录并和新数据合并
> 5. 正确处理响铃
> 6. 正确处理终端特殊字符和事件
>
> 请系统性 review 当前 Gateway 和前端的代码，给出重写方案（不仅仅是重构）。

## 追加需求（对话中逐步明确）

> ws 中的传输协议可能要选一个简单的二进制协议。

> 用 `@zorsh/zorsh` 这个包实现的 borsh 协议，注意看文档。

> 可以，做好文档和 js 那边的数据结构转换。

> 重新出一个 plan：plan 中要写完整的 ws 协议设计、状态机设计之类的，同时需要更新文档。

> 先归档 plan 和几个文档。

> 2026-02-14：先阅读 `AGENTS.md`，再阅读 `plan-00.md`，并在确保阅读完计划中提到的所有文档之后再开始实施计划。

> 2026-02-14：继续剩下的工作（补齐 Phase 5：bell 频控/去重、TMUX_SELECT 携带 cols/rows、FE Playwright e2e）。

## 本次归档范围

- `prompt-archives/2026021402-tmux-rewrite-ws-borsh/plan-prompt.md`（本文件）
- `prompt-archives/2026021402-tmux-rewrite-ws-borsh/plan-00.md`（重写计划）
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`（WS 协议规范）
- `docs/ws-protocol/2026021403-ws-state-machines.md`（状态机设计）
- `docs/terminal/2026021404-terminal-switch-barrier-design.md`（切换屏障设计）
- 更新：`docs/2026021000-tmex-bootstrap/architecture.md`
- 更新：`README.md`
