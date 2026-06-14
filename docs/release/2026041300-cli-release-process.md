# tmex-cli 发布流程

## 背景

`tmex-cli` 的 npm 包源码位于 `packages/app`，但最终发布内容不只包含 CLI 入口，还包含以下产物：

- `packages/app/dist/cli-node.js`：Node 侧 CLI 入口。
- `packages/app/dist/runtime/server.js`：Bun 运行时入口，内部会打包 gateway 运行时代码。
- `packages/app/resources/fe-dist`：前端静态资源。
- `packages/app/resources/gateway-drizzle`：gateway 数据库迁移文件。
- `packages/app/CHANGELOG.md`：**仅含当前版本**的更新日志，随包发布；程序内自更新会从 CDN 拉取目标版本的该文件展示（见下文「版本注入与自更新」）。

因此，发布前不能只关注 `packages/app` 本身，必须确保根工作区内依赖发布包的产物全部重新生成。

> 版本号是构建期注入的：`bun run build` 期间 `packages/app` 的 `build:runtime` 会读 `packages/app/package.json` 的 `version`，经 `bun build --define TMEX_MONOREPO_VERSION="x.y.z"` 烧进 `dist/runtime/server.js`。所以**必须先 bump 版本号再 build**，否则 bundle 里烧进的是旧版本。详见 [版本注入与自更新](#版本注入与自更新)。

## 结论

发布前必须执行**全量重新编译**，推荐统一在仓库根目录运行：

```bash
bun install
bun run build
```

其中 `bun run build` 会依次执行：

```bash
bun run build:i18n
bun run build:fe
bun run build:tmex:resources
bun run build:tmex
```

这一步是发布门槛，不能用 `bun run --filter tmex-cli build` 替代，原因如下：

- 它不会主动执行 `packages/shared` 的 `build:i18n`。
- 它只会在 `apps/fe/dist/index.html` 不存在时才触发前端构建；如果 `dist` 已存在但过期，会直接复制旧产物进入 npm 包。

## 标准流程

### 1. bump 版本号 + 生成 changelog

不要手改 `package.json`。在仓库根目录执行：

```bash
bun run release:tmex <newVersion>      # 例：bun run release:tmex 0.11.0
```

`scripts/release.ts` 会：

1. 校验 semver；
2. 取「上一条 `chore(release)` 提交 .. HEAD」的 commit，按 conventional commit 前缀（feat/fix/perf/refactor/docs，其余归 Other）分组，排除 `chore(release)` 自身；
3. 重写 `packages/app/CHANGELOG.md`（**仅当前版本**，含日期）；
4. 写 `packages/app/package.json` 的 `version`。

随后**审阅 `packages/app/CHANGELOG.md`**，必要时手工润色。可选参数：`--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>`。

> 顺序很重要：必须先跑 `release:tmex`（bump 版本）再 `bun run build`，因为版本号在 build 期注入 bundle。

### 2. 全量重新编译

在仓库根目录执行：

```bash
bun install
bun run build
```

### 3. 基础校验

至少执行以下检查：

```bash
bun run test:tmex
npm pack --dry-run --workspace tmex-cli
```

校验重点：

- `npm pack --dry-run` 输出中必须包含 `dist`、`resources` 与 `CHANGELOG.md`。
- `resources/fe-dist` 中应包含最新前端静态资源。
- `resources/gateway-drizzle` 中应包含迁移文件。
- **版本号已正确烧进 bundle**：`grep -c "<newVersion>" packages/app/dist/runtime/server.js` 应 > 0（确认 `--define` 注入生效，而非旧版本）。

如果本次发布包含 `apps/gateway`、`apps/fe`、`packages/shared` 的行为变更，应额外执行受影响模块的测试或构建验证。

### 4. 登录 npm

先检查是否已登录：

```bash
npm whoami
```

如果未登录：

```bash
npm login
```

说明：

- `npm login` 可能会跳转浏览器完成授权。
- 如果账户启用了 2FA，需要在登录或发布过程中输入一次性验证码。

### 5. 发布稳定版

稳定版发布到 `latest`：

```bash
cd packages/app
npm publish --access public --tag latest
```

### 6. 发布预发布版

如果版本号包含 `-alpha`、`-beta`、`-rc` 等后缀，建议发布到 `next`：

```bash
cd packages/app
npm publish --access public --tag next
```

### 7. 发布后验证

```bash
npm view tmex-cli version
npx --yes tmex-cli@<version> --lang en help
```

必要时再补一条安装验证：

```bash
npx --yes tmex-cli@<version> doctor --lang en
```

## 版本注入与自更新

「monorepo 版本」= 发布的 `tmex-cli` 版本（`packages/app/package.json.version`），是前后端唯一真相源。

- **构建期注入**：`build:runtime`（`packages/app/scripts/build-runtime.ts`）与 docker 的 `apps/gateway` `build`（`apps/gateway/scripts/build.ts`）读该版本，经 `bun build --define TMEX_MONOREPO_VERSION="x.y.z"` 烧进 bundle；前端 `vite.config.ts` 同样 `define __MONOREPO_VERSION__`。运行时 `apps/gateway/src/system/version.ts` 用 `typeof` 守卫读取，dev 回退读仓库 `package.json`。**所以发版顺序必须是「先 `release:tmex` bump，再 `build`」**。
- **CHANGELOG 随包发布**：`packages/app/CHANGELOG.md` 已在 `files` 中，每个发布版只含该版本日志。程序内「检查更新」时 gateway 从 `https://cdn.jsdelivr.net/npm/tmex-cli@<latest>/CHANGELOG.md` 拉取展示（拉不到则回退「版本号 + 发布时间」，如历史无 changelog 的版本）。
- **程序内自更新**：设置页「版本与更新」触发后，gateway 以 `bun add`（无视缓存）下载目标版本，再 detached 执行 `tmex upgrade --apply-current-package` 完成停服务 → 部署 → 重启。仅 `production` + CLI 安装可用。详见 [自更新与版本展示](../update/2026061406-self-update.md) 与 [发版与 changelog 流程](2026061406-release-changelog-flow.md)。

## 常见错误

### 只跑 `bun run --filter tmex-cli build`

风险：

- 共享 i18n 生成文件可能不是最新。
- 已存在但过期的 `apps/fe/dist` 会被直接打包。

结论：不能作为正式发布前的唯一构建命令。

### 在 `packages/app` 目录直接构建并发布

风险：

- 容易忽略根工作区的前端、共享代码和资源生成步骤。

结论：构建统一在仓库根目录执行；发布命令再切到 `packages/app`。

### 未检查 `npm pack --dry-run`

风险：

- 可能把不完整的 tarball 发到 npm，例如缺少 `dist/runtime` 或 `resources/fe-dist`。

结论：发版前必须看一次 dry-run 结果。

## 最小命令清单

```bash
# 仓库根目录
bun install
bun run release:tmex <newVersion>      # bump 版本 + 生成仅含当前版本的 CHANGELOG
#   → 审阅 packages/app/CHANGELOG.md
bun run build                          # 必须在 bump 之后：版本号在此烧进 bundle
bun run test:tmex
npm pack --dry-run --workspace tmex-cli   # 确认含 dist/resources/CHANGELOG.md

# 提交发版（仓库历史惯例：直接在主分支提交）
git commit -am "chore(release): tmex-cli <newVersion>"

# 登录
npm whoami || npm login

# 发布
cd packages/app
npm publish --access public --tag latest
```

> 也可用根脚本 `bun run publish:tmex`（= `bun run build && npm publish`）一步发布，但它**不含** `release:tmex` 与提交步骤，需自行先 bump+commit。
