# Plan 00：ghostty mouse events

## 背景

`packages/ghostty-terminal` 当前已经完成 Ghostty wasm 终端渲染、键盘输入编码、前端画布渲染、文本选择和本地滚动等能力，但尚未把浏览器鼠标事件桥接成终端鼠标协议输入。因此，像 opencode vim 这类启用鼠标报告的 TUI 目前无法正确接收点击、拖拽和滚轮事件。

同时，移动端 `useMobileTouch.ts` 现在把触摸滑动直接映射为 `scrollLines()`，这会导致 TUI 接管滚动时仍然执行本地历史滚动，和桌面滚轮行为冲突。用户要求是在不做无关扩展的前提下，补齐鼠标事件支持，并保证触摸屏兼容，以及 TUI 接管滚动与普通查看历史滚动之间的正确切换。

## 注意事项

- 先归档，再干活。
- 不修改 `vendor/ghostty`。
- 只做当前需求：鼠标事件、触摸滚动兼容、滚动模式切换。
- v1 不做触摸点按模拟点击，不额外引入手势系统。
- 优先复用 Ghostty 官方 mouse encoder，不手写鼠标转义序列。

## 任务清单

1. 在 `packages/ghostty-terminal/src/terminal.canvas.test.ts` 先补失败测试，覆盖滚轮在普通模式、鼠标报告模式、alt-screen+alt-scroll 模式下的不同路由，以及鼠标按下在鼠标报告模式下不再进入本地选择。
2. 在 `packages/ghostty-terminal/src/ghostty-wasm.ts` 补齐 Ghostty mouse encoder / mouse event 的 wasm 绑定，并封装可复用的 `encodeMouseEvent` 能力。
3. 在 `packages/ghostty-terminal/src/types.ts` 增加供前端触摸钩子复用的视口手势类型与可选接口。
4. 在 `packages/ghostty-terminal/src/terminal.ts` 增加模式判断、鼠标编码发送、alt-scroll 路由，以及统一的 `handleViewportGesture` 入口；普通模式保持现有文本选择和本地历史滚动。
5. 在 `apps/fe/src/components/terminal/useMobileTouch.ts` 改为优先调用终端的 `handleViewportGesture`，让触摸滚动遵循与桌面滚轮一致的模式切换逻辑。
6. 如需要，在 `apps/fe/tests/mobile-terminal-interactions.spec.ts` 增加移动端模式切换回归测试；至少确保包级单测和必要的手工验证覆盖本次新增逻辑。
7. 跑 `lsp_diagnostics`、包级测试、必要的手工 smoke test，并归档结果。

## 验收标准

- 普通模式下，鼠标左键仍用于本地文本选择，滚轮仍用于本地历史滚动。
- 启用终端鼠标报告模式后，鼠标按键、移动、滚轮会转成 VT 鼠标输入发给 TUI，而不是触发本地选择或本地滚动。
- 启用 `alt-screen + alt-scroll` 且未启用鼠标报告时，滚轮和触摸滚动会转成应用方向键滚动，而不是本地历史滚动。
- 触摸滑动与桌面滚轮在模式切换上的行为一致。
- `ghostty-terminal` 新增改动通过相关测试与诊断检查。

## 风险评估

- Ghostty mouse encoder 依赖正确的像素坐标与 cell 尺寸，若几何参数不准确，TUI 中的点击位置会偏移。
- 鼠标报告、alt-scroll、普通本地滚动之间存在优先级，若判断顺序错误，会导致 Vim 之类程序行为异常。
- 触摸滚动沿用现有像素累计算法，若返回值语义不清晰，可能导致 `preventDefault` 时机异常，需要通过测试锁定。
