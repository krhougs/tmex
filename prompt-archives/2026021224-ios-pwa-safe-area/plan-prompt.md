# Prompt Archive

## 会话目标

修复 iOS Safari/Chrome 安装为 PWA（standalone）后，tmex 顶部可操作区域与刘海/状态栏重叠的问题。

## 关键上下文

- 已存在 `viewport-fit=cover` 与 iOS web app meta。
- 目前移动端顶栏在 `apps/fe/src/layouts/RootLayout.tsx` 使用固定 `h-11`，主内容使用 `pt-11`。
- 在 iOS standalone 下，顶部安全区需要额外补偿 `env(safe-area-inset-top)`，否则会被状态栏覆盖。
- 同步检查移动侧边栏头部是否也存在安全区覆盖风险。

## 当前轮用户输入（摘录）

- 「ios safari安装成PWA后正常操作区域和刘海状态栏重合」
- 「Implement the plan.」

## 注意事项

- 先存档，再干活。
- 保持 Bun 项目与现有样式体系一致，不引入无关改动。
- 优先做最小必要改动，避免影响桌面端布局。
