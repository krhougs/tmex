# 三套环境（development / test / production）环境变量体系

## 背景与目标

tmex 此前只有两个事实上的 `NODE_ENV` 取值（`development` / `production`），环境变量加载逻辑散落在 `dev-supervisor.sh`、两个 `test-preload.ts`、`playwright.config.ts` 等多处并互相打补丁；dev / test 运行还会继承 shell 里安装版 `app.env` 的变量（`NODE_ENV=production`、生产 `DATABASE_URL`、指向安装目录的 `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR`），多次导致 dev 启动崩溃、单元测试误写生产库。

本次建立标准三环境体系：`NODE_ENV ∈ {development, test, production}`，由一个共享加载器统一处理，散点 hack 全部收敛。

- 开发服务器走 `development`，由仓库根 `development.env` 提供配置。
- 所有测试（单元 + e2e）走 `test`，由仓库根 `test.env` 提供共享行为配置。
- `production` 仅用于打包安装后的常驻服务，变量来自安装版 `app.env` + `run.sh`，**绝不读取任何仓库 env 文件**。

环境名用 `test`（而非 `testing`）：`bun test` 会自动把 `NODE_ENV` 设为 `test`，对齐后连 bare `bun test` 也能命中 `test.env`。

## 变量来源矩阵

| 环境 | NODE_ENV | 配置来源 | 由谁加载 |
|---|---|---|---|
| development | `development` | 仓库根 `development.env`（+ `development.env.local` 覆盖） | 应用启动时 `loadEnv()` |
| test | `test` | 仓库根 `test.env`（+ `test.env.local`），接线键由各测试入口注入 | preload / 应用 `loadEnv()` |
| production | `production` | 安装版 `app.env`（`buildAppEnvValues`，7 个核心键）+ `run.sh` export 的 `TMEX_FE_DIST_DIR`/`TMEX_MIGRATIONS_DIR` | `run.sh` 经 shell 注入 |

- `development.env` / `test.env` 提交进库（仅含开发/测试用公开值，dev master key 本就公开）；`*.env.local` 忽略，供个人临时覆盖。
- 可选 `TMEX_*` 调优项（throttle / tmux / ssh-reconnect / language）在 `apps/gateway/src/config.ts` 均有默认值，**这些默认值即生产行为**。生产 `app.env` 保持精简，不扩容；老安装无需迁移。

## 共享加载器 `packages/shared/src/env/load-env.ts`

`loadEnv()` 按 `NODE_ENV` 分派到三条专属分支：

**production 分支 `applyProductionEnv()`**

- 不读取任何仓库 env 文件、不执行净化（生产里路径键正是安装目录路径，绝不能动）。
- fail-fast 校验生产契约：`TMEX_MASTER_KEY`/`GATEWAY_PORT`/`TMEX_BIND_HOST`/`DATABASE_URL` 必须存在，`TMEX_FE_DIST_DIR`/`TMEX_MIGRATIONS_DIR` 必须存在且指向真实目录（`existsSync`）。任一缺失即抛带可操作信息的错误（提示检查 app.env / 重跑 `tmex upgrade`）。
- 打印生产摘要作为可观测信号。

**development / test 分支 `applyRepoEnv()`**

1. 净化继承的安装版毒变量：若 `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR` 含 `Application Support/tmex` 标记则删除（收敛旧 hack）。
2. 读 `<env>.env` 再读 `<env>.env.local`（后者覆盖前者）。
3. 以 **override=true** 应用：文件定义的键覆盖继承的 shell 值，使仓库文件成为该环境唯一真相；文件未定义的键保持原值不动。
4. 相对 `DATABASE_URL` 解析到仓库根。

### 优先级与「接线键」约定

`test.env` **刻意省略**「按运行上下文变化的接线键」——`DATABASE_URL` / `GATEWAY_PORT` / `FE_PORT` / `TMEX_BASE_URL` / `TMEX_GATEWAY_URL`。配合 override=true，三场景互不冲突：

- 开发：`development.env` 全权威（dev-supervisor 不注入动态值）。
- 单元测试：preload 设 `DATABASE_URL=:memory:`（文件未定义，不被覆盖）。
- e2e：playwright / run-e2e 注入动态端口、临时 db、派生 URL（文件未定义，不被覆盖）。

## 各入口接入

| 入口 | 接入方式 |
|---|---|
| dev gateway | `apps/gateway/src/index.ts` 首行 `import './bootstrap-env'`（在 import config 前调 `loadEnv()`） |
| 生产 runtime | `packages/app/src/runtime/server.ts` 首行 `import './bootstrap-env'`（production 走 `applyProductionEnv()`） |
| 单元测试 | 根 `bunfig.toml` 与 `apps/gateway/bunfig.toml` 的 preload：先设 `DATABASE_URL`（未设/含生产标记→`:memory:`），再调 `loadEnv()` |
| dev-supervisor | `export NODE_ENV=development` 后 source `development.env`（仅为自身拿到端口做健康检查）；净化与相对 DATABASE_URL 解析交给应用侧 `loadEnv()` |
| e2e playwright | gateway/fe webServer 只注入接线键（`NODE_ENV=test` + 动态端口/db/URL），行为配置由 webServer 进程自身 `loadEnv()` 加载 |

`config.ts` 提供 `isDev` / `isTest` / `isProd` 三个布尔量。

### 前端（vite）不加载后端 env

`loadEnv` 是 Node-only（依赖 `node:fs`/`node:url`），**不从 `@tmex/shared` 浏览器侧主入口导出**——否则会被打进客户端 bundle，触发 `Module "node:fs" has been externalized` 运行时错误。Node 侧消费者一律相对路径 `import './env/load-env'`。

`apps/fe/vite.config.ts` **刻意不加载任何后端 env 文件**：前端只需要 `TMEX_GATEWAY_URL` 与 `FE_PORT` 两个非密钥接线值，由 launcher 经 `process.env` 提供（dev-supervisor source / playwright 注入）。若让 vite 加载后端 env，会把 `TMEX_MASTER_KEY` 等密钥拉进 vite 进程，存在被打进前端 bundle 的风险。

## 注意事项

- **生产路径键保护**：`applyProductionEnv()` 的早返回必须在净化逻辑之前——否则会删掉生产正确的 `TMEX_MIGRATIONS_DIR`/`TMEX_FE_DIST_DIR`，搞崩常驻服务。单测已钉死该行为。
- **本机生产服务**：验证生产路径一律在仓库内起临时实例（显式覆盖端口 / install dir），严禁触碰系统已安装的 9883 常驻服务。
- 旧的 `.env` / `.env.example` 已删除（`.env` 会被 Bun 在所有环境自动加载，是隐患）。

实现与验证记录见 `prompt-archives/2026061301-env-three-tier/`。
