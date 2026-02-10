# Plan-00 执行结果：浏览器端 tmux e2e（Playwright）

## 结果概述

- 新增 Playwright e2e 用例，覆盖：登录 → 添加本地设备 → 连接本地 tmux → 创建窗口 → 切换窗口 → split → 切换 pane → 删除窗口。
- 修复 e2e 运行的关键前置问题：
  - 设备添加对话框补齐 `label htmlFor` + 输入控件 `id`，让 `getByLabel()` 在真实浏览器中稳定可用。
  - Playwright `webServer` 启动 gateway 的命令改为 Bun 入口，并提供合法的 `TMEX_MASTER_KEY`（32 bytes base64）。

## 关键改动

- `apps/fe/playwright.config.ts`
  - `webServer[0].command` 改为 `bun apps/gateway/src/index.ts`。
  - `TMEX_MASTER_KEY` 改为 `.env.example` 中的 32 bytes base64 示例值，避免 Web Crypto `importKey` 失败。
  - 增加 `bun` 可执行文件自动探测：优先 `TMEX_E2E_BUN`，否则尝试 `$HOME/.bun/bin/bun`。

- `apps/fe/src/pages/DevicesPage.tsx`
  - `AddDeviceDialog` 的字段增加固定 `id`，并将 `label` 绑定到 `htmlFor`，提升可访问性与测试稳定性。

- `apps/fe/src/main.tsx`
  - 调整路由：将 `devices/:deviceId/windows/:windowId/panes/:paneId` 作为独立路由指向同一个 `DevicePage`，确保 `useParams()` 能拿到 `windowId/paneId`，且在窗口/pane 切换时不卸载页面。

- `apps/fe/src/pages/DevicePage.tsx`
  - 支持 URL 中 `paneId` 的安全编码/解码（兼容 `%1` 与 `%251` 形式），避免 paneId 与快照数据不一致导致一直“连接中...”。
  - `xterm` dispose 逻辑改为可复用的延迟释放，既规避 StrictMode 竞态，也确保真实卸载时会释放实例。

- `apps/fe/src/components/Sidebar.tsx`
  - 使用 `useMatch()` 解析当前选中的 device/window/pane（修复 layout 内 `useParams()` 无法获取子路由参数的问题）。
  - 生成 pane 路由时对 `paneId` 做 `encodeURIComponent`，与 `DevicePage` 的解码逻辑配套。

- `apps/fe/tests/tmux-local.e2e.spec.ts`
  - 新增用例：通过 xterm 键盘输入执行 `tmux new-window` / `tmux split-window -h` / `tmux kill-window`。
  - 通过侧边栏树断言窗口与 pane 的创建/切换。
  - 收集 `pageerror` 并在测试末尾断言为空，用于捕获 xterm 未捕获异常（包括 `dimensions` 相关崩溃）。
  - 清理：测试结束执行 `tmux kill-session -t <session> || true`。

## 运行方式

> 注意：gateway 依赖 Bun，运行机器需安装 `bun`，且系统中需可执行 `tmux`。

- 在 `apps/fe` 目录运行：
  - `npm test`

如需指定运行 ID（避免会话名冲突）：

- `TMEX_E2E_RUN_ID=local npm test`

## 验收点

- 测试能够在真实浏览器中：
  - 连上本地 tmux。
  - 创建/删除窗口。
  - split 并切换 pane。
- 测试过程中不出现 `pageerror`（可捕获到 xterm 的未捕获异常）。

## 已知限制与风险

- gateway 依赖 Bun：可通过 `TMEX_E2E_BUN` 指定可执行文件路径，或确保 `bun` 在 `$PATH` 中。
- 测试依赖 UI 结构（侧边栏树），若后续 UI 重构需要同步调整定位器。
