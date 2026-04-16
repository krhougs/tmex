## Prompt 00

- 用户问题：为什么切换到运行 opencode 的 pane 之后，可以清楚看到多了一行非预期的空行，导致 TUI 更新出错。
- 分析阶段要求：并行收集上下文，使用 explore / librarian / 直接工具先调查，不直接实现。
- 后续补充事实：冷启动直接进入 opencode pane 也会复现；普通 shell 也会复现。
- 最终用户指令：直接尝试修复。

## 当前实现解释

- 已完成代码级调查。
- 目前最可疑点：`apps/fe/src/components/terminal/Terminal.tsx` 中 `normalizeHistoryForTerminal()` 与 `normalizeLiveOutputForTerminal()` 对输出流进行了 CRLF 归一化。
- 次级嫌疑：`packages/ghostty-terminal/src/terminal.ts` 中 rows / viewport / visibleLines 映射存在 off-by-one 风险。
- 本次实施策略：先补最小失败测试锁定归一化逻辑，再做最小修复，最后验证；只有在主路径失败时才继续排查 ghostty viewport 逻辑。
