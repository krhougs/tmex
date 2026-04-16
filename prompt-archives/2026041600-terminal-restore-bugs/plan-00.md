# 计划：终端鼠标恢复与 SSH TUI 恢复缺陷修复

## 背景

- 当前存在两个回归缺陷：
  1. `vim` 退出后鼠标滚轮仍然继续发送鼠标事件，没有恢复为普通终端滚动。
  2. 最近 SSH 实现完成后，终端中打开 `opencode`，在刷新页面或切换窗口后恢复的 TUI 残缺。
- 当前终端链路主要涉及：`apps/fe/src/pages/DevicePage.tsx` → `apps/fe/src/components/terminal/Terminal.tsx` → `packages/ghostty-terminal/src/terminal.ts`。
- 当前 gateway 恢复链路主要涉及：`apps/gateway/src/ws/index.ts` → `apps/gateway/src/tmux-client/*`。
- 现有本地恢复覆盖已存在于 `apps/fe/tests/terminal-mouse-recovery.spec.ts`；本地 adapter 覆盖已存在于 `apps/gateway/src/tmux-client/local-external-connection.test.ts`。

## 注意事项

- 仅修复用户报告的两个缺陷，不扩展范围。
- 必须先确认根因，再补失败用例，再做最小修复。
- Bug 2 不能先假定是前端问题，必须先判断问题起点是在 SSH 历史捕获、WebSocket 恢复帧投递，还是前端恢复时序。
- TDD 优先：先写失败用例并确认失败原因正确，再修改生产代码。
- 若需继续恢复上下文，应优先参考本档案目录中的 `plan-prompt.md` 与本计划。

## 实施步骤

1. 建立基线并确认调查入口。
   - 检查近期相关提交：`bd6e2dc`、`2beb274`、`4e41fe0`、`9de181c`。
   - 复现 Bug 1，并准备本地最小复现场景。
   - 复现 Bug 2，并收集刷新/切窗恢复时的帧级证据。

2. 为 Bug 1 补失败用例。
   - 目标文件：`packages/ghostty-terminal/src/terminal.canvas.test.ts`。
   - 如有必要，再补 `apps/fe/tests/terminal-mouse-recovery.spec.ts` 的端到端回归用例。
   - 断言重点：退出 `vim` 后，终端模式清理正确，滚轮重新驱动本地视口滚动而不是继续转发给应用。

3. 为 Bug 2 补失败用例。
   - 目标文件：`apps/gateway/src/tmux-client/ssh-external-connection.test.ts`。
   - 参考对照：`apps/gateway/src/tmux-client/local-external-connection.test.ts`。
   - 如需端到端验证，可补 SSH 条件下的恢复回归用例，并检查 `TERM_HISTORY` / `alternateScreen` 帧内容是否正确。

4. 实施最小修复。
   - Bug 1 优先检查 `packages/ghostty-terminal/src/terminal.ts`，必要时再检查 `apps/fe/src/components/terminal/Terminal.tsx`。
   - Bug 2 优先检查 `apps/gateway/src/tmux-client/ssh-external-connection.ts`，只有在 SSH adapter 证据正常时才继续下探 `apps/gateway/src/ws/index.ts`、`apps/fe/src/ws-borsh/state-machine.ts`、`apps/fe/src/stores/tmux.ts`、`apps/fe/src/components/terminal/Terminal.tsx`。

5. 验证。
   - 运行每个缺陷对应的目标测试。
   - 运行相关端到端用例。
   - 手工验证：
     - Bug 1：进入 `vim` 开启鼠标，退出后滚轮应恢复滚动 shell scrollback；再次进入 `vim` 时滚轮仍应被应用接管。
     - Bug 2：SSH 设备中启动 `opencode .`，刷新页面、切换窗口后恢复的视图应完整，不应露出启动前 shell prompt，也不应只恢复局部内容。

## 风险评估

- Bug 1 可能位于 `ghostty-terminal` 的模式处理层，而不是前端组件层。
- Bug 2 自动化验证依赖稳定可用的 SSH 测试目标。
- `opencode` 文本内容本身不适合作为唯一断言，应尽量使用更稳定的不变量，如 `alternateScreen=true`、恢复后缓冲区内容完整且无启动前 prompt 泄漏。
