# 发版 changelog 与版本注入（设计说明）

> 操作步骤以 [tmex-cli 发布流程](2026041300-cli-release-process.md) 为准；本文只记录 2026-06-14 引入的 changelog 生成与版本注入机制的设计与缘由。

## 背景

`tmex-cli` 版本此前手动 bump（提交 `chore(release): tmex-cli X`），仓库无 CHANGELOG。程序内自更新（见 [自更新与版本展示](../update/2026061406-self-update.md)）需要展示「目标版本」的更新日志，故在 bump 步骤中加入「读 commit 生成 changelog」。

## 设计要点

- **changelog 只含当前版本**：每次发版重写 `packages/app/CHANGELOG.md`（已加入包 `files`），随包发布。这样 gateway 检查更新时直接拉「目标版本包内」的 CHANGELOG 即可，无需跨版本聚合。
- **来源**：commit 范围 = 上一条 `chore(release)` 提交 .. HEAD，按 conventional commit 前缀分组（feat/fix/perf/refactor/docs，其余 Other），排除 `chore(release)` 自身。
- **展示**：gateway 从 `https://cdn.jsdelivr.net/npm/tmex-cli@<latest>/CHANGELOG.md` 拉取（`no-store`）；失败回退「版本号 + 发布时间」（npm registry `time`），覆盖历史无 changelog 的旧版本。
- **版本注入**：版本号在 `bun run build` 期由 `bun build --define TMEX_MONOREPO_VERSION` 烧进 runtime bundle（`packages/app/scripts/build-runtime.ts`、docker 走 `apps/gateway/scripts/build.ts`），前端走 vite `define`。**故发版顺序必须「先 bump 再 build」**。

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
