# 实现计划：终端手机端键盘行为优化（issue #27）

设计详见 `docs/terminal/2026061501-mobile-keyboard-behavior.md`。

## 决策（已与用户确认）

- 命名：页面平移(`lift`) / 终端缩放(`resize`) / 光标对齐(`follow`)。
- 默认：`follow`（升级即修复空 shell bug）。
- 弹窗：底部 Sheet，全屏尺寸显示入口，大屏居中限宽。
- 三模式一次性全做，选中即点即生效（无保存按钮）。

## 任务清单

1. **i18n**：`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 加 `terminal.keyboardBehavior.*`，跑 `bun run build:i18n`。验证：`types.ts` 含新 key。
2. **store**：`apps/fe/src/stores/ui.ts` 加 `keyboardBehaviorMode` + setter + `partialize`，默认 `'follow'`。
3. **纯函数 + 单测**：`apps/fe/src/utils/virtualKeyboard.ts` 加 `computeCursorFollowOffset`；`virtualKeyboard.test.ts` 覆盖顶部/底部/中部/封顶/无光标边界。验证：`bun test` 绿。
4. **光标桥接**：新建 `apps/fe/src/utils/keyboard-cursor-bridge.ts`（register/read 单例）。
5. **ghostty 光标 API**：`packages/ghostty-terminal/src/types.ts` 加 `getCursorViewportRect?()`；`terminal.ts` 缓存 `lastCursor` + 实现 getter（聚焦判定 + 不泄漏 render state）。
6. **Terminal.tsx**：`instance` 就绪时注册 getter，卸载/切换注销（守卫只清自己）。
7. **避让 hook**：新建 `apps/fe/src/hooks/use-keyboard-avoidance.ts`，按 mode 返回 `{strategy, offset|height}`，follow 模式 RAF 轮询（仅键盘打开期间，offset 变化≥1px 才 setState）。
8. **MainInset**：`apps/fe/src/main.tsx` 消费新 hook，按 strategy 应用 transform/height，safe-area 填充联动。
9. **弹窗组件**：新建 `apps/fe/src/components/settings/keyboard-behavior-sheet.tsx`（底部 Sheet + 3 卡片，点选即 `setKeyboardBehaviorMode`）。
10. **入口按钮**：`DevicePage.tsx` `PageActions` 加 `Settings2` 按钮 + 渲染 Sheet。
11. **e2e**：扩展 `apps/fe/tests/mobile-keyboard-avoidance.spec.ts` 覆盖三模式 DOM 契约。
12. **收尾验证**：`biome check`、`tsc`、`bun test`、e2e；无头浏览器视觉自验（空 shell / 满屏 / 三模式截图）。

## 注意事项

- 生成文件（`resources.ts`/`types.ts`）不手改、不 lint。
- 不碰本机生产 tmex；验证起仓库内临时实例并显式覆盖 env。
- `resize` 会触发远端 resize，属设计取舍，不设为默认。
