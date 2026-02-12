# 计划：修复 iOS 键盘触发后的终端底部空白

## 背景

- 历史修复已处理：
  - `--tmex-viewport-height` 抖动（通过移除 `visualViewport.scroll` 对高度变量写入）。
  - 编辑器模式下 iOS 键盘贴底与地址栏 best-effort。
- 当前仍存在回归：在 iOS Safari/Chrome 中，无论 editor/direct 输入模式，只要触发键盘，终端下方会出现额外空白。

## 根因判断（基于现有实现）

- 根容器高度当前仅绑定 `--tmex-viewport-height = visualViewport.height`。
- iOS 键盘阶段常出现 `visualViewport.offsetTop > 0`（视觉视口相对布局视口下移）。
- 当容器从 `y=0` 开始且高度只等于 `visualViewport.height` 时，视觉视口底部会出现约 `offsetTop` 的空白区。
- 且当前 `--tmex-viewport-offset-top` 仅在 resize 时同步，无法覆盖 keyboard/focus 触发的 `visualViewport.scroll` 偏移变化。

## 目标

1. 消除 iOS 键盘触发后的终端底部空白（editor/direct 均生效）。
2. 不引入 `--tmex-viewport-height` 抖动回归。
3. 保持现有移动端交互与布局逻辑最小变更。

## 实施步骤

1. 调整 `RootLayout` 视口变量同步：
   - 保留高度变量的防抖阈值更新。
   - 新增 `visualViewport.scroll` 监听，仅同步 `--tmex-viewport-offset-top`（不在 scroll 路径写高度）。
2. 调整根容器高度计算：
   - 从 `var(--tmex-viewport-height)` 改为
     `calc(var(--tmex-viewport-height) + var(--tmex-viewport-offset-top))`。
3. 回归验证：
   - Type check：`bunx tsc -p apps/fe/tsconfig.json --noEmit`
   - E2E（最小集）：
     - `tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定"`

## 注意事项

- 参考旧分支/历史修复：`2026021205-viewport-height-jitter-fix`、`2026021206-mobile-editor-ios-ux`。
- 不修改后端协议，不改 tmux 交互语义。
- 仓库存在其他脏改动，本次仅修改与该 bug 强相关前端文件。

