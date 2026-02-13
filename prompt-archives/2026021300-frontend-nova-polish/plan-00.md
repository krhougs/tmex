# Plan 00: Frontend Nova Polish + 功能补齐 + E2E

日期：2026-02-13

## 背景
- 当前分支已完成一次前端重构（shadcn/ui + Base UI，Tailwind v4，支持 dark mode，保留 iOS PWA safe-area 相关逻辑）。
- 用户反馈“功能不全 + UI 太丑”，并要求全局使用 Nova 主题与配色，忽略旧 UI 元素。

## 注意事项
- 运行时与脚本执行：优先 Bun；避免引入对 Node.js 运行时的依赖（Playwright 除外）。
- 禁止猜测：涉及 shadcn/Base UI 行为与配置时，以官方文档与依赖源码为准。
- 移动端/iOS PWA：必须保留 safe-area 与 visualViewport 相关处理，避免键盘/地址栏导致布局抖动。

## 目标
1. 补齐丢失的业务能力（已确认 Sidebar 缺失“删除设备”入口）。
2. 全局视觉对齐 Nova：主题 token 与字体基线对齐 Nova 预期，并清理旧 UI 兼容造成的样式偏差。
3. 恢复并重写系统性前端 E2E：覆盖 Devices / Device(terminal) / Settings 的核心路径。

## 任务清单
- 功能补齐
  - Sidebar：加入“删除设备”入口（带确认弹窗），删除后正确刷新设备列表，并在删除当前选中设备时导航回 `/devices`；同时确保断开 tmux 连接引用。

- Nova 主题与 UI 美化
  - 通过官方 `/init?template=vite&...` 验证当前 cssVars 是否为 base-nova 权威值；必要时同步主题变量。
  - 字体：切换为 Nova 预期字体（优先 `@shadcn/font-geist`），确保 `--font-sans` 与 import 一致。
  - 清理“旧 UI 兼容层”带来的视觉偏差：
    - 修正 `components/ui/index.tsx` 的 legacy Button variant 映射，使页面使用一致的 shadcn 变体（减少 outline 泛滥）。
    - 逐步把页面从 legacy API 迁移到标准 shadcn 组件 API（Select/Dialog/Buttons），避免长期维护成本。

- E2E 测试（Playwright）
  - 重新启用 `apps/fe` 的 `test:e2e` 脚本与依赖（`@playwright/test`）。
  - 新建 `apps/fe/tests/*`：
    - Devices：创建/编辑/删除设备（至少覆盖 local + ssh 的表单流程）。
    - Sidebar：设备树展开/连接、创建窗口按钮可点击（不要求真的连上 ssh，但要覆盖 UI 行为与请求）。
    - Settings：站点设置保存、主题切换、Telegram Bot CRUD（用 API stub 或最小真实后端流程）。

## 验收标准
- Sidebar 可删除设备，并且不会留下错误路由或残留连接。
- 全局字体与主题风格符合 Nova：视觉更紧凑，按钮/表单层级清晰。
- `bun run --filter @tmex/fe build` 通过。
- `bun run --filter @tmex/fe test:e2e` 可运行并稳定通过（至少 chromium）。

## 风险
- shadcn `create` CLI 当前对 `/init` 的请求缺失 `template` 参数会导致 400，需要绕过（直接调用 `/init?template=...` 或等待 upstream 修复）。
- Playwright 需要安装浏览器依赖与下载体积较大；CI 环境需确认缓存/安装策略。
