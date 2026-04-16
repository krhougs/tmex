# Plan 00 执行结果：dual npm release

时间：2026-04-16

## 完成内容

### 1）完成双包版本与包名调整

- 修改文件：`packages/ghostty-terminal/package.json`
  - 包名从 `@tmex/ghostty-terminal` 改为 `ghostty-terminal`
  - 版本改为 `0.3.0`
  - 新增 `publishConfig.access = public`
  - 新增最小 `files = ["src"]`

- 修改文件：`packages/app/package.json`
  - `tmex-cli` 版本改为 `0.3.0`

- 同步修改工作区引用：
  - `apps/fe/package.json`
  - `apps/fe/src/components/terminal/Terminal.tsx`
  - `apps/fe/src/components/terminal/types.ts`
  - `apps/fe/src/components/terminal/useTerminalResize.ts`
  - `docs/terminal/2026041600-ghostty-wasm-runtime.md`

- 运行 `bun install` 更新工作区解析与 lockfile。

### 2）完成发布前校验

#### ghostty-terminal

- `bun test packages/ghostty-terminal/scripts/ghostty-wasm.test.ts`：通过
- `bun run --cwd packages/ghostty-terminal verify:wasm`：通过
- `bun test packages/ghostty-terminal/src/terminal.canvas.test.ts`：通过
- `npm pack --dry-run`（在 `packages/ghostty-terminal`） ：通过
  - tarball 名称：`ghostty-terminal-0.3.0.tgz`
  - tarball 中包含 wasm 与 metadata

#### tmex-cli

- `bun run build`（仓库根目录全量构建）：通过
- `bun run test:tmex`：通过
- `npm pack --dry-run --workspace tmex-cli`：通过
  - tarball 名称：`tmex-cli-0.3.0.tgz`
  - tarball 中包含 `dist`、`resources/fe-dist`、`resources/gateway-drizzle`

### 3）尝试实际发布

#### ghostty-terminal

- 命令：`npm publish --access public`
- 结果：失败
- npm 返回：
  - `E404 Not Found - PUT https://registry.npmjs.org/ghostty-terminal - Not found`

#### tmex-cli

- 命令：`npm publish --access public --tag latest`
- 结果：失败
- npm 返回：
  - `E404 Not Found - PUT https://registry.npmjs.org/tmex-cli - Not found`

## 结论

代码与包配置侧已经准备完毕，两个包的发布前校验都通过；真正阻塞点发生在 npm registry 发布阶段，而不是构建或打包阶段。当前环境下无法成功 publish 的直接证据包括：

- 之前 `npm whoami` 返回 `401 Unauthorized`
- 本轮两个包的 `npm publish` 都返回 registry 侧 `E404`，说明当前账号/令牌对目标包名的创建或发布没有可用权限，或当前环境并未正确完成 npm 登录。

## 后续建议

1. 先在当前机器完成 `npm login`，并确认：
   - `npm whoami` 返回正常用户名
2. 如果仍然是 `E404`：
   - 检查当前账号是否有权创建 `ghostty-terminal` 与 `tmex-cli`
   - 检查这两个名字是否有额外的所有权/组织限制
3. 登录与权限确认无误后，重新执行：
   - `cd packages/ghostty-terminal && npm publish --access public`
   - `cd packages/app && npm publish --access public --tag latest`
