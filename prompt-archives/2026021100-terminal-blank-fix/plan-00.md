# Plan 00：Terminal 空白与功能失效修复

时间：2026-02-11

## 背景

用户反馈：无论从设备管理页点击“连接”进入，还是直接访问 `/devices/:deviceId/windows/:windowId/panes/:paneId`，terminal 都没有任何内容；并且此前计划（`prompt-archives/2026021001-terminal-fixes/plan-00.md`）中提到的“连接后显示现有内容 / 查看历史 / 侧边栏切换 / 尺寸同步”等能力仍不可用。

## 结论（根因）

gateway 侧 tmux `-CC` 控制模式输出存在 DCS 包装（例如 `ESC P1000p ... ESC \`）。当前解析器只去掉了前缀，没有剥离行尾的 `ESC \` 终止符，导致 `%end/%error` 行无法解析 output block meta，从而 `onOutputBlock` 不触发。

直接影响：

- snapshot 请求拿不到回包：前端无法获得 windows/panes，`/devices/:deviceId` 无法自动选中 pane。
- `capture-pane` 回包拿不到：连接后无法显示现有内容/历史。
- 未选中 pane 时，ws 侧会过滤二进制输出（只转发 selected pane），最终表现为 terminal 完全空白。

## 目标与验收

1. 从设备管理页点击“连接”进入：terminal 可显示已有内容并持续输出。
2. 直接访问 `/devices/:deviceId/windows/:windowId/panes/:paneId`：terminal 同样可用。
3. 历史内容、滚动查看、侧边栏切换、尺寸同步均可用。
4. 通过单测（parser）与 e2e（Playwright）验证。

## 实施步骤

### 1) 修复 tmux 控制模式解析（gateway）

- `apps/gateway/src/tmux/parser.ts`
  - 新增 `stripTmuxDcsWrapper()`：去掉行首 DCS 前缀与行尾 `ESC \\` 终止符。
  - `parseLine()` 全量使用该函数处理所有行（包含 `%begin/%end/%output/%extended-output`）。
- `apps/gateway/src/tmux/parser.test.ts`
  - 新增用例覆盖 “DCS + ST 终止符” 的 `%begin/%end` 与 `%output`。

### 2) 修复 select 时序导致的空白（gateway + fe）

- `apps/gateway/src/ws/index.ts`
  - `handleTmuxSelect`：先写入 `selectedPanes` 再判断 entry，避免 select 早到时丢状态。
- `apps/fe/src/pages/DevicePage.tsx`
  - `selectPane` effect 增加 `deviceConnected` 条件，确保 select 在连接成功后发送。

### 3) 修复前端输出缓冲未 flush（fe）

- `apps/fe/src/pages/DevicePage.tsx`
  - 终端 ready 后，将 `historyBuffer` 写入并清空。
  - `pendingHistory` 写入时补 `\r\n` 分隔，避免与实时输出粘连。

### 4) 统一 paneId URL 编解码（fe）

- 新增 `apps/fe/src/utils/tmuxUrl.ts`
  - 提供安全的 `decodePaneIdFromUrlParam()`（解码失败时返回上一次成功值）。
  - 提供 `encodePaneIdForUrl()`。
- `DevicePage.tsx`、`Sidebar.tsx` 替换为统一实现。

### 5) 修复 Playwright 配置不可运行并补齐 e2e 启动器

- `apps/fe/playwright.config.ts`
  - 改为同步导出对象，只读取端口环境变量（`TMEX_E2E_GATEWAY_PORT` / `TMEX_E2E_FE_PORT`）。
- 新增 `apps/fe/scripts/run-e2e.ts`
  - 动态探测可用端口，写入上述环境变量后执行 `playwright test`。
- `apps/fe/package.json`
  - 增加 `test:e2e` 脚本。

## 验证命令

- parser 单测：`source ~/.zshrc && bun test apps/gateway/src/tmux/parser.test.ts`
- e2e：`source ~/.zshrc && cd apps/fe && bun run test:e2e`

