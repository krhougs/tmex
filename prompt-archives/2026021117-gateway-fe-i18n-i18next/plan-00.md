# Plan 00：Gateway + 前端 i18next 全量国际化改造

时间：2026-02-11

## 背景

当前系统（`apps/gateway` 与 `apps/fe`）存在大量硬编码客户可见文案，且前后端尚未建立统一国际化机制。目标是引入 i18next，并让前后端共用同一套语言资源，支持 `zh_CN` 与 `en_US`，默认 `en_US`。

已确认约束：

1. 文案范围为全覆盖：前端 UI/Toast/可访问性文案 + Gateway API/WS + Telegram/Webhook。
2. WS 错误在前端并排展示：本地化摘要 + raw 原始错误。
3. 语言设置保存后刷新生效，不做运行中自动切换。
4. 严禁自动语言识别，必须严格按设置项语言展示。
5. E2E 代码不依赖任何页面文案（包含中英文文案）。

## 目标

1. 在前后端引入 i18next，并复用同一套共享语言资源文件。
2. 所有最终客户可见文案全部改为 i18n key。
3. 设置页新增语言选项（`en_US` / `zh_CN`），默认 `en_US`。
4. 旧数据库自动兼容迁移（新增 `site_settings.language` 字段）。
5. 保证现有测试可维护，并新增默认语言与语言切换相关验收。
6. 将 E2E 选择器体系改为稳定标识，不再依赖文案匹配。

## 变更总览

### 1）共享层（`packages/shared`）

- 新增语言类型：`LocaleCode = 'en_US' | 'zh_CN'`。
- 新增默认语言常量：`DEFAULT_LOCALE = 'en_US'`。
- 新增共享资源：`I18N_RESOURCES`（同一份资源供 FE/Gateway 使用）。
- 新增语言映射工具（如 `toBCP47`）用于日期/排序 locale 转换。
- 扩展 `SiteSettings` 与 `UpdateSiteSettingsRequest`：新增 `language` 字段。

### 2）Gateway（`apps/gateway`）

- 引入 i18next 初始化模块，资源来自 `@tmex/shared`。
- 新增基于 `site_settings.language` 的翻译方法，严禁自动探测语言。
- 数据库 schema 迁移：
  - `site_settings` 增加 `language TEXT NOT NULL DEFAULT 'en_US'`；
  - 通过 `PRAGMA table_info` + `ALTER TABLE` 实现幂等补列。
- 设置接口支持 `language` 读写与校验。
- 将以下客户可见文案改为 i18n：
  - API 错误响应（`api/index.ts`）；
  - WS 设备错误与重连提示（`ws/error-classify.ts`、`ws/index.ts`）；
  - Telegram 启动/授权/测试消息（`telegram/service.ts`）；
  - 事件通知模板（`events/index.ts`）；
  - 用户可见异常（如 SSH Agent 缺失、认证缺失等）。

### 3）前端（`apps/fe`）

- 引入 `i18next` + `react-i18next`，资源来自 `@tmex/shared`。
- 在 `main.tsx` 启动时初始化 i18n（默认 `en_US`，不做自动识别）。
- 设置页新增语言选项并提交到 `/api/settings/site`。
- 语言切换策略：保存成功后提示刷新生效，不做运行时自动切换。
- 全量替换可见文案为 `t()`：
  - `pages/DevicesPage.tsx`
  - `pages/DevicePage.tsx`
  - `pages/SettingsPage.tsx`
  - `layouts/RootLayout.tsx`
  - `components/Sidebar.tsx`
  - `stores/site.ts`
  - `stores/tmux.ts`
- 包含 `aria-label`、`title`、`placeholder`、toast 标题与描述。

### 4）WS 错误展示策略

- 调整前端错误展示逻辑：
  - 标题：本地化摘要（`payload.message`）；
  - 描述：原始错误（`payload.rawMessage`，若存在且与摘要不同）。

### 5）语言相关行为统一

- 前后端所有 `toLocaleString('zh-CN')` 改为按 `SiteSettings.language` 映射。
- `Sidebar` 设备排序 locale 改为按语言设置驱动。

### 6）E2E 去文案依赖改造

- 统一策略：E2E 禁止使用 `getByText`/`getByRole({ name: 'xxx' })` 这类依赖文案的定位方式。
- 为关键交互补充稳定定位锚点（`data-testid`、语义化结构、URL 参数、状态属性）。
- 需要补齐/复用的关键测试锚点包括但不限于：
  - 设备页：新增设备按钮、设备名称输入、连接入口、保存按钮；
  - 侧边栏：设备项、窗口项、pane 项、展开/折叠、创建窗口、关闭窗口/Pane；
  - 设置页：语言选择器、保存设置、重启按钮、Bot 相关操作按钮；
  - 终端页：跳转最新、输入模式切换、编辑器发送动作。
- 现有 E2E 用例统一改为以 `data-testid` 与 URL/状态断言为主，文案仅可作为可选补充断言，不作为主定位条件。

#### `data-testid` 命名规范（新增）

- 命名格式：`<domain>-<entity>-<actionOrField>[-<variant>]`，统一小写 kebab-case。
- 仅表达“稳定业务语义”，禁止包含语言文案、展示顺序、样式信息。
- 动态实体使用稳定 ID：
  - 设备：`device-card-<deviceId>`、`device-connect-<deviceId>`
  - 窗口：`window-item-<windowId>`、`window-close-<windowId>`
  - pane：`pane-item-<paneId>`、`pane-close-<paneId>`
- 全局关键操作建议：
  - `devices-add`
  - `device-dialog-save`
  - `settings-language-select`
  - `settings-save`
  - `settings-restart-gateway`
  - `terminal-jump-latest`
  - `terminal-input-mode-toggle`
- 复用优先：已有可用 testid 保持不变；新增 testid 时优先补在交互触发点而非纯展示节点。
- 测试约束：
  - 优先 `getByTestId` + 行为/状态断言；
  - 避免基于 nth/index 的脆弱选择器；
  - 当必须定位集合项时，先用 testid 锁定容器，再结合稳定属性过滤。

## 测试与验收

### 单元/集成

- Gateway：
  - `ws/error-classify.test.ts` 增加双语言断言；
  - `telegram/service.startup.test.ts` 增加语言相关断言；
  - 设置接口 language 字段校验与回写测试。

### E2E

- 重构现有 E2E 选择器：全部改为稳定锚点定位，移除对中文文案的硬依赖。
- 新增断言：在 `en_US` 与 `zh_CN` 两种设置下，核心用例均可通过（验证“测试与文案解耦”）。
- 新增用例验证默认语言为 `en_US`（通过设置接口返回值与语言控件值断言，不依赖页面文案文本）。

### 验收清单

1. 空库初始化后 `GET /api/settings/site` 返回 `language: "en_US"`。
2. 旧库升级后自动补齐 `language` 字段，不影响原配置。
3. 默认打开前端为英文文案。
4. 设置为 `zh_CN` 后，刷新页面后全站切为中文。
5. 浏览器语言如何变化都不影响显示（严格按设置）。
6. API/WS/Telegram/Webhook 客户可见文案均可随设置切换。
7. WS 错误前端并排显示本地化摘要与 raw 细节。
8. E2E 在 `en_US` 和 `zh_CN` 下均通过，且测试代码不依赖文案定位。

## 风险与注意事项

1. 文案替换面大，需通过扫描确保无漏网硬编码客户文案。
2. 数据库兼容需严格幂等，避免对已有实例造成破坏。
3. E2E 文案依赖重，需优先处理测试稳定性。
4. 非客户可见日志保持原状，避免无意义重构。
5. 为避免测试锚点失控，需统一约定 `data-testid` 命名规范并复用既有标识。
