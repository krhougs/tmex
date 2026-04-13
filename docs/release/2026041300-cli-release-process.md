# tmex-cli 发布流程

## 背景

`tmex-cli` 的 npm 包源码位于 `packages/app`，但最终发布内容不只包含 CLI 入口，还包含以下产物：

- `packages/app/dist/cli-node.js`：Node 侧 CLI 入口。
- `packages/app/dist/runtime/server.js`：Bun 运行时入口，内部会打包 gateway 运行时代码。
- `packages/app/resources/fe-dist`：前端静态资源。
- `packages/app/resources/gateway-drizzle`：gateway 数据库迁移文件。

因此，发布前不能只关注 `packages/app` 本身，必须确保根工作区内依赖发布包的产物全部重新生成。

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

### 1. 更新版本号

修改 `packages/app/package.json` 中的 `version` 字段。

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

- `npm pack --dry-run` 输出中必须包含 `dist` 与 `resources`。
- `resources/fe-dist` 中应包含最新前端静态资源。
- `resources/gateway-drizzle` 中应包含迁移文件。

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
bun run build
bun run test:tmex
npm pack --dry-run --workspace tmex-cli

# 登录
npm whoami || npm login

# 发布
cd packages/app
npm publish --access public --tag latest
```
