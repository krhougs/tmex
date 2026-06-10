# 执行结果：网页终端快捷键 / 粘贴 / 选择复制修复

## 根因与修复

### 1. Ctrl-C 等快捷键失效

根因（三个叠加）：

- `packages/ghostty-terminal/src/terminal.ts` keydown：只要存在选区，Ctrl/Cmd+C 一律被拦截为复制，且复制后**不清除选区**。选区一旦建立几乎不会自动消失，导致此后所有 Ctrl+C 永远变成复制，SIGINT 发不出去。
- `isCopyShortcut` 不分平台：mac 上 Ctrl+C（应发 SIGINT）也被当作复制快捷键。
- `apps/fe/src/components/ui/sidebar.tsx` 在 `window` 上全局拦截 Ctrl/Cmd+B（tmux 默认前缀键）并切换侧栏。

修复：

- 复制后立即清除选区（与 Windows Terminal 行为一致），下一次 Ctrl+C 直通终端发 0x03。
- `selection-clipboard.ts` 平台感知：mac 复制键为 Cmd+C（Ctrl+C 永远直通）；其它平台为 Ctrl+C / Ctrl+Shift+C（仅有选区时）。
- sidebar 快捷键忽略 `defaultPrevented` 的事件和来自 `.xterm` 内部的事件。

### 2. 粘贴不工作

根因：Ctrl+V 在 keydown 阶段被 WASM 编码成 0x16 发往后端并 `preventDefault()`，浏览器 `paste` 事件永远不触发，已有 paste 监听器形同虚设。

修复：`isPasteShortcut`（mac：Cmd+V；其它平台：Ctrl+V / Ctrl+Shift+V；全平台 Shift+Insert）在 keydown 中直接放行（不编码、不 preventDefault），由浏览器派发 paste 事件，走原有 bracketed-paste 编码路径。冲突取舍与 VS Code / Windows Terminal 一致（vim 可视块可用 Ctrl+Q 替代）。

### 3. 选择复制 GUI（桌面 + 移动）

- `GhosttyTerminalController` 新增公开 API：`getSelection()` / `hasSelection()` / `clearSelection()` / `onSelectionChange(cb)`，及触摸选择 `startTouchSelection` / `updateTouchSelection` / `endTouchSelection`（与鼠标选择共用 `beginSelectionAt` / `updateSelectionDrag` 核心）。
- 新增 `apps/fe/src/components/terminal/SelectionToolbar.tsx`：选区存在时浮于终端顶部居中，含「复制 / 粘贴 / 取消选择」按钮（44px 级触控目标）；复制带 execCommand 回退（HTTP 部署可用），粘贴用 `navigator.clipboard.readText()`，失败弹 toast。
- `useMobileTouch.ts` 长按 500ms（12px 容差）进入按词选择，拖动扩展选区，松手后工具条可复制——同时给移动端提供了粘贴入口。
- i18n 新增 `terminal.copy/paste/copied/copyFailed/pasteFailed/clearSelection`（zh_CN / en_US / ja_JP），已跑 `bun run build:i18n` 重新生成。

## 测试

- `packages/ghostty-terminal` bun test：26 pass（新增 5 个用例：复制清选区后二次 Ctrl+C 直通、粘贴快捷键放行 + paste 事件流转、触摸选择 API 与 onSelectionChange、mac/非 mac 快捷键判定）。
- 前端 `tsc --noEmit` 与 `vite build` 通过。
- e2e（Playwright，新增）：
  - `terminal-clipboard.spec.ts`：粘贴快捷键入终端、Ctrl+C 中断前台进程、终端内 Ctrl+B 不切换侧栏 —— 全过。
  - `terminal-selection-canvas.spec.ts` 新增工具条用例（GUI 复制 + 快捷键复制清选区）—— 过。
  - `mobile-terminal-interactions.spec.ts` 新增长按选择 + 工具条复制用例 —— 过（移动端全套 6 项过）。

## 已知问题（与本次改动无关，已对照改动前代码验证）

- e2e 必须避开 9883/9663：本机有用户安装的 tmex 常驻服务（launchd）占用 9883，`reuseExistingServer` 会错误复用旧构建。本次用 `TMEX_E2E_FE_PORT=9885 TMEX_E2E_GATEWAY_PORT=9665` 运行。
- shell 中 `NODE_ENV=production` 会通过 playwright 透传给 vite dev，导致 React dev runtime 预打包成 production 版而白屏（`_jsxDEV is not a function`）。需 `env -u NODE_ENV` 运行 e2e。
- `terminal-selection-canvas` 的 autoscroll 用例在 vite dev 模式下稳定失败（新代码 101 / 旧代码 105，阈值 <100），"pane switch" 用例偶发失败——改动前代码同样如此，属 dev 模式时序问题。
- `terminal-mouse-recovery` 的 3 个 opencode 用例失败：本机 opencode 无法进入 alt screen（环境问题，断言发生在浏览器打开之前的 tmux 层）。

## 行为变化备注

- 复制后选区会被清除（原来保留）。
- 非 mac 平台 Ctrl+V 不再向终端发送 0x16，而是执行粘贴；kitty 协议应用同样收不到 Ctrl+V 键编码。
- mac 上有选区时 Ctrl+C 不再复制（改为发 SIGINT），复制请用 Cmd+C 或工具条。

## 追加调查：「输入锚点坏 / 内容不更新 / 页面卡住」反馈（2026-06-11）

按 systematic-debugging 复现排查，结论：**不是代码回归，是调试期间的本机环境污染**。

排查过程：

1. 在 e2e 环境逐步复现（键入回显 → Enter 执行 → 注入输出 → 二次键入），初次出现"输出冻结"假象，后证实是诊断脚本注入的 `term.write` / `buffer.setViewport` hook 自身造成的伪象——改动前代码加同样 hook 表现完全一致。
2. 无 hook 纯观察下，新代码在 vite dev 与 production 构建产物（vite preview + gateway）上键入、回显、内容更新、IME、选区、复制、粘贴、Ctrl+C 中断全部正常；核心 e2e 13/14 通过（唯一失败的 autoscroll 用例已用改动前代码对照证明是既有问题）。
3. 真正的环境根因（已全部清理）：
   - 调试 shell 携带 `NODE_ENV=production`，曾以此启动 vite dev 并重建 `apps/fe/node_modules/.vite` 预打包缓存——React `jsx-dev-runtime` 被打成 production 版，页面报 `_jsxDEV is not a function`，呈现"整页坏掉/卡住"。该坏缓存存在过一个时间窗口。
   - 期间在 9884/9885 遗留过坏的 dev server 进程。
   - 本机 9883 是用户系统安装的 tmex 常驻服务（launchd 守护），曾被误杀两次（已自动重启）。
4. 清理动作：杀掉全部遗留 dev/preview/gateway 进程；删除 `node_modules/.vite`（下次 dev 全新重建）；删除临时 spec 与文件。

若清理后仍能复现，需要提供：运行方式（dev / build / tmex-cli）、访问端口、浏览器 console 报错。

## 第二次调查：dev 启动导致新旧两个实例终端同时失效（2026-06-11）

用户补充的关键线索（dev 启动 → 生产实例同时坏；kill dev → 生产恢复）指向 tmux 层共享资源冲突，与前端无关。

### 根因（已实验证实）

gateway 订阅 pane 输出用 `tmux pipe-pane -O -t <pane> 'cat > <fifo>'`（`local-external-connection.ts:746`），**tmux 每个 pane 同时只允许一个 pipe，后执行者直接抢占**；会话事件用 `set-hook -t <session>`（同名 hook 直接覆盖）。因此**两个 gateway（常驻生产服务 + dev gateway）attach 同一个 tmux 会话时必然互相抢占输出管道**：后 attach 的一方拿走输出，另一方静默断流；任一方 resync 又会抢回，表现为两边交替/同时"输入无反应、内容不更新"。

用户的设备配置均指向日常会话 `tmex`（常驻服务库 `~/Library/Application Support/tmex/data/tmex.db`），dev 里创建同会话设备后即触发冲突。

### 实验证据

起两个独立 gateway（不同端口/数据库）+ 两个 production 前端，设备均指向同一测试会话：
- A 单独打开（B gateway 已运行并 attach）：A 输入无回显（pipe 在 B 手里）；
- B 页面完全正常（含本次改动的新前端构建——再次证明前端无回归）；
- 关闭 B 后 A 不会自动恢复（gateway 不感知 pipe 被抢/释放），与用户"生产恢复"略有差异（用户的生产服务因页面刷新/ws 重连触发了 re-pipe）。

### 结论与建议

- 本次前端改动与该问题无关；问题是 gateway 既有架构限制（多 gateway 共享同一 tmux 会话）。
- Workaround：dev 调试期间停掉常驻 tmex 服务，或 dev 中只用独立 tmux 会话（不要用日常的 `tmex` 会话）。
- 根治方向（需另立任务）：输出订阅从 pipe-pane 迁移到 tmux control mode（`tmux -C` 多客户端互不抢占）；过渡方案可在 attach/轮询时用 pane option 标记 pipe 归属，检测被抢后向前端报警（不建议自动抢回，会形成互抢循环）。
