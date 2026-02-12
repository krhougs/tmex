# 将 npm 包名从 `tmex` 改为 `tmex-cli`（实现计划）

## 背景与目标

- npm 上 `tmex` 包名已被占用，无法以该名称发布。
- 将 `packages/app` 的发布包名改为 `tmex-cli`。
- 为保持小白体验：
  - 支持 `npx tmex-cli init/doctor/upgrade/uninstall`
  - 仍保留安装后的命令 `tmex ...`
- 同步修复 `upgrade` 的自举升级逻辑（目前硬编码为 `tmex@<version>`）。

## 注意事项

- 先存档，再干活。
- `npx <pkg>` 默认执行与包名同名的 bin；因此发布包名改为 `tmex-cli` 后必须提供 `tmex-cli` 这个 bin 映射。
- `packages/app/src/lib/install-layout.ts` 目前通过字符串包含 `\"name\": \"tmex\"` 判断包根目录，需要改为解析 JSON 并匹配包名/bin，避免硬编码与误匹配。

## 实施步骤

1. 创建归档目录并写入 `plan-prompt.md` / `plan-00.md`。
2. 修改 `packages/app/package.json`：
   - `name: "tmex-cli"`
   - `bin` 同时暴露 `tmex` 与 `tmex-cli` 指向 `./bin/tmex.js`
3. 修改 `packages/app/src/commands/upgrade.ts`：
   - 委托升级从 `tmex@${targetVersion}` 改为 `tmex-cli@${targetVersion}`
4. 修改 `packages/app/src/lib/install-layout.ts`：
   - 解析 `package.json`，匹配 `name === "tmex-cli"`（并校验 `bin`），定位包根目录
   - 可选兼容：允许旧的 `name === "tmex"` 通过，但需同时校验 `bin`，避免误匹配仓库根 `package.json`
5. 修改根 `package.json` scripts：
   - 将 `bun run --filter tmex ...` 改为 `bun run --filter tmex-cli ...`（脚本名保持不变）
6. 更新文档：
   - `README.md`：示例命令改为 `npx tmex-cli ...`
   - `packages/app/README.md`：标题与示例更新，说明安装后可用 `tmex ...`
7. 本地验证：
   - `bun run lint`
   - `bun run test:tmex`
   - `bun run build:tmex`
   - `npm pack --dry-run --workspace tmex-cli`
   - `node packages/app/bin/tmex.js --lang en help`
   - `node packages/app/bin/tmex.js --lang zh-CN help`
8. 写入 `plan-00-result.md` 记录变更与验证结果。

## 验收标准

- `packages/app` 可以以 `tmex-cli` 包名发布到 npm。
- `npx tmex-cli help`（发布后）可工作。
- `tmex upgrade` 自举升级会拉取 `tmex-cli@<version>`。
- 根脚本 `bun run build:tmex` / `bun run test:tmex` 仍可正常运行。

