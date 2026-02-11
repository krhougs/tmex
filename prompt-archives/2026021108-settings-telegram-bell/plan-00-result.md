# Plan 00 执行结果

时间：2026-02-11

## 完成情况

### 1. 无鉴权改造
- 已移除前后端登录/密码鉴权链路，路由与页面默认直达业务页面。
- 已删除 `apps/gateway/src/auth.ts`、`apps/fe/src/pages/LoginPage.tsx`、`apps/fe/src/stores/auth.ts`。
- API/WS 不再依赖 JWT 与登录态。

### 2. 设置中心
- 已新增设置页 `apps/fe/src/pages/SettingsPage.tsx`。
- 已支持站点名称与站点 URL 的读取/保存，并同步到标题栏与侧边栏展示。
- 已支持 bell 频控参数、SSH 自动重连参数配置与 Gateway 重启操作。

### 3. Telegram 多 Bot + 审批流
- 已新增多 bot 配置与管理（新增/更新/删除/启用开关/允许申请开关）。
- 每个 bot 的 chat 授权上限已限制为 8（已授权+待授权）。
- 已支持待授权 chat 的批准/拒绝，已授权 chat 的测试消息/撤销授权。
- 列表展示已包含申请时间、chatId、人名/群组名。

### 4. Bell 事件通知
- 前端已在收到 bell 时通过 sonner 展示通知。
- 已支持点击 toast 本体跳转到对应 pane。
- 后端已在 bell 事件通知中向所有授权 chat 发送消息，包含：站点名、device、window、pane、直达 pane 链接。

### 5. SSH 失败韧性
- 已改为设备级失败隔离，不再因单设备 SSH 失败导致 Gateway 进程退出。
- 已支持按设置项自动重连（次数/间隔）。

### 6. 错误提示统一
- 前端主要错误路径已改为 sonner toast（设备页、终端页、侧边栏、设置页、WS/设备事件）。

## 额外修复
- 修复 `apps/fe/src/components/Sidebar.tsx` 中顶层错误 Hook 调用导致的页面白屏问题。
- 同步清理 E2E 配置中的遗留鉴权环境变量（`TMEX_ADMIN_PASSWORD`、`JWT_SECRET`）。
- 同步清理架构文档中已删除 `auth.ts` 的旧描述。

## 验证结果

### 编译
- `bunx tsc -p packages/shared/tsconfig.json --noEmit` ✅
- `bunx tsc -p apps/gateway/tsconfig.json --noEmit` ✅
- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅

### 单元测试
- `bun run --cwd apps/gateway test` ✅（13/13）

### E2E（关键回归）
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"` ✅
- `bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "跳转到最新按钮应工作正常|当前 pane 被关闭后应显示失效态并禁用跳转到最新按钮|终端页面应更新浏览器标题"` ✅（3/3）

## 风险与后续建议
- 建议补充 bell-to-toast 点击跳转的前端自动化用例，避免后续回归。
- 建议补充 Telegram 审批流的集成测试（含待授权/批准/拒绝/测试消息）。
- 建议在真实 SSH 抖动环境下做一次长稳重连验证（非功能级压测）。
