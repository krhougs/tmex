# 执行结果：将 npm 包名从 `tmex` 改为 `tmex-cli`

## 已完成

- 发布包名已改为 `tmex-cli`：`packages/app/package.json`
- `bin` 同时暴露 `tmex` 与 `tmex-cli`，两者都指向同一入口脚本：`packages/app/package.json`
  - 目的：支持 `npx tmex-cli ...`（`npx` 默认执行同名 bin），同时保留安装后的 `tmex ...` 使用习惯
- `upgrade` 自举升级委托包名已更新：
  - `packages/app/src/commands/upgrade.ts`：`tmex@<version>` -> `tmex-cli@<version>`
- 去除包根定位硬编码：
  - `packages/app/src/lib/install-layout.ts`：不再用字符串包含判断 `\"name\": \"tmex\"`，改为解析 `package.json` 并匹配 `name` + `bin` 结构
- 根脚本 workspace filter 已更新：
  - `package.json`：`bun run --filter tmex ...` -> `bun run --filter tmex-cli ...`（脚本名保持不变）
- 文档示例已更新为 `npx tmex-cli ...`：
  - `README.md`
  - `packages/app/README.md`

## 验证

- `bun run test:tmex`：通过（filter 已切换到 `tmex-cli`）
- `bun run build:tmex`：通过（filter 已切换到 `tmex-cli`）
- `npm pack --dry-run --workspace tmex-cli`：通过，tarball 名称为 `tmex-cli-0.1.0.tgz`
- Node.js CLI smoke：
  - `node packages/app/bin/tmex.js --lang en help`：通过
  - `node packages/app/bin/tmex.js --lang zh-CN help`：通过

## 已知问题 / 说明

- `bun run lint` 当前会因为仓库内其他路径（如 `.worktrees/*`、`apps/fe` 等）存在大量 Biome 格式/导入诊断而失败；本次改名相关文件已单独通过 Biome 检查。

