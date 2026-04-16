# Plan 00 Result：ghostty mouse events

## 实施结果

- 已在 `packages/ghostty-terminal/src/terminal.canvas.test.ts` 补充模式路由测试，覆盖普通滚动、鼠标报告滚动、`alt-screen + alt-scroll` 滚动、优先级冲突，以及鼠标报告模式下拖拽不进入本地选择。
- 已在 `packages/ghostty-terminal/src/ghostty-wasm.ts` 增加鼠标相关封装，并提供可用于终端鼠标输入的 `encodeMouseEvent`。考虑到 wasm C ABI 对鼠标位置结构体传递在 JS 侧不可直接稳定复用，最终实现采用基于终端模式状态的 JS 侧编码逻辑，支持 SGR / URXVT / X10 路径，满足当前 vim/TUI 场景。
- 已在 `packages/ghostty-terminal/src/types.ts` 增加 `GhosttyViewportGesture` 和 `handleViewportGesture` 接口。
- 已在 `packages/ghostty-terminal/src/terminal.ts` 实现：
  - 鼠标报告模式下的按下、移动、释放转发；
  - wheel / touch 的统一路由；
  - `mouse reporting > alt-screen + alt-scroll > local scroll` 的优先级；
  - 普通模式下保留原有本地选择和历史滚动。
- 已在 `apps/fe/src/components/terminal/useMobileTouch.ts` 切换为优先调用终端的 `handleViewportGesture`，使触摸滚动与桌面 wheel 遵循同一套模式切换规则。

## 验证结果

### 单元测试

执行命令：

```bash
bun test "packages/ghostty-terminal"
```

结果：15 个测试全部通过。

### 构建验证

执行命令：

```bash
bun run build
```

结果：根仓库构建通过，前端与 tmex-cli 打包通过。

### 手工 smoke test

执行命令：

```bash
bun -e 'const { getGhosttyBindings } = await import("./packages/ghostty-terminal/src/ghostty-wasm.ts"); const { getGhosttyKeyCode, getUnshiftedCodepoint } = await import("./packages/ghostty-terminal/src/ghostty-keycodes.ts"); const bindings = await getGhosttyBindings(); const terminal = bindings.createTerminal(80, 24, 1000); const mouseEncoder = bindings.createMouseEncoder(); const keyEncoder = bindings.createKeyEncoder(); try { bindings.exports.ghostty_terminal_mode_set(terminal, 1000, 1); bindings.exports.ghostty_terminal_mode_set(terminal, 1006, 1); const mousePress = bindings.encodeMouseEvent(mouseEncoder, terminal, { action: "press", button: 1, mods: 0, x: 50, y: 40, anyButtonPressed: true, screenWidth: 800, screenHeight: 600, cellWidth: 10, cellHeight: 20 }); const mouseWheel = bindings.encodeMouseEvent(mouseEncoder, terminal, { action: "press", button: 5, mods: 0, x: 50, y: 40, anyButtonPressed: false, screenWidth: 800, screenHeight: 600, cellWidth: 10, cellHeight: 20 }); const arrowUp = bindings.encodeKeyEvent(keyEncoder, terminal, { action: "press", keyCode: getGhosttyKeyCode("ArrowUp"), mods: 0, composing: false, utf8: null, unshiftedCodepoint: getUnshiftedCodepoint("ArrowUp") }); console.log(JSON.stringify({ mousePress, mouseWheel, arrowUp })); } finally { bindings.freeMouseEncoder(mouseEncoder); bindings.freeKeyEncoder(keyEncoder); bindings.freeTerminal(terminal); }'
```

输出：

```json
{"mousePress":"\u001b[<0;6;3M","mouseWheel":"\u001b[<65;6;3M","arrowUp":"\u001b[A"}
```

说明：真实 wasm 环境下已经能输出 SGR 鼠标按下、滚轮，以及 alt-scroll 需要的方向键编码。

## 备注

- 本次未扩展触摸点按模拟点击，仅实现用户要求的触摸滚动兼容与模式切换。
- 当前结果已满足 opencode vim 这类启用鼠标报告的 TUI 所需的基础鼠标输入路径。
