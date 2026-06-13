# 执行结果：run_command + headless ghostty 终端工具重构

在独立 worktree `run-command-headless-ghostty`（分支 `worktree-run-command-headless-ghostty`，基于 origin/main）完成。

## 完成内容
1. **OSC 133 解析 + 透传**：`pane-stream-parser.ts` 加 `case '133'`（A/B/C/D;exit + nonce），`onPromptMarker` 沿 control-mode-subscription → connection-types → local/ssh connection → device-session-runtime 透传。
2. **Headless ghostty**：`packages/ghostty-terminal/src/headless.ts`（`HeadlessTerminal`）+ 子路径导出 `ghostty-terminal/headless`；wasm 加载改 `new URL(import.meta.url)` 跨 Vite/Bun。
3. **Per-pane emulator + 防泄漏注册表**：`pane-emulator.ts`（`PaneEmulator` + `PaneEmulatorRegistry`，引用计数复用 + free + 解绑 + bounded scrollback + LRU 驱逐 + shutdownAll）。
4. **工具改造**：`terminal.ts` read_screen/send_input/get_pane_info 切 emulator（模式感知，无 emulator 退回 capture）+ 新 `run_command`（`run-command.ts`，POSIX OSC133-nonce / CLI 提示符·分页·错误启发 / TUI entered_tui / expect / timeout）。
5. **run.ts 接线**：per-run 尽力 acquire/release emulator（runtime 无订阅则退回）。
6. **提示词**：system-prompt 环境探测 + 工具选择段。

## 验收结果
- gateway `bun test`：**495 pass / 0 fail**（47 文件）。
- shared `bun test`：**49 pass / 0 fail**。
- gateway `bun build --target bun`：通过（404 modules）。
- 前端 `bun run build`（tsc + vite）：通过，产出 `ghostty-vt-*.wasm` 资产（验证 wasm 加载改动不破坏前端）。
- Spike：ghostty-vt.wasm 在 Bun headless 跑通（gating 风险解除）。

## 新增/改动关键文件
- 新增：`packages/ghostty-terminal/src/headless.ts`（+ package.json 子路径导出）
- 新增：`apps/gateway/src/tmux-client/pane-emulator.ts`
- 新增：`apps/gateway/src/agent/tools/run-command.ts`
- 改：`pane-stream-parser.ts` / `control-mode-subscription.ts` / `connection-types.ts` / `local-external-connection.ts` / `ssh-external-connection.ts` / `device-session-runtime.ts`（OSC133 透传）
- 改：`packages/ghostty-terminal/src/ghostty-wasm.ts`（wasm 跨打包器加载）
- 改：`apps/gateway/src/agent/tools/terminal.ts`、`run.ts`、`prompts/system-prompt.tsx`
- 改：`apps/gateway/package.json`（+ ghostty-terminal 依赖）

## 测试新增
`pane-stream-parser.test.ts`(OSC133+passthrough)、`headless.test.ts`、`pane-emulator.test.ts`、`run-command.test.ts`、`system-prompt.test.ts`(run_command 断言)。

## 已知 follow-up（见 docs/agent/2026061303-...）
1. 生产打包把 `ghostty-vt.wasm` 拷进 gateway dist 运行资源（dev/测试已正常）。
2. 真 tmux 全链路 e2e integration 测试（各层单测已分别覆盖）。

## 偏离计划处
- 工具采用「emulator 优先 + capture 回退」而非硬切，使既有工具测试零改动通过、且 emulator 不可用时仍可用。
- run_command 拆为独立模块 `run-command.ts` 便于以 fake emulator 单测全分支。
- 未触碰生产打包脚本（install/run.sh），wasm 生产拷贝列为 follow-up。
