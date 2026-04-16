# 执行结果

## 结果概览

- 已补齐本地与 SSH（`sshConfigRef=localhost`）两条终端恢复回归覆盖，用于验证 `vim` 鼠标释放与 `opencode` 恢复链路。
- 已对 `focus/visibility` 恢复路径做最小修复：仅在页面确实经历过失焦/隐藏后才进入恢复逻辑；若终端尺寸未变化，则只做本地重绘，不再无条件向 tmux 发送 `TERM_SYNC_SIZE`。
- 当前新增回归中，`vim` 退出后滚轮恢复在本地与 SSH 路径均可通过；`opencode` 在本地与 SSH localhost 路径的 refresh / pane round-trip 文本恢复也可通过。

## 关键修改

1. `apps/fe/src/components/terminal/useTerminalResize.ts`
   - 新增 `viewportRestorePendingRef`。
   - 仅在窗口真实经历 `blur` / `visibilitychange(hidden)` 后，才允许后续 `focus` / `visibilitychange(visible)` 触发恢复逻辑。
   - 当终端当前尺寸已与容器尺寸一致时，不再上行发送 `TERM_SYNC_SIZE`，改为调用本地 terminal `refresh()` 进行重绘。

2. `packages/ghostty-terminal/src/terminal.ts`
   - 为终端控制器新增 `refresh()`，直接重绘当前缓冲区画面。

3. `packages/ghostty-terminal/src/types.ts`
   - 在 `CompatibleTerminalLike` 中补充可选 `refresh()` 能力声明。

4. 回归测试
   - `apps/fe/tests/ws-borsh-resize.spec.ts`
     - 新增：`focus restore does not emit TERM_SYNC_SIZE when terminal size is already current`。
   - `apps/fe/tests/terminal-mouse-recovery.spec.ts`
     - 新增：`focus restore repaints a cleared terminal canvas even when terminal size is unchanged`。
     - 新增/保留 `vim` 与 `opencode` 的本地恢复回归覆盖。
   - `apps/fe/tests/ssh-terminal-restore.spec.ts`
     - 新增 SSH localhost (`sshConfigRef=localhost`) 下的 `opencode` / `vim` 恢复回归。

## 验证结果

已执行并通过：

```bash
bun test apps/fe/src/utils/resizeSyncGuards.test.ts packages/ghostty-terminal/src/terminal.canvas.test.ts
bun run --filter @tmex/fe test:e2e -- tests/terminal-mouse-recovery.spec.ts tests/ssh-terminal-restore.spec.ts tests/ws-borsh-resize.spec.ts
bun run build:fe
```

## 结论

- Bug 2 的最小可验证修复已落地：避免在“窗口恢复但尺寸未变”的场景下继续向 tmux 发送无意义的尺寸同步，同时补上本地重绘，减少 SSH / TUI 在 refresh / 切窗后的恢复扰动。
- Bug 1 在新增的本地与 SSH 回归中未再复现，当前代码路径已具备覆盖；本轮未对鼠标路由逻辑做额外生产改动。
