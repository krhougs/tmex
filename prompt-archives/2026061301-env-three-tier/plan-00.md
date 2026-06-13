# 三套环境（development / test / production）环境变量体系重构

## Context（背景与动机）

当前项目只有两个事实上的 `NODE_ENV` 取值（`development` / `production`），且环境变量加载逻辑散落多处、互相打补丁：

- `.env`（gitignore）+ `.env.example`（提交）+ 生产 `app.env`（installer 生成）三套来源，命名与职责混乱。
- dev / test 运行时会**继承 shell 里安装版 `app.env` 的变量**（`NODE_ENV=production`、生产 `DATABASE_URL`、`TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 指向安装目录），已多次导致 dev 启动崩溃、单元测试误写生产库。现有修复是散点 hack：`scripts/dev-supervisor.sh` 的 `unset` + `source .env`、`apps/gateway/test-preload.ts` 与根 `test-preload.ts` 的字符串标记硬判、`apps/fe/playwright.config.ts` 里硬编码的整块 env。

目标：建立现代发布流程的三环境体系，`NODE_ENV ∈ {development, test, production}`，由仓库内 `development.env` / `test.env` 两个文件统一维护 dev/test 配置，所有测试走 `test`、开发服务器走 `development`，`production` 仅用于打包安装的常驻服务（变量来自 `app.env` + `run.sh`，**绝不读取任何仓库 env 文件**）。把散点 hack 收敛到一个共享加载器。

环境命名用 `test`（而非最初设想的 `testing`）：`bun test` 会自动把 `NODE_ENV` 设成 `test`，对齐后连 bare `bun test` 都能自动命中 `test.env`，省掉抢设 `NODE_ENV` 的麻烦（已查证 Bun 官方文档）。

## 关键约束与已查证事实

- **Bun 自动加载** `.env` → `.env.{production,development,test}` → `.env.local`。我们用 `development.env`/`test.env` 这种命名**不在** Bun 自动加载范围内（好：不和 Bun 打架；必须自己显式加载）。仓库现存的 `.env` 会被 Bun 在所有环境自动加载，是隐患，**必须删除**。
- **生产入口** = `packages/app/src/runtime/server.ts`（打包为 `runtime/server.js`），经 `apps/gateway/src/runtime.ts → config.ts`。dev 入口 = `apps/gateway/src/index.ts`。两者都最终读 `config.ts`。
- **生产变量来源**：launchd plist 不设任何 env；全部来自 `run.sh` 的 `source app.env`（7 个核心键，见 `buildAppEnvValues` @ `packages/app/src/lib/install.ts:20-30`）+ `run.sh` 额外 export `TMEX_FE_DIST_DIR`/`TMEX_MIGRATIONS_DIR`（指向安装目录，`install.ts:79-80`）。`upgrade` 流程**不重写 app.env**（保留用户配置）。
- **生产里 `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 的值正是安装目录路径**（含 `Application Support/tmex` 标记）。⚠️ 加载器的「净化继承毒变量」步骤会删除带该标记的这两个键——**所以 production 必须早返回，净化步骤绝不能在生产执行**，否则会删掉生产正确路径、直接搞崩常驻服务。
- agent/watch 无新增生产必读 env：仅 `TMEX_AGENT_ALLOW_PRIVATE_FETCH`（`apps/gateway/src/agent/tools/web.ts:106`，无默认→禁用，测试用）。agent 配置走 DB。
- `config.ts` 对所有可选 `TMEX_*`（throttle / tmux / ssh-reconnect / language）已有安全默认值，这些默认值即生产行为。**生产 app.env 保持精简，不扩容 `buildAppEnvValues`**——避免 app.env 膨胀，且 `upgrade` 不重写 app.env 会导致老安装拿不到新键。

## 设计

### 1. 文件布局

- 新增并提交：`development.env`、`test.env`（根目录）。dev master key 用现成的公开 dev key（`.env.example` 早已提交同一个 key，无新增泄密面）。
- 新增 gitignore：`*.env.local`（个人临时覆盖，`development.env.local` / `test.env.local`）。
- 删除：`.env`、`.env.example`。
- `.gitignore` 改写：移除 `.env.*` 全忽略 + 放行 `.env.example` 的旧规则；改为忽略 `*.env.local`，提交 `development.env`/`test.env`。

**`development.env`（开发服务器，完整定义全部应用变量）**：
```
NODE_ENV=development
TMEX_MASTER_KEY=tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=
TMEX_SITE_NAME=tmex
GATEWAY_PORT=19663
FE_PORT=19883
DATABASE_URL=./tmex.db
TMEX_BIND_HOST=127.0.0.1
TMEX_BASE_URL=http://127.0.0.1:19663
TMEX_GATEWAY_URL=http://localhost:19663
TMEX_BELL_THROTTLE_SECONDS=6
TMEX_NOTIFICATION_THROTTLE_SECONDS=3
TMEX_TMUX_ALLOW_PASSTHROUGH=false
TMEX_TMUX_TERM_PROGRAM=ghostty
TMEX_TMUX_WINDOW_STYLE=fg=#d0d0d0,bg=#262626
TMEX_SSH_RECONNECT_MAX_RETRIES=2
TMEX_SSH_RECONNECT_DELAY_SECONDS=10
TMEX_DEFAULT_LANGUAGE=en_US
```
（端口沿用 19663/19883，避开本机常驻生产 tmex 的 9663/9883。`TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 不设，靠净化 + 代码默认回退到仓库 drizzle / 默认 fe-dist。）

**`test.env`（测试共享行为配置；不含「按运行上下文变化的接线键」）**：
```
NODE_ENV=test
TMEX_MASTER_KEY=tGd9gPmdUkJrpRQK+db60sc+NkxymxgGqKrReDU4Kus=
TMEX_SITE_NAME=tmex
TMEX_BELL_THROTTLE_SECONDS=6
TMEX_NOTIFICATION_THROTTLE_SECONDS=3
TMEX_TMUX_ALLOW_PASSTHROUGH=false
TMEX_TMUX_TERM_PROGRAM=ghostty
TMEX_TMUX_WINDOW_STYLE=fg=#d0d0d0,bg=#262626
TMEX_SSH_RECONNECT_MAX_RETRIES=2
TMEX_SSH_RECONNECT_DELAY_SECONDS=10
TMEX_DEFAULT_LANGUAGE=en_US
```
**刻意不写** `DATABASE_URL` / `GATEWAY_PORT` / `FE_PORT` / `TMEX_BASE_URL` / `TMEX_GATEWAY_URL`——这些是「按运行上下文变化」的接线键，由各测试入口提供（见优先级规则）：单元测试 preload 设 `DATABASE_URL=:memory:`；e2e 由 playwright/run-e2e 注入动态端口 + 临时 db + 派生 URL。

### 2. 共享加载器 `packages/shared/src/env/load-env.ts`（导出 `loadEnv()`）

执行顺序（顺序是正确性的核心）。`loadEnv()` 按 `NODE_ENV` 分派到三条**专属分支**，production 不是「空早返回」，而是有自己一套生产契约校验逻辑：

1. 解析 `NODE_ENV`，缺省 `development`，分派分支。

**production 分支 `applyProductionEnv()`**（读到 production 就走自己的专属逻辑）：
- **不读取任何仓库 env 文件、不执行净化**（生产变量已由 run.sh `source app.env` 注入，路径键正是安装目录，绝不能动）。
- **fail-fast 校验生产契约**（符合 fail-fast 原则）：断言必需键齐全且形态正确——`TMEX_MASTER_KEY` 存在（否则 config.ts 本就会抛，这里给更早更清晰的错误）、`GATEWAY_PORT`/`TMEX_BIND_HOST`/`DATABASE_URL` 存在、`TMEX_FE_DIST_DIR`/`TMEX_MIGRATIONS_DIR` 存在**且**指向真实存在的目录（用 `existsSync` 校验，缺失即报错并指明应由 run.sh 提供）。任一缺失/异常 → 抛带可操作信息的错误（告知检查 app.env / run.sh / 重新 `tmex upgrade`）。
- 打印一行生产模式摘要（`production` + 关键路径），作为生产验证的可观测信号。
- **不**做 dev/test 的 override，避免覆盖 run.sh 已正确注入的值。

**development / test 分支**（共享 `applyRepoEnv(env)`）：
2. **净化继承毒变量**：若 `TMEX_MIGRATIONS_DIR` / `TMEX_FE_DIST_DIR` 的值包含 `Application Support/tmex` 标记，从 `process.env` 删除（收敛 dev-supervisor 与两个 test-preload 的散点 hack）。
3. 读仓库根 `<env>.env`，再读 `<env>.env.local`，解析为合并 map（`.local` 覆盖 `.env`）。
4. **以 override=true 应用到 `process.env`**：文件定义的键一律覆盖继承的 shell 值（这是文件成为「环境唯一真相」、彻底解决继承毒变量的根本手段，泛化自当前 `source .env` 行为）。文件**未定义**的键（如各测试上下文的接线键、`SSH_AUTH_SOCK` 等）保持 `process.env` 原值不动。

**优先级总结**：`文件未定义的键（含上下文接线键）= 入口注入值胜` ；`文件定义的键 = 文件胜（覆盖继承 shell）`。两条规则配合「test.env 刻意省略接线键」，同时满足 dev（文件全权威）、单元测试（preload 设 :memory:）、e2e（playwright 注入动态值）三种场景，互不冲突。

实现细节：纯 Bun/Node，`node:fs` 读文件 + 简单 `KEY=VALUE` 解析（参考 run.sh 既有解析：跳过空行/`#` 注释、去 `\r`）。仓库根定位用 `import.meta.dir` 上溯或显式常量。production early-return 之外不依赖任何外部库。

### 3. 三个入口接入

- **dev gateway**：`apps/gateway/src/index.ts` 顶部新增 `import './bootstrap-env'`（内部调 `loadEnv()`），保证在 `import { config }` 前 `process.env` 就绪。`config.ts` 增加 `isTest = getEnv('NODE_ENV','development')==='test'`（`isDev`/`isProd` 保持；`isProd && !masterKey` 检查保留）。
- **生产入口**：`packages/app/src/runtime/server.ts` 顶部同样调 `loadEnv()`（生产下走 `applyProductionEnv()`：校验生产契约 + 打印生产摘要，永不触碰/读取仓库文件与安装路径键）。这给生产验证一个可观测信号，并把缺变量的失败提前到启动最早期。
- **fe（vite）**：`apps/fe/vite.config.ts` 顶部先调一次共享 `loadEnv()`（按 `process.env.NODE_ENV` 选 development/test，缺省回退 vite `mode`），把仓库根 `<env>.env` 灌进 `process.env`；vite 原有 `env.X || process.env.X` 读取链即可拿到。e2e 时 playwright 给 fe 注入 `NODE_ENV=test` + 动态端口/URL，因接线键不在 test.env，注入值保留。
- **测试 preload**：根 `bunfig.toml` 与 `apps/gateway/bunfig.toml` 的 preload（`test-preload.ts` / `apps/gateway/test-preload.ts`）重写为：先 `process.env.DATABASE_URL ??= ':memory:'`（单元测试接线键），再调 `loadEnv()`（命中 test.env）。删除原有字符串标记硬判逻辑（已由 loadEnv 的净化 + production-guard 取代）；保留「拒绝生产库」语义：在 `test` 环境断言 `DATABASE_URL` 不指向安装目录标记，命中则抛错。

### 4. 各 launcher / 脚本简化

- `scripts/dev-supervisor.sh`：删除 `unset TMEX_MIGRATIONS_DIR TMEX_FE_DIST_DIR` 与 `load_env_file`/`source .env`/`.env.example` 整块逻辑；改为 `export NODE_ENV=development` 后直接拉起 gateway/fe（env 由应用自加载）。端口日志改从 `development.env` 读取或保留为可选。`DATABASE_URL` 相对路径解析逻辑：若仍需要，迁移进 `loadEnv()`（把相对 `DATABASE_URL` 解析为仓库根绝对路径）；否则在 development.env 用相对路径 + 应用侧解析。
- `apps/fe/playwright.config.ts`：删除 gateway webServer 里硬编码的 `NODE_ENV`/`TMEX_MASTER_KEY`/`TMEX_MIGRATIONS_DIR`/`TMEX_BASE_URL` 等整块；webServer 进程经 `bootstrap-env` 自加载 test.env，config 里只保留**接线键的动态注入**（`NODE_ENV=test`、动态 `GATEWAY_PORT`/`FE_PORT`、`DATABASE_URL`、派生 `TMEX_BASE_URL`/`TMEX_GATEWAY_URL`）。`reuseExistingServer` 端口冲突防护保留。
- `apps/gateway/package.json` 的 `test` 脚本去掉手写 `DATABASE_URL=:memory:`（由 preload 接管）。
- 生产 `install.ts` / `writeRunScript` / `buildAppEnvValues`：**保持不变**（精简 app.env + run.sh export 路径键的现状正确）。仅需确认 + 文档化：生产可选 `TMEX_*` 全靠 `config.ts` 默认值，与 development.env 显式值一致。

## 关键文件清单

- 新增：`development.env`、`test.env`、`packages/shared/src/env/load-env.ts`、`apps/gateway/src/bootstrap-env.ts`（薄封装，调 `loadEnv()`）。
- 改：`.gitignore`、`apps/gateway/src/index.ts`、`apps/gateway/src/config.ts`、`packages/app/src/runtime/server.ts`、`apps/fe/vite.config.ts`、`apps/fe/playwright.config.ts`、`apps/fe/scripts/run-e2e.ts`（按需）、`scripts/dev-supervisor.sh`、`test-preload.ts`、`apps/gateway/test-preload.ts`、`apps/gateway/package.json`、`packages/shared/src/index.ts`（导出 loadEnv，按需）。
- 删：`.env`、`.env.example`。

## 任务清单

0. **先存档**（AGENTS.md 要求）：在 `prompt-archives/` 建日期编号文件夹（如 `2026061300-env-three-tier`），写 `plan-prompt.md`（本轮 prompt 存档）+ `plan-00.md`（本计划）。
1. 写 `packages/shared/src/env/load-env.ts`（`loadEnv()` 三分支：`applyProductionEnv()` 校验生产契约+不读文件；dev/test 走 `applyRepoEnv()` 净化→读 `<env>.env`/`.local`→override=true 应用）；先写单元测试覆盖 dev/test/production 三分支、生产契约 fail-fast、override 与净化（TDD）。
2. 建 `development.env` / `test.env`；删 `.env`/`.env.example`；改 `.gitignore`。
3. 接 dev gateway（`bootstrap-env.ts` + `index.ts` import；`config.ts` 加 `isTest`）。
4. 接生产入口 `runtime/server.ts`（调 loadEnv，验证 early-return 日志）。
5. 接 fe vite（`vite.config.ts` 调 loadEnv）。
6. 改测试 preload（根 + gateway）；去掉 `package.json` 里 `DATABASE_URL=:memory:`。
7. 简化 `dev-supervisor.sh`、`playwright.config.ts`（接线键动态注入）、`run-e2e.ts`（按需）。
8. 文档：`docs/` 下按模块写三环境说明（变量来源矩阵 / 三文件职责 / 生产 app.env 与代码默认值的对应关系）。

## 验收 / 验证

- **单元测试**：`bun run test`（gateway / shared / app 全绿）；新增 loadEnv 单测验证 production early-return 不删路径键、dev/test override 生效、净化逻辑命中安装目录标记。
- **dev 服务器**：在干净 shell + 故意继承一份假的安装版 `app.env`（`TMEX_MIGRATIONS_DIR`/`DATABASE_URL`/`NODE_ENV=production` 指向假安装目录）下跑 `bun run dev`，确认 gateway 用 development.env 的 19663 端口、仓库 drizzle、`/healthz` 200，前端 19883 起。
- **e2e**：`bun run --filter @tmex/fe test:e2e`（用 9665/9885 段或动态端口，临时 db），确认 agent 确认流等既有用例通过，不写生产库。
- **生产路径（不碰本机常驻服务）**：仓库内起临时安装实例——显式覆盖 `GATEWAY_PORT`/`TMEX_BIND_HOST` + 临时 install dir，跑 init→生成 app.env/run.sh→启动，确认：(a) `runtime/server.ts` 经 `applyProductionEnv()` 打印生产摘要、契约校验通过；(b) `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 仍为安装目录路径（未被净化删除）；(c) 故意删/改 app.env 某必需键时启动 fail-fast 报清晰错误；(d) 服务 `/healthz` 200、前端静态资源可访问。**严禁** 写入/重启系统已安装的 9883 常驻服务。
- `bun run lint`（注意：不对生成文件 lint）。

## 风险

- **生产路径键被误删**（最高风险）：靠 production 走独立 `applyProductionEnv()`（不净化、不读文件）保证，必须有单测钉死「`NODE_ENV=production` 时 loadEnv 不删除/不覆盖 `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 等已注入键」，以及「缺必需键时 fail-fast 抛错」。
- **override=true 误伤接线键**：靠「test.env 刻意省略接线键」+ playwright 在 loadEnv 之前注入。需在 e2e 验证动态端口/db 确实生效。
- **fe vite 的 mode vs NODE_ENV 错位**：vite dev 恒为 development mode，e2e 下由 playwright 显式注入 `NODE_ENV=test` 修正；需验证 e2e 下 fe 实际加载 test.env。
- **老安装升级**：app.env 不变 + 可选项靠代码默认值，老安装无需迁移；但需确认 development.env 里显式值与 config.ts 默认值一致，避免「dev 行为≠prod 行为」的隐性偏差。
