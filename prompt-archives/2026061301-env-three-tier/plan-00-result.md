# 执行结果：三套环境（development / test / production）env 体系重构

## 完成概述

按 plan-00 全部落地。`NODE_ENV ∈ {development, test, production}`，由共享加载器 `loadEnv()` 统一处理，散点 hack 收敛。dev 走 `development.env`、测试走 `test.env`、生产仅用安装版 `app.env`（绝不读仓库 env 文件）。

## 改动清单

**新增**
- `packages/shared/src/env/load-env.ts` —— 加载器（三分支：production 契约校验 / dev·test 净化+override 加载）+ `parseEnvFile`/`resolveEnvName`。
- `packages/shared/src/env/load-env.test.ts` —— 10 个单测，覆盖三分支、生产 fail-fast、override、净化、相对 DATABASE_URL 解析。
- `apps/gateway/src/bootstrap-env.ts`、`packages/app/src/runtime/bootstrap-env.ts` —— 入口最早期副作用调 `loadEnv()`。
- `development.env`、`test.env` —— 提交进库；`*.env.local` 已 gitignore。
- `docs/env/2026061301-three-tier-env.md` —— 三环境文档。

**修改**
- `packages/shared/src/index.ts` —— **不**导出 loadEnv（Node-only，避免进浏览器 bundle）。
- `apps/gateway/src/index.ts` —— 首行 import bootstrap-env；`config.ts` 加 `isTest`。
- `packages/app/src/runtime/server.ts` —— 首行 import bootstrap-env（生产入口）。
- `apps/fe/vite.config.ts` —— **移除**后端 env 加载，只从 process.env 读 `TMEX_GATEWAY_URL`/`FE_PORT` 两个非密钥接线值。
- `apps/fe/playwright.config.ts` —— webServer 只注入接线键（`NODE_ENV=test` + 动态端口/db/URL），删硬编码 master key / migrations dir。
- `scripts/dev-supervisor.sh` —— 改 source `development.env`，删 `unset` 与手动 DATABASE_URL 解析（交给 loadEnv）。
- `test-preload.ts`（根，相对 import）、`apps/gateway/test-preload.ts` —— 重写为「接线键设 :memory: + loadEnv」。
- `apps/gateway/package.json` —— `test` 脚本去掉 `DATABASE_URL=:memory:`。
- `.gitignore` —— 提交 `development.env`/`test.env`，忽略 `*.env.local`；删 `.env`/`.env.example`。

## 关键设计决策与踩坑

1. **环境名用 `test`**：对齐 `bun test` 自动设的 `NODE_ENV=test`，bare `bun test` 也能命中 `test.env`。
2. **production 专属分支 `applyProductionEnv()`**：fail-fast 校验契约、**早返回在净化之前**，绝不删生产路径键。已用单测 + 真实启动钉死。
3. **接线键约定**：`test.env` 刻意省略 `DATABASE_URL`/端口/派生 URL，配合 override=true，使 dev / 单元测试 / e2e 三场景互不冲突。
4. **node:fs 泄漏（白屏 bug）**：起初把 loadEnv 从 `@tmex/shared` 主入口导出 → fe 客户端 bundle 拖入 `node:fs` → `Module externalized` 运行时白屏。修复：移出主入口，Node 侧一律相对 import。
5. **前端 env 泄漏风险**：起初让 vite.config 用 loadEnv 灌全量后端 env（含 master key）进 process.env。改为前端完全不加载后端 env，只读两个非密钥接线值。已实证 fe 产物中无 master key。
6. **vite build 误触发 prod 分支**：移除 vite.config 的 loadEnv 后一并解决。
7. **workspace 解析**：根 `node_modules` 无 `@tmex/shared` symlink，根 preload 用相对路径 import。

## 验证结果

- **单元测试**：shared 49 / gateway 429 / app 13 全绿；新增 load-env 10 单测全绿。
- **dev 服务器**：在真实继承安装版毒变量（NODE_ENV=production、生产 DATABASE_URL、安装目录 MIGRATIONS/FE_DIST）的 shell 下 `bun run dev`：gateway 19663 healthz 200、fe 19883 200、日志显示净化两个毒变量 + 加载 development.env、**生产库 mtime 未变**、dev 写 repo/tmex.db。
- **e2e**：settings / mobile-settings / agent-session（4 用例）通过；fe 不再加载后端 env（日志只剩 vite 行）。
- **fe 产物**：`build:fe` 成功，dist 中无 `TMEX_MASTER_KEY`、无 master key 值。
- **生产路径**（临时端口 19990，未碰 9883 常驻服务）：`NODE_ENV=production` 跑 `runtime/server.ts` → 打印生产摘要、healthz 200、index.html 200（路径键未被删）；fail-fast 验证：缺 `TMEX_MASTER_KEY` 抛错、路径目录不存在抛错，均带可操作信息。
- **lint**：13 个改动文件全部 biome 干净。（`bun run lint` 全量失败项为预存在的 `.cache/tools/zig`、`Sidebar.tsx` a11y 等，非本次改动。）

## 遗留 / 备注

- 历史文档 `docs/2026021000-tmex-bootstrap/deployment.md` 等仍有 `cp .env.example .env` 旧指引（docker-compose 实际走内联 `NODE_ENV=production`，不受影响）；未改动历史文档，新文档为权威参考。
- 生产 `app.env` / `buildAppEnvValues` / `run.sh` 未改动（精简现状正确）；可选 `TMEX_*` 调优项靠 config.ts 默认值，老安装无需迁移。
