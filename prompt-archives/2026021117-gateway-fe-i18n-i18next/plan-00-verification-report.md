# Plan 00 完成度核查报告（Gateway + 前端 i18next）

时间：2026-02-11

## 核查对象

- 计划文档：`prompt-archives/2026021117-gateway-fe-i18n-i18next/plan-00.md`
- 同事实现分支：`feature/i18n-gateway-fe`（worktree：`.worktrees/i18n-gateway-fe`）
- 当前主分支对照：`main`（仅用于补充现状，不作为同事“已完成”证明）

## 核查方法与执行证据

### 1）自动化验证

- `bun run --filter @tmex/gateway test`：通过（35 pass, 0 fail）。
- `bun run --filter @tmex/fe build`：通过（有既有 CSS 警告，不阻断构建）。
- `rg` 扫描 E2E 文案依赖：仍存在大量 `getByText` / `getByRole({ name })` / `hasText`。
- 网关启动验证：
  - 命令：`DATABASE_URL=/tmp/... bun src/index.ts`
  - 结果：启动即抛 `ReferenceError: DEFAULT_LOCALE is not defined`。

### 2）代码对照核查

- 已核查 shared / gateway / fe / e2e 关键文件，并逐条对照计划目标与验收清单。

## 总结结论

**结论：该 Plan 尚未完成，当前状态不可验收。**

主要阻断项：

1. **同事分支网关无法启动（阻断级）**：`DEFAULT_LOCALE` 被 `import type` 引入后在运行时被擦除，初始化 schema 时直接报错。
2. **设置接口语言字段未落地**：`normalizeSiteSettingsInput` 未处理 `language`，导致前端提交语言设置无法生效。
3. **后端客户可见文案未全量 i18n**：Telegram 授权/测试消息、Webhook 通知仍有硬编码中文和 `zh-CN` 固定格式。
4. **WS 错误展示不符合约定**：前端错误展示未实现“本地化摘要 + raw 细节并排”，而是优先显示 raw。
5. **前端语言生效策略不符合约定**：当前实现会在 `fetch/refreshSettings` 时直接 `changeLanguage`，而计划要求“保存后刷新生效”。
6. **E2E 仍依赖文案定位**：与“E2E 不依赖中英文文案”的目标不一致。

## 验收清单逐条判定

1. 空库初始化后 `GET /api/settings/site` 返回 `language: "en_US"`：**未通过**（网关启动阻断，无法进入接口验证）。
2. 旧库升级后自动补齐 `language` 且不影响原配置：**未通过**（同上，被启动阻断）。
3. 默认打开前端为英文文案：**部分达成**（同事分支 FE 已接入 i18next 默认 `en_US`，但主分支尚未合入 FE i18n）。
4. 切换 `zh_CN` 后刷新生效：**未通过**（后端语言字段未处理；前端又存在运行时自动切换，行为与约定冲突）。
5. 浏览器语言变化不影响显示：**部分达成**（未使用自动语言检测插件；但整体语言链路仍不闭合）。
6. API/WS/Telegram/Webhook 文案可随设置切换：**未通过**（存在硬编码中文与固定 `zh-CN`）。
7. WS 错误并排显示摘要与 raw：**未通过**（当前逻辑未按约定展示）。
8. E2E 在双语言下通过且不依赖文案定位：**未通过**（仍大量依赖文案选择器，且无双语言通过证据）。

## 关键证据（文件定位）

- 运行时崩溃根因：`.worktrees/i18n-gateway-fe/apps/gateway/src/db/index.ts:14`、`.worktrees/i18n-gateway-fe/apps/gateway/src/db/index.ts:77`
- 设置接口未处理 `language`：`.worktrees/i18n-gateway-fe/apps/gateway/src/api/index.ts:40`
- Telegram 测试/授权消息硬编码：`.worktrees/i18n-gateway-fe/apps/gateway/src/api/index.ts:398`、`.worktrees/i18n-gateway-fe/apps/gateway/src/api/index.ts:425`
- Webhook 通知硬编码与固定 locale：`.worktrees/i18n-gateway-fe/apps/gateway/src/events/index.ts:132`
- WS 错误展示不符约定：`.worktrees/i18n-gateway-fe/apps/fe/src/stores/tmux.ts:215`
- 前端运行时自动切语言：`.worktrees/i18n-gateway-fe/apps/fe/src/stores/site.ts:45`、`.worktrees/i18n-gateway-fe/apps/fe/src/stores/site.ts:61`
- 前端仍固定 `zh-CN` 排序/时间：`.worktrees/i18n-gateway-fe/apps/fe/src/components/Sidebar.tsx:206`、`.worktrees/i18n-gateway-fe/apps/fe/src/pages/SettingsPage.tsx:665`
- E2E 文案依赖示例：`.worktrees/i18n-gateway-fe/apps/fe/tests/tmux-direct-url.e2e.spec.ts:103`、`.worktrees/i18n-gateway-fe/apps/fe/tests/tmux-local.e2e.spec.ts:66`、`.worktrees/i18n-gateway-fe/apps/fe/tests/tmux-terminal.e2e.spec.ts:157`

## 主分支补充说明（main）

- 主分支已修复部分网关语言处理（如 `language` 字段校验/持久化），但 **FE i18n 主体尚未合入**，当前 `apps/fe/src` 仍无 `i18n` 初始化入口。
- 因此，从“计划整体完成”视角，主分支同样 **不可判定为已完成**。

## 建议处理顺序

1. 先修复网关启动阻断（`DEFAULT_LOCALE` 运行时引用）。
2. 补齐设置接口 `language` 入参与校验，并加回归测试。
3. 清理后端剩余硬编码文案与固定 `zh-CN`，统一走 i18n + `toBCP47`。
4. 调整 FE 语言切换为“保存后提示刷新生效”，移除运行时自动切换。
5. 按规范补齐 testid，完成 E2E 去文案依赖并补双语言运行证据。
