## Prompt 00

- 用户要求：对于当前 ghostty-terminal 包的实现，新增鼠标事件功能，使 opencode vim 之类的应用可以正确响应鼠标事件。
- 额外约束：
  1. 触摸屏兼容。
  2. TUI 处理滚动时，要能和普通情况下用鼠标滚轮查看历史内容的行为正确切换。
- 实施目标：在 `packages/ghostty-terminal` 中补齐终端鼠标事件编码与分发能力，并与前端移动端触摸滚动保持兼容，使 TUI 启用鼠标报告后接管相应鼠标/滚动输入，未启用时仍保留终端历史滚动体验。

## 当前事实

- `packages/ghostty-terminal/src/terminal.ts` 当前仅支持键盘输入编码；`wheel` 事件始终映射为本地 `scrollLines`，`mousedown/mousemove/mouseup` 仅用于文本选择。
- `packages/ghostty-terminal/src/ghostty-wasm.ts` 已封装 key encoder、viewport scroll、mode 查询等能力，但尚未封装 mouse encoder / mouse event。
- `apps/fe/src/components/terminal/useMobileTouch.ts` 当前将触摸移动直接映射到 `terminal.scrollLines()`，没有区分 TUI 鼠标模式是否接管滚动。
- vendor 中已包含 Ghostty 官方 mouse encoder / mouse event C API 与 wasm 头文件，可作为本地优先参考实现来源。
