# Prompt Archive

## 2026-06-14 初始请求

目标：开一个新的 worktree，然后 `ssh dns`，检查远端生产 tmex 为什么持续报错：

```text
error: can't find window: @0_0_bash_1
error: can't find window: @56_0_bash_1
```

用户强调：

- systemd 日志中有具体报错行号，需要重点参考。
- 需要关注 tmex 版本、tmux 版本、OS 版本相关行为。
- 需要多查文档。
- 先给出结论和修复方案。
- 不要动手实施修复。

项目约束：

- 使用 Bun.js，不默认使用 Node.js 调试项目脚本。
- 与用户沟通使用简体中文（中国大陆）。
- 严禁触碰本机生产环境 tmex、`~/Library/Application Support/tmex/` 及本机常驻服务。
- 本次只允许新建隔离 worktree、只读查看代码、只读访问远端日志和环境信息。

## 2026-06-14 复核请求（plan-01）

新开 worktree 后 `ssh dns`，复核生产 tmex 持续报错根因，关注各版本/tmux/OS 行为、多查文档，先给结论与修复方案、不动手。并对另一 Agent 给出的诊断报告（即 plan-00-result.md）做判断。

复核结论见 `plan-01-result-verified.md`：**否定** plan-00 的"服务端生成坏快照"论点，根因为入站 select-window 收到过期/外部客户端的复合目标串 + `selectWindow` 未传 `allowTargetMissing`。worktree：`../tmex-prod-tmux-window-debug-4`（分支 `debug/prod-tmux-window-2026061404`）。

## 2026-06-14 新证据修正（plan-02）

用户粘贴来自 opus 的新证据，要求不要再被前面的“旧客户端/前端跳转 effect”方向误导，需要按项目规范给出修复 plan。核心补充如下：

- 生产 systemd 环境是 `LANG=C`，而本地 snapshot 用 tmux format 字面 TAB 作为字段分隔：`#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}`。
- tmux 3.4 在非 UTF-8 locale 下，会把 format 输出里的字面 TAB 渲染为 `_`，实际输出 `@0_0_bash_1`，不是 `@0<TAB>0<TAB>bash<TAB>1`。
- `parseSnapshotWindows` 用 `line.split('\t')` 切不开，于是整行 `@0_0_bash_1` 进入 `window.id`；pane 的 `windowId` 仍是 `@0`，匹配不上，导致窗口下 `panes: []`。
- 坏 snapshot 经 borsh 下发，前端使用 snapshot 里的 `window.id`，再通过 `select-window` 回传，tmux 报 `can't find window: @0_0_bash_1`。
- dns 上已实测：同一条 `list-windows` 命令只换 locale，`LANG=C`/unset 输出下划线，`C.UTF-8`/`en_US.UTF-8` 输出正常 tab；`|` 分隔在 `LANG=C` 下不受影响。
- 手动 ssh 交互环境不复现，是因为交互 shell 继承 UTF-8 locale；复刻 gateway 进程环境 `LANG=C` 后可复现。
- WebSocket 只发 `HELLO+DEVICE_CONNECT` 抓到的原始 snapshot 字节已含真实下划线，且新建窗口 `_tmexprobe` 复现为 `@65_2__tmexprobe_0`，说明这是当前 0.8.2 活 bug，不是缓存。
- `buildLocalTmuxEnv` 现有 UTF-8 兜底只在 `LC_CTYPE`、`LC_ALL`、`LANG` 全缺失时生效；systemd 已有 `LANG=C`，兜底被跳过。
- 修复优先级：local 改 `|` 并复用/抽共享 `splitSnapshotFields`；ID 校验；解析失败不发半坏 snapshot；WS 入站校验；`selectWindow` target-missing benign；`runTmux` 日志补 argv/device/session；`buildLocalTmuxEnv` 强制 UTF-8。

## 2026-06-14 执行请求（main 直接修复）

用户要求：直接在 `main` 分支里进行修复，按照项目规范，善用 subagent。

执行约束：

- 当前工作树就是 `main`，不要新建 worktree。
- 先存档再干活，按 `plan-02.md` 做 TDD 修复。
- 严禁触碰本机生产 tmex 服务和安装目录。
- 用 subagent 做并行复核或独立风险检查；主实现保持串行，避免多个 agent 同时改同一批 gateway 文件。
