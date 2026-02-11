# Plan 01：Gateway + FE 国际化收尾与 Drizzle ORM 重构

时间：2026-02-11

## 背景

`plan-00` 核查结果显示同事分支尚未验收通过，存在网关启动阻断、语言设置链路不闭合、后端硬编码文案、WS 错误展示不符合约定、E2E 仍依赖文案定位等问题。

在此基础上，新增要求：

1. 引入 Drizzle ORM；
2. 重建数据库 schema 与正规 migration；
3. migration 在 Gateway 启动时自动执行；
4. Gateway 中全部 SQL 操作替换为 ORM 安全操作；
5. 旧数据库可不兼容（明确不做历史兼容迁移）。

## 目标

1. Gateway 使用 Drizzle + SQLite（Bun）完成数据层重构；
2. 启动时自动执行 migration，空库可自动初始化；
3. 移除 db 模块中的业务 SQL 字符串拼接/手写 CRUD；
4. 补齐 plan-00 里 i18n 未完成项（后端/前端/E2E）；
5. 完成双语言（en_US / zh_CN）可用与 E2E 去文案依赖。

## 设计思路

### 1）数据库层

- 新增 `apps/gateway/src/db/schema.ts`：使用 Drizzle `sqliteTable` 定义全量表结构；
- 新增 `apps/gateway/src/db/client.ts`：统一初始化 Bun SQLite 与 Drizzle client；
- 新增 `apps/gateway/src/db/migrate.ts`：封装启动迁移执行；
- 新增 `apps/gateway/drizzle.config.ts` 与 `apps/gateway/drizzle/*` 迁移目录；
- 在 `src/index.ts` 启动时先 `runMigrations()`，再启动 API/WS 服务。

### 2）数据访问层

- 重写 `apps/gateway/src/db/index.ts` 全部导出函数实现，保持调用签名基本稳定，内部改为 Drizzle；
- 多步骤写入场景使用 transaction（如 Telegram chat upsert/approve）；
- 仅 migration SQL 文件允许原生 SQL。

### 3）i18n 收尾

- 后端：
  - settings 接口补齐 `language` 校验与持久化；
  - Telegram/Webhook 文案全部走 i18n key；
  - 日期格式统一使用 `toBCP47(settings.language)`；
- 前端：
  - 接入 i18next/react-i18next；
  - 保存语言后提示刷新生效，不做运行时自动切换；
  - 全量替换客户可见文案与 ARIA/title/placeholder。

### 4）E2E 去文案依赖

- 补全关键交互 `data-testid`；
- 测试主定位改为 testid + URL/状态断言；
- 移除主要流程对中英文文本定位的依赖。

## 任务拆解

1. 档案更新：补充 `plan-prompt.md`，落盘本计划；
2. Gateway 引入 Drizzle 依赖与配置；
3. 定义 schema 并生成首个 migration；
4. 改造启动流程接入自动 migration；
5. 重写 db/index.ts 为 ORM 实现；
6. 修复后端 i18n 缺口；
7. 接入并完善前端 i18n；
8. E2E 选择器改造与去文案依赖；
9. 跑测试/构建并输出结果归档。

## 验收标准

1. Gateway 启动可自动完成 migration 且可正常提供服务；
2. `apps/gateway/src/db/index.ts` 不再包含业务 SQL CRUD；
3. `GET/PATCH /api/settings/site` 可读写 `language`；
4. 前端默认英文；设置为中文后刷新生效；
5. WS 错误显示“本地化摘要 + raw 细节”；
6. E2E 主流程不依赖文案定位；
7. `@tmex/gateway` 测试通过，`@tmex/fe` 构建通过。

## 风险评估

1. Drizzle schema 与 SQLite 约束映射差异导致行为回归；
2. DB 重写面大，容易引入字段映射遗漏；
3. FE 全量文案替换与 E2E 同时变更，回归范围较广。

## 注意事项

1. 旧数据库不兼容；
2. 不改变现有 API/WS 路由契约；
3. migration 失败时 Gateway 启动失败并输出明确错误；
4. 结果必须同步归档 `plan-01-result.md`。
