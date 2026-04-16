# 三个终端/鼠标 Bug 的联合修复计划

## 背景与上下文

用户在同一会话里报告三个相互耦合的 bug：

1. **vim 退出后鼠标未释放**：vim `set mouse=a` 状态下退出后，终端内滚轮仍被当作 SGR 鼠标事件注入 pty，而非回到普通 viewport 滚动。
2. **SSH 实现完成后引入新 bug**：在（本地或 SSH）终端里运行 opencode 等 bubbletea TUI，刷新页面或在 pane 间切换后恢复的 TUI 画面残缺（与 `tmux capture-pane` 实际内容对齐不上）。涉及最近提交 `4e41fe0 / 9de181c / 494cbd1 / 664b511 / 5b61afc`。
3. **点击新建窗口按钮无反应，console 被注入 `0;1;12m`**：`0;1;12m` 是 SGR 鼠标释放事件 `CSI <0;1;12m` 去掉 `\x1b[<` 前缀后的可视残留。

三者耦合关系：
- Bug 1 的 mouse tracking 残留（WASM 内 `?1000/?1002/?1006` bit 未清）是 Bug 3 症状的直接触发条件——全局 `mouseup` 监听在 `mouseReporting=true` 时会无条件 emit SGR release，即便按下发生在终端外。
- Bug 2 与 Bug 1 共享同一条 "history/mode 恢复" 路径（`Terminal.tsx` 的 `reconcileRecoveredModes` + `restoreModeSnapshot`），修 Bug 2 的 alt-screen 恢复时需要顺带简化 mode 恢复逻辑。

## 前置任务（本 PR 开工前执行）

项目 `AGENTS.md` 要求「先存档，再干活」：
1. 新建 `prompt-archives/2026041700-terminal-three-bugs-fix/`（目录已存在可继续）
2. 创建 `plan-prompt.md` 存档本次用户原始 prompt 及后续交互
3. 将本 plan 拷贝为 `plan-00.md`
4. 实现完成后产出 `plan-00-result.md`

## Bug 1 修复方案

### 根因（按优先级）

- **P1 / 原地无刷新路径**：vim、opencode 等 TUI 退出时只发 `CSI ?1049 l`，**并不可靠地**再发 `CSI ?1000 l / ?1006 l` 等鼠标清理。WASM 中 mouseNormal 残留为 true，`getInputRoutingState().mouseReporting=true`，wheel 走 SGR 分支而非 `scrollLines`。
- **P2 / 刷新与切换 pane 路径**：`Terminal.tsx:83-109 reconcileRecoveredModes` 在 primary 分支 `return cached`，`Terminal.tsx:348-362` instance mount effect 无条件 `restoreModeSnapshot(cached)`，这两处会把 alt-screen 时期缓存下来的 `mouseNormal=true` 重新写回 WASM。

### 修改清单

**`packages/ghostty-terminal/src/terminal.ts`**

1. 新增私有方法 `clearMouseTrackingModes()`：对模式号 `9 / 1000 / 1002 / 1003` 调 `setTerminalMode(..., false)`，同时 `bindings.resetMouseEncoder(...)` 并 `this.pressedMouseButtons.clear()`。
2. 改 `write(data)` (413-420)：写 VT 前读 `prevAlt = altScreen1047 || altScreen1049`，写后再读 `nextAlt`，在边沿 `prev && !next` 时调用 `clearMouseTrackingModes()`。只做 alt→primary 边沿触发，避免干扰 primary 上显式使用鼠标追踪的应用（如 htop）。
3. 公开 `clearMouseTrackingModes()` 或在 `CompatibleTerminalLike` 上暴露，便于 FE 在必要时手动调用。
4. 考虑把 `MOUSE_TRACKING_MODES = [9, 1000, 1002, 1003]` 抽成常量集中管理。

**`apps/fe/src/components/terminal/Terminal.tsx`**

1. `reconcileRecoveredModes` primary 分支改为显式清理 tracking bits：

   ```ts
   if (!alternateScreen) {
     if (!cached) return null;
     return {
       ...cached,
       mouseX10: false,
       mouseNormal: false,
       mouseButton: false,
       mouseAny: false,
       mouseUtf8: false,
       mouseSgrPixels: false,
       mouseUrxvt: false,
       // mouseSgr / altScroll / altScreen1047 / altScreen1049 按 cached 保留
     };
   }
   ```

2. instance mount effect (348-362)：**删除** `restoreModeSnapshot(cachedModes)` 调用，让 mount 总是从 `reset()` 的干净状态开始；后续 `onApplyHistory` 会依据 backend 给出的 `alternateScreen` 正确恢复。

### 验证

已有 `apps/fe/tests/terminal-mouse-recovery.spec.ts`：
- "vim exit releases mouse wheel back to viewport scrolling **after refresh restore**" (195-248) → 覆盖 P2
- "vim exit releases mouse wheel back to viewport scrolling **without refresh**" (250-298) → 覆盖 P1
- "opencode refresh should not render pre-launch normal screen" (300-333) → 防回归

SSH 侧 `apps/fe/tests/ssh-terminal-restore.spec.ts`：
- "ssh: vim exit restores wheel scrolling after refresh restore" (209-256)

新增 unit（可选）：在 `packages/ghostty-terminal/` 内加测试，写入序列 `\x1b[?1000h\x1b[?1049h...\x1b[?1049l` 后断言 `exportModeSnapshot().mouseNormal === false`。

## Bug 2 修复方案

### 根因（按优先级）

- **P1**：`tmux capture-pane -e -p` 输出只是"当前屏幕快照 + SGR 颜色"，**没有光标定位（CUP）与屏切换（DECSET 1049）等 VT 序列**。前端把它当追加文本 `instance.write(history)` 写入 xterm，光标位置由前一个 pane 状态决定，无法精确重建 bubbletea TUI 画面。
- **P2**：`reconcileRecoveredModes` (91-108) 把 `altScreen1049: true` 直接通过 `restoreModeSnapshot → setTerminalMode` 写进 WASM；但按位 flip bit **不触发 VT 解析器的"保存 primary、切到 alt"副作用**，结果 flag 对但 buffer 不对。
- SSH 的测试 (`expectRenderedTextToTrackPane > 0.6`) 比本地 (`not.toContain 'sh-3.2$ opencode .'`) 严格，因此表现为「SSH 下暴露」，但两边都受影响。

### 确认步骤（开工前先跑）

1. `git log --stat 4e41fe0^..HEAD -- apps/gateway/src/tmux-client/` 确认最近提交到底改了什么（`hasRenderableTerminalContent` 启发式、SSH 管道符解析等）。
2. 在 opencode pane 上手动执行 `tmux capture-pane -t %N -e -p -S - -E -`，检查输出是否包含 `\x1b[H`、`\x1b[row;colH`、`\x1b[?1049h` 等序列（预计没有，只有 SGR）→ 证实 P1。
3. 在 `onApplyHistory` 打印 `data` 的首尾 32 字节确认前端收到的是什么。

### 修改清单

采用**路线 1（低风险）**：FE 在 alt-screen 回放前，构造 VT 包裹让 WASM 真正走 alt-screen 状态转换。

**`apps/fe/src/components/terminal/normalization.ts`**

新增 helper：

```ts
export function wrapAlternateScreenHistory(data: string): string {
  const normalized = normalizeHistoryForTerminal(data);
  return '\x1b[?1049h\x1b[H\x1b[2J' + normalized;
}
```

**`apps/fe/src/components/terminal/Terminal.tsx`**

1. `onApplyHistory` (295-310)：

   ```ts
   const payload = alternateScreen
     ? wrapAlternateScreenHistory(data)
     : normalizeHistoryForTerminal(data);
   instance.write(payload);
   ```

2. 配合 Bug 1 P2 的改动，移除 `reconcileRecoveredModes` 里对 `altScreen1049 / altScreen1047` 的强写；交由新加的 VT preamble 触发 WASM 切屏。

3. alt-screen 分支的 mouse mode 保留给 cached（如缓存为空则用 `createAlternateScreenFallbackSnapshot()` 的 tracking 部分），不再强行假定 `altScreen1049: true`。

**`apps/gateway/` 不改动**。

### 验证

- `apps/fe/tests/ssh-terminal-restore.spec.ts` 130-163（refresh）、165-207（round-trip）必须绿。
- 本地 `apps/fe/tests/terminal-mouse-recovery.spec.ts` 300-377（opencode）必须绿且未回归。
- 手测：本地/SSH pane 打开 opencode → 刷新 → 画面与 `tmux capture-pane -p` 输出肉眼对齐；在 pane 间切换回来同样对齐。

## Bug 3 修复方案

### 根因链

1. Bug 1 的 mouse mode 残留使 `getInputRoutingState().mouseReporting=true`。
2. `packages/ghostty-terminal/src/terminal.ts:744-783` 在 `window` 上注册的全局 `mouseup/mousemove` 监听，在 `mouseReporting=true` 时**无条件** emit SGR（不检查拖拽是否起源于终端内部）。
3. 用户点 Sidebar 新建窗口按钮，**点击的 mouseup 阶段触发全局监听**，SGR release 被注入 pty。`\x1b[<` 被视为 CSI 序列（无匹配 final byte）影响终端显示，可见部分残留为 `0;1;12m`。"按钮无反应" 是该 side effect 触发的 React 重渲染/组件状态变化导致 click 被抢占。

### 修改清单

**`packages/ghostty-terminal/src/terminal.ts`**

1. 新增 `private mouseDragActive = false;`。
2. `selectSurface.addEventListener('mousedown', ...)` (682-716)：在 `mouseReporting` 分支发出 press 事件时置 `this.mouseDragActive = true;`；进入选区 `beginPointerSelection` 路径也置 true（或独立 flag，但共用一个更简洁）。
3. 全局 `moveListener` / `upListener` (744-776)：入口加守卫——`mouseDragActive === false` 时，mouse reporting 分支直接 return（**不 emit**），选区分支 `updatePointerSelection`/`finishPointerSelection` 由各自的 null-guard 决定是否 no-op。
4. `upListener` 清理 `this.mouseDragActive = false;`。

**`apps/fe/src/components/Sidebar.tsx`**

新建窗口按钮（573-587）加防御：

```tsx
onPointerDown={(event) => event.stopPropagation()}
onMouseDown={(event) => event.stopPropagation()}
```

其他 Sidebar Button（device-select、device-delete 等）采用一致处理。
注意：`stopPropagation` 不会阻止 `window`-level 原生监听，真正的修复是 terminal.ts 的 `mouseDragActive` 守卫。这里只是附加防御层。

### 验证

- 修复后，Bug 1 消失 → Bug 3 的"鼠标 tracking 残留 + 全局 mouseup 注入"触发链被切断。
- 新增 `apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`：
  1. 开一个 vim `set mouse=a` 的 pane
  2. 确认 `alternate_on='1'`、WASM mouse tracking 开启
  3. 订阅 pty input（通过 test hook 或 network observer）
  4. 点击 `[data-testid^=window-create-]`
  5. 断言：pty 未收到任何 `\x1b[<` 起始的 SGR 序列；窗口创建请求成功发出
- 确认选区拖拽（在终端内 mousedown + move + mouseup）仍正常 — 若无现成测试需补一个。

## 共享重点

| 修改点 | 影响 Bug | 说明 |
|---|---|---|
| `terminal.ts clearMouseTrackingModes` + alt→primary 边沿清理 | 1, 3 | 根除 WASM 内残留 tracking bit |
| `reconcileRecoveredModes` primary 分支清理 + 移除 mount restoreModeSnapshot | 1 | 根除缓存把残留 bit 写回 |
| `wrapAlternateScreenHistory` + `onApplyHistory` 使用它 + 移除 alt-screen flag 强写 | 2 | 让 WASM 走真正的切屏流程 |
| `mouseDragActive` 守卫全局 mouseup/mousemove | 3 | 即便 tracking 未清也不再误注入 |
| Sidebar Button stopPropagation | 3 | 附加防御 |

## 关键文件清单

- `/Users/krhougs/LocalCodes/tmex/packages/ghostty-terminal/src/terminal.ts`
- `/Users/krhougs/LocalCodes/tmex/packages/ghostty-terminal/src/types.ts`
- `/Users/krhougs/LocalCodes/tmex/apps/fe/src/components/terminal/Terminal.tsx`
- `/Users/krhougs/LocalCodes/tmex/apps/fe/src/components/terminal/normalization.ts`
- `/Users/krhougs/LocalCodes/tmex/apps/fe/src/components/Sidebar.tsx`
- `/Users/krhougs/LocalCodes/tmex/apps/fe/tests/terminal-mouse-recovery.spec.ts`（参考、不改）
- `/Users/krhougs/LocalCodes/tmex/apps/fe/tests/ssh-terminal-restore.spec.ts`（参考、不改）
- 新增 `/Users/krhougs/LocalCodes/tmex/apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`

## 验证总清单

| 测试文件 | 覆盖 Bug | 要求 |
|---|---|---|
| `terminal-mouse-recovery.spec.ts` 195-248 | 1 refresh | 绿 |
| `terminal-mouse-recovery.spec.ts` 250-298 | 1 无 refresh | 绿 |
| `terminal-mouse-recovery.spec.ts` 300-377 | 2 local opencode | 绿 |
| `ssh-terminal-restore.spec.ts` 130-163 | 2 SSH refresh | 绿 |
| `ssh-terminal-restore.spec.ts` 165-207 | 2 SSH round-trip | 绿 |
| `ssh-terminal-restore.spec.ts` 209-256 | 1 SSH 路径 | 绿 |
| 新增 `sidebar-click-no-pty-injection.spec.ts` | 3 | 新建 |
| 新增 ghostty-terminal unit（alt-screen 退出后 mouse bit 自动清） | 1 | 新建 |

手测清单：
1. 本地 pane：`vim -c 'set mouse=a'` → `:qa!` → wheel 正常滚动 scrollback（无 SGR 注入）。
2. 本地 pane：`opencode` → 刷新 → 画面对齐。
3. SSH 同上两项。
4. 上述任一场景下点击 Sidebar「新建窗口」→ 窗口被创建；终端中无 `0;1;12m` 残留。

## 注意事项

- Bug 2 的 VT wrapping 是启发式方案，可能在极端 TUI 场景（多行 wrap、宽字符）中仍有细节偏差。实施阶段如果 `expectRenderedTextToTrackPane` 仍不过，再考虑：在 preamble 末尾加 `\x1b[?25l`（隐藏光标）或 `\x1b[0m`（reset SGR）；或调整为 `\x1b[?47h` + `\x1b[H\x1b[2J`。
- Bug 1 的 alt→primary 边沿清理是保守策略：仅在 alt-screen 从 true → false 时执行。不影响 primary 上长期启用鼠标的应用。
- 本 PR 不修改 gateway（`apps/gateway/src/tmux-client/*`），gateway 最近改动保持不变。
