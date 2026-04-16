# Ghostty Wasm 终端运行机制说明

## 背景

WebUI 终端底座已从原先的 xterm 直连实现切换为 Ghostty wasm 兼容层。当前方案并不是在浏览器中运行一个完整的 Ghostty 应用，而是将 Ghostty 的 VT 内核编译为 wasm，在前端中承担终端状态维护、VT 输出解析、格式化渲染、键盘编码和粘贴编码等职责。

后端的 tmux 会话、pane 管理、WebSocket 协议、设备连接与数据转发仍由 gateway 和 ws-borsh 链路负责。Ghostty wasm 只负责浏览器侧的“终端语义执行”。

## 目标

- 在不改动页面层主要 contract 的前提下替换终端底座。
- 保留现有 `TerminalRef`、resize hook、选择状态机和 E2E 调试入口。
- 通过独立 workspace 包隔离 Ghostty wasm 细节，避免 `apps/fe` 直接依赖底层导出。

## 整体结构

当前关键层次如下：

1. `apps/fe`
   - 页面层、状态管理、ws-borsh 事件分发。
   - 通过 `ghostty-terminal` 使用终端控制器。
2. `packages/ghostty-terminal`
   - Ghostty wasm 加载器。
   - C API 封装和结构体读写。
   - 终端控制器、输入事件桥接、HTML 渲染和兼容 buffer。
   - 包内提交 `ghostty-vt.wasm` 与对应 metadata，由维护脚本手动更新。
3. `vendor/ghostty`
   - Ghostty 官方源码 submodule。
   - 锁定版本由 superproject gitlink 决定，包内 metadata 会镜像当前锁定 commit。

## 运行时职责分配

### 后端负责什么

- tmux 会话和 pane 的真实生命周期。
- 终端输出收集、输入转发和设备连接管理。
- `TERM_HISTORY`、`TERM_OUTPUT`、`TERM_RESIZE`、`TERM_SYNC_SIZE` 等 ws-borsh 协议事件。

### Ghostty wasm 负责什么

- 解析从后端收到的 VT 字节流。
- 维护屏幕内容、scrollback、viewport 和终端 mode。
- 按当前终端状态生成 HTML 和 plain text。
- 把浏览器键盘事件编码成终端输入字节序列。
- 按终端 mode 对粘贴文本做 bracketed paste 编码。

### React 终端组件负责什么

- 创建和销毁终端控制器实例。
- 将 ws-borsh 的历史输出和实时输出喂给 Ghostty。
- 将 Ghostty 编码后的输入重新发回 gateway。
- 协调主题、输入模式、尺寸同步、移动端交互和 E2E 探针。

## 初始化链路

入口在 `apps/fe/src/components/terminal/Terminal.tsx`。

组件挂载后会调用 `createTerminalController(...)`，创建过程位于 `packages/ghostty-terminal/src/terminal.ts`：

1. 调用 `getGhosttyBindings()` 加载 `ghostty-vt.wasm`。
2. 通过 `ghostty_type_json()` 读取 wasm 导出的类型布局信息。
3. 创建以下核心句柄：
   - `terminalHandle`：终端状态实例。
   - `keyEncoderHandle`：键盘编码器。
   - `htmlFormatterHandle`：HTML 格式化器。
   - `plainFormatterHandle`：纯文本格式化器。
4. 创建 `.xterm` 风格 DOM、隐藏 `textarea`、渲染容器和兼容 buffer。
5. 将实例挂到 `window.__tmexE2eXterm`、`window.__tmexE2eTerminal`、`window.__tmexE2eTerminalEngine`，供 E2E 使用。

其中，wasm 只会按模块级 Promise 懒加载一次，避免严格模式和多终端实例重复初始化。

## wasm 资产维护约束

- 运行时只读取 `packages/ghostty-terminal/src/assets/ghostty-vt.wasm`。
- 对应的版本信息记录在 `packages/ghostty-terminal/src/assets/ghostty-vt.meta.json`。
- 手动维护入口：`bun run --filter ghostty-terminal update:wasm`
  - 从当前锁定的 `vendor/ghostty` submodule 编译 wasm。
  - 覆盖包内 `ghostty-vt.wasm`。
  - 同步写回 metadata（锁定 commit、sha256、文件大小）。
- 自动化入口：`bun run --filter ghostty-terminal verify:wasm`
  - 只校验 wasm 与 metadata 存在。
  - 只校验 metadata 中记录的 commit 是否与当前锁定的 `vendor/ghostty` gitlink 一致。
  - 不触发任何编译。

这意味着自动化流程遵循“never build, only verify”，避免在测试、构建或 CI 中拉起 Zig / Ghostty 编译链。

## 输出链路

后端输出进入浏览器后的执行路径如下：

1. ws-borsh 状态机回调 `onApplyHistory`、`onFlushBuffer`、`onOutput` 被触发。
2. `Terminal.tsx` 对换行做最小归一化，主要是把裸 `\n` 补成 `\r\n`，避免列位置异常。
3. 调用终端实例的 `write(...)`。
4. `GhosttyTerminalController.write(...)` 内部调用 `ghostty_terminal_vt_write(...)`。
5. Ghostty 更新内部终端状态后，控制器在下一帧触发 `render()`。
6. `render()` 同时读取：
   - HTML formatter 输出，用于更新 `.xterm-screen.innerHTML`；
   - plain formatter 输出，用于更新兼容 buffer；
   - scrollbar 数据，用于同步 viewport/baseY/length。

因此，当前页面上看到的终端内容，本质上是 Ghostty 维护的终端状态经过 formatter 输出后的结果，而不是前端自己解释 ANSI 序列后逐格绘制。

## 输入链路

输入仍然通过浏览器事件进入，但编码职责已经切到 Ghostty：

1. 控制器在 `open()` 时创建一个隐藏 `textarea` 作为输入焦点承载。
2. `keydown` / `keyup` 事件进入 `encodeKeyboardEvent(...)`。
3. 该函数将浏览器事件转换为 Ghostty 需要的：
   - key code
   - modifier mask
   - composing 状态
   - 可选 UTF-8 字符
   - 可选 unshifted codepoint
4. 调用 `ghostty_key_encoder_encode(...)` 得到终端输入字节流。
5. 控制器通过 `onData(...)` 把编码结果抛回 React 组件。
6. `Terminal.tsx` 再调用 `sendInput(...)` 发给后端。

粘贴文本则通过 `ghostty_paste_encode(...)` 处理。若终端启用了 bracketed paste mode，则 Ghostty 会自动输出带包裹序列的内容。

## IME 与移动端输入

当前实现保留了一个最小、可测的 IME 处理策略：

- `compositionstart` 标记进入 composing 状态。
- `compositionend` 仅在事件本身携带最终文本时发送输入。
- 取消组合输入时不发送 fallback 文本。
- 非 composing 的 `beforeinput` 直接作为普通文本输入发送。

这样可以满足当前移动端 E2E 的直接输入、IME 提交、取消组合输入和粘贴行为约束。

## 尺寸同步链路

尺寸同步仍由 `useTerminalResize` 管理，Ghostty 控制器只提供测量和 `resize(...)` 能力：

1. `FitAddon.proposeDimensions()` 或容器尺寸回退逻辑计算目标 `cols/rows`。
2. `useTerminalResize` 根据场景决定发 `resize` 还是 `sync`。
3. 调用终端实例的 `resize(cols, rows)`。
4. 控制器内部执行 `ghostty_terminal_resize(...)`。
5. 新尺寸继续通过 ws-borsh 协议与后端 pane 尺寸收敛。

这里保留了与旧实现接近的接口形状，因此页面层和现有 resize 测试不需要大面积改写。

## 为什么还保留 `.xterm` 风格接口

虽然底层不再使用 xterm，但兼容层仍保留了以下表面形状：

- `.xterm`、`.xterm-screen`、`.xterm-helper-textarea` 等 DOM 类名；
- `buffer.active.baseY / viewportY / length / getLine()`；
- `_core._renderService.dimensions.css.cell`；
- `FitAddon`；
- `__tmexE2eXterm` 调试对象。

这样做的目的不是继续依赖 xterm，而是降低页面层、移动端交互逻辑和既有 E2E 的迁移成本。

## 关键文件

- `packages/ghostty-terminal/src/ghostty-wasm.ts`
  - Ghostty wasm 导出封装、结构体布局读写、formatter/key/paste 调用。
- `packages/ghostty-terminal/src/terminal.ts`
  - 终端控制器、DOM 适配、输入事件桥接、渲染和兼容 buffer。
- `apps/fe/src/components/terminal/Terminal.tsx`
  - 与 ws-borsh、主题、输入模式、resize hook 和页面层 contract 的连接点。
- `apps/fe/src/components/terminal/useTerminalResize.ts`
  - 容器测量、sync/resize 防抖和尺寸上报策略。

## 当前边界

- 当前只覆盖 tmex 真实使用到的能力，不追求完整 xterm API 等价。
- 渲染使用 Ghostty formatter 输出的 HTML，不是逐 cell canvas 或自绘 renderer。
- 鼠标协议、复杂选择语义和更多终端 effect 仍可继续扩展，但不在本轮迁移的最小范围内。

## 结论

当前 Ghostty 在 WebUI 中的实际角色是“浏览器内的终端解释与编码内核”。它取代了原先 xterm 在终端语义层的职责，但没有接管 tmux 会话管理、ws 协议或页面级状态流。整个方案的核心价值在于：

- 终端语义由官方 Ghostty VT 内核提供；
- 页面层继续沿用原有 contract；
- wasm 细节被封装在独立包中，便于后续维护和升级。
