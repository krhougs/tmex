# Plan 00：dual npm release

## 背景

当前仓库需要同时发布两个 npm 包：`ghostty-terminal` 与 `tmex-cli`。其中 `tmex-cli` 已经有既有发布流程与线上版本，包源码位于 `packages/app`；而 Ghostty 终端包当前仍使用工作区内名称 `@tmex/ghostty-terminal`，需要先纠正包名并确保 monorepo 内部依赖与导入路径同步，再作为 `ghostty-terminal@0.3.0` 首次发布。

## 注意事项

- 先归档，再改代码。
- 只处理 `ghostty-terminal` 与 `tmex-cli` 两个包，不扩大到其他包的版本策略。
- `ghostty-terminal` 改名后，工作区依赖与源码导入必须一起收敛。
- 真正执行 `npm publish` 前，必须经过 `npm pack --dry-run` 与必要构建/测试校验。
- 当前 `npm whoami` 返回 401，发布可能被登录态阻塞。

## 任务清单

1. 将 `packages/ghostty-terminal/package.json` 改为 `ghostty-terminal@0.3.0`，补齐 `publishConfig` 与最小 `files` 配置。
2. 同步更新 `apps/fe` 中对该工作区包的依赖与源码导入。
3. 将 `packages/app/package.json` 的 `tmex-cli` 版本更新到 `0.3.0`。
4. 运行 `ghostty-terminal` 的最小发布校验：测试、`verify:wasm`、`npm pack --dry-run`。
5. 按现有文档流程运行 `tmex-cli` 的发布前构建与 `npm pack --dry-run` 校验。
6. 尝试发布两个包；若被 npm 登录或权限阻塞，记录阻塞结果。
7. 将结果写入归档文件。

## 验收标准

- `ghostty-terminal` 包名与版本已改成目标值，且工作区内引用全部同步。
- `tmex-cli` 版本已更新到目标值。
- 两个包都完成 `npm pack --dry-run`。
- 若 npm 登录可用，则两个包发布成功；若不可用，则明确记录阻塞点与已完成的校验。

## 风险评估

- `ghostty-terminal` 改名会影响 `apps/fe` 的依赖解析与源码导入，必须同步修改。\n- `tmex-cli` 发布需要根目录全量构建，否则 tarball 可能打入旧资源。\n- npm 认证失败会阻塞真正发布，但不影响版本变更与发布前校验完成。
