# 终端命令执行工具重构：服务端 headless ghostty + 流式工具 + OSC 133 run_command

## Context（背景与动机）

当前 agent 操作终端是「屏幕抓取」式：`read_screen` 走 `tmux capture-pane` 只拿当前可见屏；`send_input` 发完只回 15 行尾部、固定等 300ms。问题：

1. **长输出截断**：命令返回很多内容时，可见屏/15 行尾部装不下，超出 2000 行默认 scrollback 后永久丢失。
2. **无完成边界**：不知道命令何时跑完（慢命令拿到半截），也不知道输出从哪开始/到哪结束、退出码是多少。
3. **读屏非流式**：每次都是 capture 快照，不是基于实时字节流。

调研结论（Warp/OSC 133）：块式终端靠 **OSC 133 语义提示符标记**（`;A`提示符开始 `;B`命令开始 `;C`输出开始 `;D;<exit>`命令结束）划分命令块；Warp 通过 shell 集成发这些标记，但非 bash/zsh 与网络设备会退化/失败。关键硬约束：**tmux 不支持 OSC 133 且 `capture-pane` 吃掉这些标记**——要拿 OSC 133 必须读**原始字节流**（control-mode `%output`），而本项目已有 `PaneStreamParser` 在从该流里抽 OSC 9/99/777/1337 并处理 tmux passthrough。

目标：把 agent 终端工具改成**服务端 headless ghostty 渲染 + 实时流**驱动，新增基于 OSC 133 的 `run_command`，并让 prompt 引导 agent 自己探测环境、在 `run_command` 与交互式读写屏间选择。

## 已确认决策

- **读屏数据源**：服务端 **headless ghostty**（复用 `packages/ghostty-terminal` 的 `GhosttyBindings`，per-pane 无头终端，喂实时流，`formatViewport` 出渲染态文本，连 vim/less/设备分页等 TUI 都准）。
- **推进方式**：一次性整套（OSC 133 + headless ghostty 子系统 + 工具改造 + 提示词）。
- **完成判定（A+B 混合，优先 OSC 133）**：POSIX → 每命令注入**隐形 OSC 133 标记**（`printf '\e]133;C\e\\'; cmd; printf '\e]133;D;%d\e\\' $?`，不改 shell 配置、穿透嵌套 ssh），从流里解析边界+退出码；可见 sentinel 作 POSIX 退路；非 POSIX/网络设备 → 提示符正则 + 输出静默判定（无退出码）；TUI/alternate 屏 → 拒绝 run_command，提示改用交互式读写屏。
- **硬约束：资源复用 + 防内存泄漏**（见 §5，一等设计目标）。

## 设计

### 1. OSC 133 解析（复用现有 stream parser）
- `apps/gateway/src/tmux-client/pane-stream-parser.ts`：`emitOsc()` 加 `case '133'`，解析子命令 `A/B/C/D;<exit>`，经新回调 `onPromptMarker({ kind, exitCode? })` 上抛（与现有 `onNotification` 同链路：control-mode-subscription → connection → DeviceSessionRuntime listener）。OSC 已被 parser 从输出中剥离，不污染文本。
- 验证 OSC 133 是否需要 `set -g allow-passthrough on`（会话已在 `ensureSession` 设若干 option，必要时补一条）。

### 2. Headless ghostty 模拟器（gateway）
- `packages/ghostty-terminal`：新增 headless 导出（`getGhosttyBindings`/`GhosttyBindings`/formatter 常量），或加一个不依赖 DOM 的 `HeadlessTerminal` 包装（`createTerminal(cols,rows,scrollback)` + `writeVt(bytes)` + `formatViewport→plain text` + 模式/光标/尺寸读取）。`GhosttyBindings` 已是 DOM-free、wasm 实例化只需 `{env:{log}}`、且 `loadGhosttyWasmBytes` 已有 `Bun.file` 分支。
- wasm 加载：`?url` 导入在 Bun 运行时可能不解析（前端靠 Vite）；headless 包装改用 `import.meta`/绝对路径定位 `assets/ghostty-vt.wasm`。**首步 spike 验证**（见 §6）。
- `apps/gateway/src/tmux-client/headless-terminal-registry.ts`：**镜像 `runtime-registry.ts` 的引用计数模式**，按 `deviceId:paneId` 复用 emulator；`acquire` 创建（seed 历史 + 订阅流），`release` 计数归零即销毁。
- emulator 初始化：先 `capturePaneText`/`capturePaneHistory` 取当前屏 + 历史喂入 ghostty 做 seed，再订阅 `onTerminalOutput` 实时增量；监听 pane resize（snapshot width/height 变化）同步 `resizeTerminal`，否则渲染错位。

### 3. 流与标记接到工具层
- `TerminalRuntimeLike`（`agent/tools/terminal.ts`）扩展：拿到/创建该 pane 的 headless emulator 句柄 + 订阅 prompt markers。emulator 由 §2 注册表提供，工具层只读快照/区间。
- 复用 `DeviceSessionRuntime.subscribe`（已广播 onTerminalOutput）+ 新增 onPromptMarker 透传。

### 4a. 交互式工具（模式感知，数据源切到 emulator/流）
- `read_screen`：从 emulator `formatViewport` 取**渲染态**可见屏（+ 可选 scrollback 行），不再 capture-pane；alternate 屏时即 TUI 的真实画面。
- `get_pane_info`：尺寸/光标/`alternateScreen`（`ghostty_terminal_mode_get` 1049/1047/47）/当前命令。
- `send_input`：**模式感知返回**——普通行模式回**流式增量**（自发送时刻起的新行，不再 15 行尾部截断）；alternate/TUI 模式回**整屏重渲染**（TUI 是重绘，无追加行概念）。
- 保留 watch 的 `capturePaneText`（watch service 不动）。

### 4b. `run_command`（新，三类目标的具体判定与回退）
参数：`command`、`mode: auto|posix|cli`、`shell?`（bash/zsh/sh/fish/powershell，定退出码语法）、`prompt?`（cli 提示符正则）、`expect?`（命中即早返回，应对密码/`[y/N]`）、`timeout_ms`、`disable_paging?`。
返回：`{ output(剥转义+wrapUntrusted), exitCode|null, status, likelyError?, errorLine?, truncated }`，`status ∈ completed|timeout|entered_tui|expect_matched|paused_pager`。凭证消毒走出站 middleware。

判定链（每次调用）：
1. 启动即 alternate 屏 → `entered_tui`，提示改用交互式读写屏。
2. **POSIX**：注入隐形 OSC 133 + 一次性 nonce 包裹命令（`printf '\e]133;D;<exit>;<nonce>\e\\'`，退出码语法按 shell flavor），从流等带本 nonce 的 `;D` → 精确输出区间 + 退出码。探测窗口内无标记 → 回退提示符/静默判定（无退出码）。
3. **CLI（网络设备）**：先学提示符（发送时刻最后一行非空，或 `prompt`）；可选先发关分页命令（cisco `terminal length 0` / 华为 `screen-length 0 temporary` / junos `set cli screen-length 0` / mikrotik，emulator 内只发一次）；**完成 = 提示符在末尾重现**；流里遇 `--More--`/`---(more)---` 自动发空格续翻并剥标记；错误启发（`% Invalid input`/`% Ambiguous`/行首 `^`/`syntax error`）→ `likelyError`。
4. 执行中屏幕切 alternate（DEC mode 检出）→ `entered_tui` 早返回交回控制。
5. `expect` 命中 → `expect_matched` 早返回。
6. 硬超时 → 返回已累积 + `timeout`（agent 可用 `send_input` 发 ctrl-c）。

判定信号全部取自 ghostty/流（capture 拿不到）：alternate=DEC mode；POSIX 完成=带 nonce 的 OSC `;D`；CLI 完成=提示符重现；分页=`--More--`/alternate；错误=平台错误串。

### 5. 资源复用 / 防内存泄漏（一等约束）
- **单例 wasm bindings**（`getGhosttyBindings` 已 memoize），per-pane 仅一个 `ghostty_terminal_new` 句柄；句柄按 `deviceId:paneId` 在注册表内**复用**，绝不每次 tool call 新建。
- **显式 free**：emulator 销毁时 `ghostty_terminal_free` + render state/iterator/formatter 全部释放（bindings 内 per-call 结构已 `finally` free，新增用法同样 finally）；WASM 线性内存只增不减 → **bounded scrollback**（如 5000 行）+ **池上限 + LRU/idle 驱逐**控制高水位；必要时降级为「每 pane 独立 wasm 实例」以便整体回收（备选）。
- **生命周期挂钩**：pane 关闭（snapshot 不含该 pane）、runtime `onClose`、agent session 停止、进程 shutdown（`shutdownAll`）均触发销毁 + **解绑流订阅**（保存 unsubscribe，幂等）。
- **idle 驱逐**：一段时间无工具使用的 emulator 自动 free。
- 单测覆盖：反复 acquire/release 不泄漏句柄；pane 关闭/进程退出全清；订阅解绑。

### 6. 提示词改造
- system-prompt 增/改段，让 agent **先探测环境再选工具**：
  - 探测：`uname`/`ver`/`show version`、提示符形态、是否 alternate 屏，判定 POSIX(shell flavor) / 网络设备 CLI / TUI。
  - POSIX 批量命令 → `run_command`（传 `shell` flavor，拿完整输出+退出码）。
  - 网络设备 → `run_command` `mode=cli`（传/让其学 `prompt`，默认关分页），知晓无退出码、看 `likelyError`。
  - TUI/交互式（vim/less/top/menuconfig）→ 不用 run_command；用 `read_screen`（渲染态整屏）+ `send_input`（发按键、回整屏）；`get_pane_info.alternateScreen` 确认在 TUI 内。
  - 说明 read_screen 现在是渲染态、send_input 行模式回增量/TUI 模式回整屏；run_command 返回 `entered_tui` 时切到交互。

## 关键文件
- 改：`apps/gateway/src/tmux-client/pane-stream-parser.ts`（OSC 133）、`control-mode-subscription.ts` / `local-external-connection.ts` / `ssh-external-connection.ts` / `device-session-runtime.ts`（onPromptMarker 透传）
- 新增：`packages/ghostty-terminal` headless 导出 / `HeadlessTerminal` 包装
- 新增：`apps/gateway/src/tmux-client/headless-terminal-registry.ts`（镜像 `runtime-registry.ts`）
- 改：`apps/gateway/src/agent/tools/terminal.ts`（四个工具切到 emulator/流 + 新 run_command）、`run.ts`（接线 + 生命周期）
- 改：`apps/gateway/src/agent/prompts/system-prompt.tsx`（工具选择/环境探测段）

## 验收标准
1. **Spike 先行**：bun 里 headless 实例化 `ghostty-vt.wasm`、`writeVt` 后 `formatViewport` 出正确文本——验证 wasm 在 Bun 可跑、`?url`/路径加载方案可行。
2. 临时 socket integration（参考 `local-external-connection.integration.test.ts` 的 `-L`）：长输出命令经 `run_command` 拿到**完整**输出（>2000 行不丢）+ 正确退出码；vim 等 alternate 屏被拒；`read_screen` 渲染态与真实一致。
3. OSC 133 解析单测（A/B/C/D;exit + passthrough 包裹）。
4. 内存/生命周期单测：反复 acquire/release、pane 关闭、shutdownAll 后无残留句柄/订阅。
5. `bun test`（gateway + shared）全绿；`bun build --target bun` 通过；前端 `tsc` 通过。
6. **不碰生产 tmex**（9883 / 安装目录）；验证一律仓库内临时实例 + 临时 socket。

## 风险与注意
- **wasm in Bun**：`?url` 加载、`WebAssembly.instantiate` 在 Bun 行为、formatter 结构体 ABI——首步 spike 必须验证，不通过则回退「轻量 VT 行缓冲」方案（read 屏 TUI 精度降级）。
- **内存**：WASM 内存只增不减——scrollback 上限 + 池上限 + 驱逐是硬要求；监控高水位。
- **OSC 133 出流**：确认 `%output` 携带 OSC 133（必要时开 `allow-passthrough`）；嵌套 ssh 下隐形标记需目标 shell 能执行 `printf '\e]...'`。
- **seed 时序**：emulator 须先喂历史再接增量，避免 attach 后读到空屏。
- **范围**：体量大、回归面广（终端工具全改 + 新子系统）；严格 TDD + 临时实例实测。

## 执行前置（按 AGENTS.md）
- **先存档再干活**：`prompt-archives/` 建新文件夹（如 `2026061303-run-command-headless-ghostty`），存 `plan-prompt.md` + `plan-00.md`，完成后补 `plan-00-result.md`。
- 先 spike（§6.1）验证 headless ghostty 可行，再按 §1→§5 实现，最后 §6 提示词；TDD 优先写失败测试。
