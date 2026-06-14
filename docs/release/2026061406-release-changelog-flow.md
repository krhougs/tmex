# 发版 changelog 与版本注入（设计说明）

> 操作步骤以 [tmex-cli 发布流程](2026041300-cli-release-process.md) 为准；本文只记录 2026-06-14 引入的 changelog 生成与版本注入机制的设计与缘由。

## 背景

`tmex-cli` 版本此前手动 bump（提交 `chore(release): tmex-cli X`），仓库无 CHANGELOG。程序内自更新（见 [自更新与版本展示](../update/2026061406-self-update.md)）需要展示「目标版本」的更新日志，故在 bump 步骤中加入「读 commit 生成 changelog」。

## 设计要点

- **两阶段：脚本生成草稿 → agent 改写为人话**。`release.ts` 生成的是「commit 原文草稿」（带 `## Features`、commit hash 等工程黑话），**不直接发布**；必须由 agent 改写为面向普通用户的说明后才发布。展示给终端用户的是改写后的版本。
- **changelog 只含当前版本**：每次发版重写 `packages/app/CHANGELOG.md`（已加入包 `files`），随包发布。这样 gateway 检查更新时直接拉「目标版本包内」的 CHANGELOG 即可，无需跨版本聚合。
- **草稿来源**：commit 范围 = 上一条 `chore(release)` 提交 .. HEAD，按 conventional commit 前缀分组（feat/fix/perf/refactor/docs，其余 Other），排除 `chore(release)` 自身。
- **DRAFT 护栏**：草稿首行是 HTML 注释 `<!-- DRAFT… -->`。漏改写时它不会在前端 markdown 渲染中显示（不污染用户视图），但维护者在文件 / `npm pack` 里仍可见——发布前确认它已被删除即代表改写完成。
- **展示**：gateway 从 `https://cdn.jsdelivr.net/npm/tmex-cli@<latest>/CHANGELOG.md` 拉取（`no-store`）；失败回退「版本号 + 发布时间」（npm registry `time`），覆盖历史无 changelog 的旧版本。
- **版本注入**：版本号在 `bun run build` 期由 `bun build --define TMEX_MONOREPO_VERSION` 烧进 runtime bundle（`packages/app/scripts/build-runtime.ts`、docker 走 `apps/gateway/scripts/build.ts`），前端走 vite `define`。**故发版顺序必须「先 bump 再 build」**。

## 改写规范（agent 步骤）

跑完 `release.ts` 后，让 agent 按以下规范把 `packages/app/CHANGELOG.md` 草稿改写为终端用户能看懂的人话：

- **受众是普通用户，不是工程师**：去掉 commit hash、scope（如 `(fe)`）、conventional 前缀（`feat:`/`fix:`）、以及实现细节黑话（rsync、SSH 握手、middleware、文件路径等）。
- **讲「用户能感知到的价值/变化」**，而非「改了什么代码」。一条 commit 可能合并/拆分为更贴近用户的描述；纯内部重构/测试/构建类（无用户可感变化）可省略。
- **按用户视角分组**：如「新增 / 改进 / 修复」，而非 Features/Refactoring。
- **保留版本号标题与日期**；**删除首行 DRAFT 标记**。
- **语言**用产品主要受众语言（简体中文）；可按需补英文。
- 控制篇幅，每条一句话讲清楚；重大变更可加一句影响说明（如本次自更新会中断访问）。

示例（本仓库 0.10.0）：草稿 `## Features\n- feat(files): Files Tab — 本地 + SSH/rsync 文件浏览 (`1afddde`)` → 改写为 `## 新增\n- 文件浏览（Files）：现在可以直接在 tmex 里浏览本机和远程服务器上的文件…`。

## 工具

`scripts/release.ts`（根脚本 `release:tmex`）：

```bash
bun run release:tmex <newVersion>
# 可选：--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>
```

行为：校验 semver → 取 commit 范围分组 → 写 `packages/app/CHANGELOG.md`（仅当前版本，含日期）→ 写 `packages/app/package.json.version`（`--no-bump` 跳过）。

## 注意事项

- 0.10.0 之前的版本未随包发布 CHANGELOG，旧装机检查更新时 changelog 会回退为「版本 + 发布时间」。
- `release.ts` 在真实开发机运行，使用 `Date` 取当天日期；可用 `--date` 覆盖以复现/补录。
