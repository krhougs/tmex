# 2026082300-terminal-checkpoint-continuity / plan-prompt

## 背景

Vibe X 消费 tmex canonical terminal snapshot 时发现：

- snapshot 的最后一个非默认背景可能污染 barrier 后输出；
- snapshot 没有恢复 scroll region、origin、insert、wrap、cursor/keypad 等 VT 延续状态；
- Codex/OMP 等 TUI 在冷恢复后出现背景行缺失或多出背景行。

要求采用应用无关的通用 checkpoint 方案，不针对具体 TUI 或 glyph 打补丁。跨仓完整计划位于 vibex：

`prompt-archives/2026082300-terminal-checkpoint-continuity/plan-00.md`

## tmex 实施范围

1. `tmex-terminal` 导出当前 SGR continuation 的中性结构与确定性 ANSI 编码。
2. control/fallback capture 在同一屏幕信息格式中取得 tmux scroll region、origin、insert、wrap、cursor、application cursor/keypad 和 tab stops。
3. canonical checkpoint body 追加通用 continuation trailer，并将其纳入 byte limit；wire schema不变。
4. 永久测试只覆盖背景泄漏、partial scroll region 后增量输出、known/unknown SGR 与小 byte limit 真实回归。

安全约束：只在 vibex 任务 worktree 的 vendor checkout 修改；tmux 实测使用独立 socket，禁止默认 `tmex` session与生产服务。

