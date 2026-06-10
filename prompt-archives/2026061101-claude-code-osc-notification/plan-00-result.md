# 执行结果：Claude Code OSC 通知支持

## 根因（已实证）

从 Claude Code 2.1.170 二进制内嵌源码逆向确认（详见 plan-00.md）：

1. **主因**：Claude Code 在 tmux 内（`$TMUX` 存在）把所有通知序列用 tmux passthrough 包装（`ESC Ptmux; <内层，ESC 翻倍> ESC \`），tmex 的 `pane-stream-parser` 不解析 DCS，`ESC P` 直接原样透传——内层 OSC 9/777/99 永远不会被识别。
2. kitty 渠道使用 OSC 99（三段分片按 `i=<id>` 聚合），parser 白名单不含 99。
3. parser 既有 bug：`osc-st` 阶段遇 `ESC + 非 \` 时 phase 不回 `osc-body`。
4. 行为说明（非代码问题）：`preferredNotifChannel: auto`（默认）在 tmex 终端内探测不到 iTerm/kitty/ghostty，Claude Code 直接 `no_method_available` 不发任何序列。用户必须显式设置渠道（推荐 `iterm2`）。

## 修改

- `apps/gateway/src/tmux-client/pane-stream-parser.ts`：
  - 主循环重构为 `processByte`；新增 `dcs-detect` / `dcs-tmux` / `dcs-tmux-esc` / `dcs-tmux-ignore(-esc)` 阶段，解包 `ESC Ptmux;` passthrough 并将解码内容重新喂回状态机；非 `tmux;` 前缀 DCS 原样透传；payload 上限 64KB。
  - OSC 白名单加 `99`，按 kitty 协议解析 metadata（`i`/`d`/`p`），按 id 聚合 title/body，`d≠0` 时上报；pending 上限 16 个 id。
  - 修复 `osc-st` 状态机 bug。
- `packages/shared/src/index.ts`：`NotificationSource` 加 `'osc99'`。
- `packages/shared/src/ws-borsh/convert.ts`：u8 映射加 `osc99: 4`。
- `apps/gateway/src/ws/index.ts`：source 白名单加 `osc99`。
- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`：source 枚举补 4=osc99。
- 新文档 `docs/terminal/2026061101-claude-code-osc-notification.md`：根因、渠道对照表、**用户必须设置 `preferredNotifChannel`（auto 在 tmex 中不生效）**、验证命令。

## 验证

- parser 单测新增 5 个用例（passthrough 包装 OSC 9（BEL 终结）、跨 push 的 passthrough OSC 777（ST 终结）、OSC 99 三段聚合、非 tmux DCS 原样透传、osc-st bug 回归）：15 pass。
- `bun run --filter @tmex/gateway test`：133 pass；`@tmex/shared test`：36 pass。
- 前端 `bun run build`（含 shared 类型变更的 tsc）通过。
- 真实链路 e2e（gateway + vite preview + playwright）：tmux pane 内 printf 模拟 Claude Code 的包装序列，OSC 9 与 OSC 99 通知均弹出浏览器 toast，序列字节不泄漏到终端文本。
- biome 对改动文件检查通过（生成文件未触碰）。

## 备注

- Claude Code 各渠道实际序列（逆向自二进制）：iterm2=`OSC 9;<msg>BEL`、ghostty=`OSC 777;notify;<title>;<body>BEL`、kitty=`OSC 99` 三段（`i=<id>:d=0:p=title`、`i=<id>:p=body`、`i=<id>:d=1:a=focus`），全部经 `X0()` 做 tmux passthrough 包装。
- screen（非 tmux）形式的 `ESC P <内容> ESC \` 包装未支持——tmex 受管 pane 必在 tmux 内，不会走该分支。

## 追加：auto 渠道自动识别为 ghostty（2026-06-11 后续需求）

### 探索结论

- Claude Code 终端检测函数（逆向 2.1.170 还原）的优先级中，`TERM === "xterm-ghostty"` 高于 `TERM_PROGRAM` 与 `TMUX`。
- 实测 tmux 3.4：派生 pane 进程时强制覆盖 `TERM_PROGRAM=tmux`，会话环境变量（`set-environment`）无法覆盖 → 该路径在 tmux 3.2+ 无效（仅对老 tmux 保留）。
- 唯一可行注入点：tmux `default-terminal xterm-ghostty`（server 级选项）。前提是宿主有 `xterm-ghostty` terminfo，否则 ncurses 程序会坏。

### 实现

- 新增 `apps/gateway/src/tmux-client/ghostty-terminfo.ts`：内置 `xterm-ghostty` terminfo 源（`infocmp -x` 自 Ghostty 官方 terminfo 导出，MIT），`buildEnsureGhosttyTerminfoScript()` 生成"infocmp 检测 → 缺失则 tic -x heredoc 安装 → 复检"的 sh 脚本。
- `config.ts` 新增 `TMEX_TMUX_TERM_PROGRAM`（默认 `ghostty`，`off` 关闭）。
- local / ssh 两个 connection 的 `configureSessionOptions`：`set-environment TERM_PROGRAM`（老 tmux 路径）＋ terminfo 保障成功后 `set-option default-terminal xterm-ghostty`。local 经可注入的 `deps.ensureGhosttyTerminfo`（测试友好），ssh 经远端 shell 执行同一脚本（远端也自动装 terminfo）。
- README 环境变量表与 `docs/terminal/2026061101-claude-code-osc-notification.md` 已更新（含 server 级选项影响面、已存在 shell 不生效、off 开关说明）。

### 验证

- gateway 全量 bun test 133 pass（local configure 测试覆盖 default-terminal 路径，其余测试注入 stub）。
- 端到端实测（全新环境，先删除 `~/.terminfo` 条目）：gateway 接管会话后 terminfo 自动安装、`default-terminal=xterm-ghostty` 生效、新 window 内 `TERM=xterm-ghostty`（`TERM_PROGRAM` 仍被 tmux 覆盖为 tmux，但检测优先级使其无关）。
- 验证后已恢复本机 tmux server 的 `default-terminal=tmux-256color`（避免在用户部署新版前留下副作用）；自动安装的 `~/.terminfo` 条目保留（无害）。

### 注意事项

- `default-terminal` 是 tmux server 级选项：tmex 接管任一会话即影响该 server 上所有会话的新 pane TERM。terminfo 已被保障安装，ncurses 程序不会坏；在真 iTerm 等终端 attach 时，ghostty terminfo 声明的现代能力（kitty 键盘协议等）可能超出宿主实际支持，属可接受偏差。
- 已存在的 shell/进程环境不变，用户需新开 pane 或重启 shell 才能让 Claude Code auto 生效。
