# 发版与 changelog 流程

## 背景

`tmex-cli` 版本此前为手动 bump（提交 `chore(release): tmex-cli X`），无 CHANGELOG。程序内自更新需要展示目标版本的更新日志，故在 bump 步骤中加入「读 commit 生成 changelog」。

## 设计

- changelog **只含当前版本**：每次发版重写 `packages/app/CHANGELOG.md`，随包发布（已加入 `files`）。
- gateway 检查更新时从 CDN（jsdelivr）拉取目标版本包内的 `CHANGELOG.md` 展示。
- changelog 由自上次 `chore(release)` 提交以来的 commit 按 conventional commit 前缀分组生成。

## 工具

`scripts/release.ts`（根脚本 `release:tmex`）：

```bash
bun run release:tmex <newVersion>
# 等价 bun scripts/release.ts <newVersion>
# 可选：--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>
```

行为：

1. 校验 semver。
2. 默认 commit 范围 = 上一条 `chore(release)` 提交 .. HEAD（可用 `--from/--to` 覆盖）。
3. 按 `feat/fix/perf/refactor/docs` 分组（其余归 Other），排除 `chore(release)` 自身，生成 `packages/app/CHANGELOG.md`（仅当前版本，含日期）。
4. 写 `packages/app/package.json` 的 `version`（`--no-bump` 可跳过）。

## 发版步骤

```bash
bun run release:tmex 0.11.0          # 生成 changelog + bump 版本
# 审阅 packages/app/CHANGELOG.md
git commit -am "chore(release): tmex-cli 0.11.0"
bun run publish:tmex                 # build（含版本 define 注入）+ npm publish
```

## 注意事项

- 版本号注入：`build:runtime` 与 gateway `build` 在构建期把版本写进 bundle（`TMEX_MONOREPO_VERSION`），发布前务必跑完整 `bun run build`（`publish:tmex` 已包含）。
- 0.10.0 之前的版本未随包发布 CHANGELOG，旧版本检查更新时 changelog 会回退为「版本+发布时间」。
