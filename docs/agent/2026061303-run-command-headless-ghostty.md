# run_command + 服务端 headless ghostty 终端工具

## 背景

agent 操作终端原本是「屏幕抓取」：`read_screen` 走 `tmux capture-pane` 只拿可见屏，`send_input` 只回 15 行尾部。长输出被截断、无命令完成边界、无退出码、读屏非流式。本次把 agent 终端工具改为**服务端 headless ghostty 渲染 + 实时字节流**驱动，并新增基于 OSC 133 的 `run_command`。

## 架构

### 1. OSC 133 解析（复用现有 stream parser）
`PaneStreamParser`（`apps/gateway/src/tmux-client/pane-stream-parser.ts`）已从 control-mode `%output` 抽 OSC 9/99/777/1337 并处理 tmux passthrough。新增 `case '133'` 解析 `A/B/C/D;<exit>`（含我们注入的 `tmex=<nonce>` 参数），经 `onPromptMarker` 沿 `control-mode-subscription → connection → DeviceSessionRuntime` listener 透传（与 `onTerminalOutput` 同链路）。注意：tmux 不支持 OSC 133 且 `capture-pane` 吃掉这些标记，所以只能从字节流拿。

### 2. Headless ghostty（服务端渲染）
`ghostty-vt.wasm`（`packages/ghostty-terminal`）本是前端 Canvas 渲染用，但其 `GhosttyBindings` 是 DOM-free 的、wasm 实例化只需 `{env:{log}}`、且有 formatter 出纯文本。新增 `packages/ghostty-terminal/src/headless.ts` 的 `HeadlessTerminal`（子路径导出 `ghostty-terminal/headless`）：`create/write/render(渲染态纯文本)/isAlternateScreen(DEC 1049)/size/resize/free`，在 Bun 里 headless 跑通。
wasm 资源改用 `new URL('./assets/ghostty-vt.wasm', import.meta.url)`（Vite 与 Bun 通用），替掉只有 Vite 能解析、`bun build` 报错的 `?url` 导入。

### 3. Per-pane 模拟器 + 防泄漏注册表
`apps/gateway/src/tmux-client/pane-emulator.ts`：`PaneEmulator` 把某 pane 的实时流喂进 headless ghostty 维护渲染网格，并提供 `render/isAlternateScreen/size` 和字节/标记 `tap`（run_command 用）。`PaneEmulatorRegistry` 镜像 `runtime-registry` 的引用计数：
- wasm bindings 全局单例；每 pane 一个 ghostty 句柄，按 `deviceId:paneId` **复用**，绝不每次 tool call 新建。
- 引用计数归零 / `destroy`（pane 关闭）/ `shutdownAll` → `free` ghostty + 解绑流订阅（幂等）。
- bounded scrollback（默认 5000）+ run_command 输出硬上限 + 池上限（LRU 驱逐空闲实例）。
`run.ts` 在 run 期间尽力 acquire（runtime 具备流订阅能力时）、finally release；stub runtime 无订阅则退回 capture-pane。

### 4. 工具（`apps/gateway/src/agent/tools/terminal.ts`）
- `read_screen`：emulator `render()` 出**渲染态**可见屏（含 TUI），带 `alternateScreen`；无 emulator 退回 capture-pane。
- `send_input`：模式感知——行模式回流式增量（tap 捕获发送后新字节）、TUI/alternate 回整屏重渲染；无 emulator 退回 15 行尾部。
- `get_pane_info`：尺寸/光标/当前命令（tmux）+ alternate（emulator）。
- `run_command`（新，`run-command.ts`）：三类目标判定链——
  - **POSIX**：注入隐形 OSC 133 + 一次性 nonce 包裹命令（退出码语法按 shell flavor：`$?`/fish `$status`），等带本 nonce 的 `;D` → 精确输出 + 退出码；无标记回退提示符/静默判定。
  - **CLI（网络设备）**：学提示符 → 提示符末尾重现判完成（无退出码）；`--More--` 自动续翻；错误串启发（`% Invalid input` 等）→ `likelyError`；可选 `disablePagingCommand`。
  - **TUI**：启动即/执行中切 alternate → `status=entered_tui` 交回交互式读写屏。
  - `expect` 命中早返回；硬超时返回已累积。输出剥 ANSI + 处理 `\r` 覆盖 + 剥命令回显，`wrapUntrusted` 标注，凭证消毒仍走出站 middleware。

### 5. 提示词
system-prompt 增段：agent 先探测环境（POSIX/网络 CLI/TUI），据此选 `run_command`（传 shell/mode/prompt）或交互式读写屏；说明 read_screen 是渲染态、send_input 模式感知、`entered_tui` 切交互。

## 验收
- gateway `bun test` 495 / shared 49 全绿（含：OSC 133 parser、HeadlessTerminal 真 wasm、emulator/registry 防泄漏、run_command 全分支 fake-emulator、工具 fallback、prompt 快照）。
- gateway `bun build --target bun` 通过；前端 `bun run build`（tsc + vite）通过且正确产出 `ghostty-vt-*.wasm` 资产。

## 已知follow-up
1. **生产打包 wasm**：`bun build` 后 `dist` 未含 `ghostty-vt.wasm`；bundled `import.meta.url` 相对解析指向 `dist/assets/ghostty-vt.wasm`，需在打包脚本把该 wasm 拷进 gateway 运行资源目录（或改为从已知资源路径加载）。dev（`bun run`）与测试已正常。
2. **端到端 integration**：真 tmux → control 流 → parser → emulator → run_command 的全链路 integration 测试（长输出不丢/退出码/vim 拒绝）建议补上；当前各层单测已分别覆盖（真 OSC 字节、真 ghostty wasm、run_command 全分支）。
