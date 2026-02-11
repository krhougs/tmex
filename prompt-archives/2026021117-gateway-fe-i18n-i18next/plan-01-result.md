# 执行结果：plan-01

时间：2026-02-11

## 背景

本轮在 `plan-00` 核查结果基础上继续落地，重点完成两条主线：

1. Gateway 数据层升级为 Drizzle ORM + migration（启动自动执行）；
2. Gateway/FE 国际化收尾与 E2E 去文案依赖。

## 已完成项

### 1）Gateway：Drizzle ORM + migration

- 新增 Drizzle 配置与迁移链路：
  - `apps/gateway/drizzle.config.ts`
  - `apps/gateway/src/db/schema.ts`
  - `apps/gateway/src/db/client.ts`
  - `apps/gateway/src/db/migrate.ts`
  - `apps/gateway/drizzle/0000_busy_starjammers.sql`
  - `apps/gateway/drizzle/meta/*`
- 启动时自动迁移：
  - `apps/gateway/src/index.ts` 启动前执行 `runMigrations()`，随后 `ensureSiteSettingsInitialized()`。
- `apps/gateway/src/db/index.ts` 已切换为 Drizzle ORM 查询/写入流程，业务 CRUD 不再使用手写 SQL。
- `apps/gateway/package.json` 已接入 `drizzle-orm` / `drizzle-kit` 与 migration 脚本。

### 2）Gateway：i18n 收尾

- `apps/gateway/src/api/index.ts`：站点设置校验与错误返回统一走 i18n key。
- `apps/gateway/src/events/index.ts`：Telegram 通知文案已走 i18n key，时间格式按 `settings.language`。
- `apps/gateway/src/telegram/service.ts`：广播与测试消息使用 i18n，时间格式按站点语言。
- `apps/gateway/src/db/index.ts`：移除中文硬编码异常文本（改为 i18n 文案）。

### 3）FE：i18n 收尾 + testid 基础设施

- i18n 缺口修复：
  - `apps/fe/src/pages/SettingsPage.tsx`：API fallback 文案改为 i18n key，`Token` 占位与 `chatId` 标签改 i18n。
  - `apps/fe/src/pages/DevicePage.tsx` / `apps/fe/src/layouts/RootLayout.tsx`：顶部按钮文案 key 统一，终端初始化错误改 i18n。
  - `apps/fe/src/components/Sidebar.tsx`：设置入口文案改 i18n key。
- 新增/补齐关键 `data-testid`：
  - `apps/fe/src/pages/DevicesPage.tsx`（新增、弹窗输入、保存、设备卡片、连接按钮）
  - `apps/fe/src/pages/DevicePage.tsx`（输入模式切换、跳转最新、状态覆盖层、编辑器输入与快捷键）
  - `apps/fe/src/layouts/RootLayout.tsx`（移动端顶栏按钮）
  - `apps/fe/src/components/Sidebar.tsx`（折叠按钮、底部导航、设备/窗口/pane 操作按钮）
  - `apps/fe/src/pages/SettingsPage.tsx`（语言选择、保存、重启、刷新提示）

### 4）E2E：去文案依赖并修复测试文件损坏

以下用例已改为 `testid`/状态定位，不再依赖中英文 UI 文案：

- `apps/fe/tests/tmux-direct-url.e2e.spec.ts`
- `apps/fe/tests/tmux-local.e2e.spec.ts`
- `apps/fe/tests/tmux-mobile.e2e.spec.ts`
- `apps/fe/tests/tmux-sidebar.e2e.spec.ts`
- `apps/fe/tests/tmux-terminal.e2e.spec.ts`
- `apps/fe/tests/tmux-ux.e2e.spec.ts`
- `apps/fe/tests/tmux-env-port.e2e.spec.ts`

并修复了此前测试文件中的明显语法/变量问题（如未定义 `deviceId`、错误字符串模板、不完整语句）。

## 验证记录

### 构建与单测

- `bun run --filter @tmex/gateway build`：通过
- `bun run --filter @tmex/gateway test`：通过（41 pass）
- `bun run --filter @tmex/fe build`：通过

### E2E 解析与冒烟

- `bun run --filter @tmex/fe test -- --list`：通过（36 tests in 7 files，全部可解析）
- `bun run --filter @tmex/fe test -- tests/tmux-env-port.e2e.spec.ts --project=chromium --reporter=line`：通过（3 pass）
- `bun run --filter @tmex/fe test -- tests/tmux-ux.e2e.spec.ts -g "编辑器应提供快捷键并可直接发送" --project=chromium --reporter=line`：通过（1 pass）

### 规则核查

- SQL 残留核查：
  - `rg -n "SELECT |INSERT |UPDATE |DELETE |prepare\(|database\.run\(|database\.query\(" apps/gateway/src/db`
  - 结果：无命中（仅 migration SQL 文件保留 SQL）。
- E2E 文案定位核查：
  - `rg -n "getByRole\([^\n]*name\s*:|getByText\(|hasText|getByLabel\(" apps/fe/tests`
  - 结果：无命中。
- i18n key 完整性核查（静态扫描）：
  - 使用脚本统计 `t('...')` 静态 key 与资源 key 集合。
  - 结果：`missing = 0`。

### migration 启动验证

- 使用临时 DB 启动 Gateway（端口冲突但不影响迁移阶段）：
  - 验证到 `__drizzle_migrations`、业务表已创建；
  - `site_settings` 初始行已落库（`en_US | tmex`）。

## 风险与说明

1. **旧数据库不兼容**：按需求未做历史兼容迁移。
2. **E2E 仅做了冒烟**：已确认可解析并跑通关键样例，未执行全量 36 条回归。
3. **仍有非功能性警告**：前端构建存在既有 CSS/chunk warning，不影响本次功能验收。

## 结论

`plan-01` 目标已完成：

- Drizzle ORM + schema + migration 已落地，并接入 Gateway 启动自动执行；
- Gateway 业务 SQL 已替换为 ORM 操作；
- i18n 与语言设置链路已补齐；
- E2E 主流程已切换为非文案依赖定位并修复可执行性。
