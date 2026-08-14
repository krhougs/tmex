# Configurable sidebar media query prompt

## 背景

Vibe X 原生移动端需要把所有横屏手机以及宽度至少 48rem 的平板视为 persistent-sidebar 布局，同时 PWA 与 tmex 自身继续使用现有 `(min-width: 48rem)` 断点。当前 `useIsMobile()` 把 media query 写死，`SidebarProvider` 无法由宿主配置。

本任务只为通用 UI provider 增加可选配置入口，不引入任何 Vibe X 平台标记、产品安全区或原生 App 概念。

## 需求

- `useIsMobile()` 支持调用方传入 desktop media query，并在 query 变化时重新订阅。
- `SidebarProvider` 增加可选 `desktopMediaQuery` prop。
- 未传参数时严格保持 `(min-width: 48rem)` 和现有 tmex/PWA 行为。
- 使用 Bun 运行验证；不触碰 tmex 生产服务、安装目录、9883 或名为 `tmex` 的 tmux session。
- commit message 使用中性开源语气。

