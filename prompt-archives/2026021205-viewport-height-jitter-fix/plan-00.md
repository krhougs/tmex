# 计划：跨浏览器 `--tmex-viewport-height` 抖动治理与视口同步重构

## 背景
- 当前前端根容器高度绑定 `--tmex-viewport-height`。
- 该变量在 `RootLayout` 中由 `window.resize`、`visualViewport.resize`、`visualViewport.scroll` 共同驱动。
- 在部分浏览器里，`visualViewport.scroll` 会高频触发并伴随 1px 级抖动，导致布局连续重排，出现底部/固定按钮抽搐。

## 目标
1. 消除静止场景下 `--tmex-viewport-height` 的高频抖动。
2. 保留移动端输入法弹出时的可视区适配能力。
3. 增加可回归的 E2E 断言，防止问题复发。

## 实施步骤
1. 重构 `RootLayout` 视口高度同步：
   - 移除 `visualViewport.scroll` 监听。
   - 使用 `requestAnimationFrame` 合并同帧更新。
   - 引入高度变更阈值（2px）抑制噪声。
   - 增加非法高度保护（非有限值或小于等于 0 时忽略）。
2. 保持 CSS 回退：继续保留 `:root` 中 `--tmex-viewport-height: 100dvh;`。
3. 按 TDD 增补 E2E：
   - 新增“Sidebar 折叠底部按钮位置稳定”测试，先观察失败，再实现修复后通过。
4. 运行验证命令：
   - `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "折叠 Sidebar 底部按钮"`
   - `bunx tsc -p apps/fe/tsconfig.json --noEmit`
   - `bun run --cwd apps/fe build`

## 注意事项
- 避免回退既有移动端输入法适配。
- 不变更协议、共享类型与后端行为。
- 仓库当前存在与本任务无关的脏文件，实施中保持不触碰。
