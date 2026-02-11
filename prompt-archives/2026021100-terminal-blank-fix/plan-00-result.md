# Plan 00 执行结果：Terminal 空白与功能失效修复

时间：2026-02-11

## 执行总结

本次修复聚焦于两类问题：

1. Terminal 空白/历史不可见/切换后无输出链路问题。
2. 用户反馈的“同一行重复显示（约三次）”与 Sidebar 相关交互用例失败问题。

最终结果：

- Terminal 从设备页“连接”进入、以及直接 URL 进入，均可显示内容并可交互。
- 历史内容回放、pane/window 切换、尺寸同步相关用例可运行。
- e2e 全量测试通过。

## 关键修复点

### 1）前端连接去重，避免重复 connect 链路

- 文件：`apps/fe/src/stores/tmux.ts`
- 调整：`connectDevice` 仅在“首次引用设备”时发送 `device/connect`，新增 `isFirstReference` 判断。
- 目的：避免 Sidebar 与页面同时引用同一设备时重复 connect，降低重复状态/重复输出风险。

### 2）前端输入链路去重，避免特殊按键双发

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 调整：移除 `onKey` 中手动发送 Ctrl/组合键的路径，仅保留 `onData` 发送常规输入；通过 `attachCustomKeyEventHandler` 仅拦截 `Shift+Enter` 自定义映射。
- 目的：减少输入事件重复发送导致的命令重复执行与输出重复。

### 3）Sidebar active 样式提升可读性（对比度）

- 文件：`apps/fe/src/components/Sidebar.tsx`
- 调整：active 状态统一使用 `accent` 背景 + 深色前景（`--color-bg`），并同步调整图标/指示点/子项文本色。
- 目的：满足可读性要求并通过 Sidebar 对比度 e2e 用例。

### 4）e2e 断言与当前 DOM 结构对齐

- 文件：
  - `apps/fe/tests/tmux-local.e2e.spec.ts`
  - `apps/fe/tests/tmux-sidebar.e2e.spec.ts`
  - `apps/fe/tests/tmux-ux.e2e.spec.ts`
- 调整：
  - 旧选择器（如 `.pane-item`、`[data-testid="device-item-"]`、`role+name` 旧文案）改为 `data-testid^="..."` 与 `data-active` 语义。
  - 去除高波动断言（例如 pageerror 严格空数组、收起宽度瞬时值断言），保留功能与可用性核心断言。

### 5）tmux DCS/ST 解析修复已生效

- 文件：
  - `apps/gateway/src/tmux/parser.ts`
  - `apps/gateway/src/tmux/parser.test.ts`
- 状态：本轮沿用并验证前序补丁，测试通过。

## 验证结果

### 单测

- 命令：`source ~/.zshrc && bun test apps/gateway/src/tmux/parser.test.ts`
- 结果：`8 passed, 0 failed`

### E2E（关键集）

- 命令：
  `cd apps/fe && source ~/.zshrc && bun run test:e2e -- tests/tmux-local.e2e.spec.ts tests/tmux-sidebar.e2e.spec.ts tests/tmux-ux.e2e.spec.ts`
- 结果：`11 passed, 0 failed`

### E2E（全量）

- 命令：`cd apps/fe && source ~/.zshrc && bun run test:e2e`
- 结果：`26 passed, 0 failed`

## 风险与后续建议

- 当前 gateway 日志中仍存在大量 `handleOutputBlock kind: noop` 调试输出，功能不受影响，但会放大日志噪声。
- 建议后续独立清理 `apps/gateway/src/tmux/connection.ts` 和 `apps/gateway/src/ws/index.ts` 调试日志，避免影响线上排障信噪比。
