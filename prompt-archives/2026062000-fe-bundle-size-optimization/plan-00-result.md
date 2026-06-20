# 执行结果

分支：`worktree-fe-bundle-size`（基于 main 66afc25）。目标：减小前端包体积（非压缩），优先首屏。

## 实测收益

| 指标 | 基线 | 优化后 | 变化 |
|---|---|---|---|
| **首屏 index.js (raw)** | 1246 KB | **878 KB** | **−368 KB / −30%** |
| **首屏 index.js (gzip)** | 384 KB | **272 KB** | **−112 KB / −29%** |
| dist 总体积（含 .map） | ~41 MB | **28 MB** | 关 sourcemap 去掉 ~18MB .map |

（用新增的 `bun --cwd apps/fe run build:analyze` / `dist/stats.html` treemap 量化，非估算。）

## 改动

1. **Step 0 — bundle visualizer**（`vite.config.ts` + `apps/fe` devDep `rollup-plugin-visualizer` + `build:analyze` 脚本，`ANALYZE` 门控）。建立基线、量化每步。

2. **Step 1 — i18n 按需加载当前语言**（首屏最大可削项）：`apps/fe/src/i18n/index.ts` 从静态 `import I18N_RESOURCES`（3 语言全打进首屏）改为 `import.meta.glob` + `i18next-resources-to-backend` 动态按 locale 加载；每个 locale 拆独立 chunk（en_US 34KB / zh_CN / ja_JP 44KB），首屏只加载当前语言。`main.tsx` 渲染前 `await i18nReady`（带 catch 兜底，弱网失败也渲染）。**网关聚合 `I18N_RESOURCES`、生成器、`resources.ts` 均未动**——server 不受影响，不碰生成文件。

3. **Step 2 — sidebar tab 懒加载**：`app-sidebar.tsx` 的 `AgentTab`/`FilesTab` 改 `React.lazy` + `Suspense`，把 agent/files 两个子系统移出首屏 entry chunk（各成 ~25-28KB 懒 chunk + 抽出一个 ~153KB 共享懒 chunk）。默认 `panes` 设备列表保持 eager。

4. **Step 4 — 生产构建关 sourcemap**：`vite.config.ts` `sourcemap` 改 `BUILD_SOURCEMAP==='1' || !isProd`。生产默认不出 ~18MB .map（随 `resources/fe-dist` 分发的纯负担），dev 保留，排障可 `BUILD_SOURCEMAP=1` 开。

## 明确未做（grounded，避免无用功 / UX 退化）

- **Step 3 highlight.js 限定语言：放弃。** `rehype-highlight@7` 用 `{detect:true}` 已默认 lowlight `common`（~37 种），**不是** 探查 agent 声称的 190 种；进一步裁剪只省懒 chunk 一点点、却会让未列语言代码块失去高亮（UX 退化），不值。
- **lucide 替换：放弃。** 全 named import 已被 esbuild 摇树，仅 ~35 个用到的图标进 bundle，非问题。
- **react-query dedupe：放弃。** 双版本是跨 workspace，FE bundle 只含自身解析的一份，首屏无收益。
- **manualChunks / 压缩：未做。** 前者利缓存非利体积；后者用户明确否定。

## 验证

- `tsc` 通过；`bun test apps/fe/src` 87 pass / 0 fail；biome 改动文件仅剩 1 个 **pre-existing** `useExhaustiveDependencies`（main.tsx StatusBarSync 的 theme dep，HEAD 即有、非本次改动），零新增。
- 无头浏览器 smoke（vite preview 服务 production dist + Chromium）：默认语言渲染正常、**无 raw i18n key、无 FOUC**；Agent/Files tab 点击懒加载正常渲染；除预期的无网关 `/api` 失败外无 JS 错误。截图留证。

## 注意 / 限制

- 非默认语言用户首次加载「当前语言 + en_US(fallback)」两个 locale chunk（init 一次性 await）。
- worktree 需 `bun install --frozen-lockfile`（per-workspace node_modules）。
- 运行时切语言（settings）由 `i18next-resources-to-backend` 按需拉取新 locale chunk。
