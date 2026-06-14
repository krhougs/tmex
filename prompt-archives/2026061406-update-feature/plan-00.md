# Plan-00 — 完善更新功能

## 背景

tmex 通过 `tmex-cli`（`packages/app`，npm 包名 `tmex-cli`，当前 0.10.0）发布。安装/升级链路：

- `npx tmex-cli init` → `runInit`：部署 runtime（`dist/runtime/server.js`，内联打包了 `apps/gateway`）+ `resources/fe-dist` + `gateway-drizzle` 到安装目录，写 `app.env`、`run.sh`、`install-meta.json`，安装服务（macOS=launchd / Linux=systemd）。
- `npx tmex-cli upgrade`（无 `--apply-current-package`）→ `delegateUpgrade`：`npx --yes tmex-cli@<version> upgrade --apply-current-package`。
- `--apply-current-package` 分支：停服务 → 备份 → 部署新产物 → 写 run.sh/meta → 装服务（重启）→ 健康检查；失败回滚。
- 服务 unit：systemd `KillMode=process`、launchd `AbandonProcessGroup=true` —— **为自升级时子进程脱离服务进程组存活而设计**。

「monorepo 版本」= `tmex-cli` 版本（手动 bump，commit `chore(release): tmex-cli X`）。仓库无 CHANGELOG、无 release tooling。还存在 docker 部署（非 CLI）。

三套环境：dev（`apps/gateway/src/index.ts` + vite，`--watch` 源码）/ test / production（安装版 `dist/runtime/server.js`，`run.sh` export `TMEX_FE_DIST_DIR`、`TMEX_MIGRATIONS_DIR`，cwd=installDir）。`config.isProd = NODE_ENV==='production'`。

## 目标（对应 9 项需求）

1. 修正 `AGENTS.md` 终端升级表述为 `npx tmex-cli@version upgrade`。
2. 设置页新增独立「版本/关于」section（新 Tab），展示版本 + 手动更新。
3. 服务端提供安装方式检测：是否 CLI 安装、部署方式 launchd/systemd/none。
4. 前端 console 打印 monorepo 版本；后端启动日志输出 monorepo 版本。
5. 检查更新：gateway 直接查 npm registry 取 `tmex-cli` 最新版 + changelog；前端展示，提供「确认升级」按钮（弹窗警告会中断访问、可能影响 tmux 存活）。
6. 服务端管理唯一升级状态机：`idle / downloading / executing`。
7. 升级调用下载器（bun）无视缓存。
8. NODE_ENV≠production：版本显示为 `monorepoVer_dev`，并禁用程序内更新。
9. 非 CLI 安装：禁用程序内更新。

## 设计

### 版本真相源与注入

- 真相源：`packages/app/package.json` 的 `version`。
- 纯函数 `formatDisplayVersion(base, isProd)`（`@tmex/shared`，浏览器安全）：`isProd ? base : `${base}_dev``。
- **前端**：`vite.config.ts` 读 `packages/app/package.json`，`define` 注入 `__MONOREPO_VERSION__`、`__IS_PROD__`（`mode==='production'`）。`main.tsx` 启动 `console.info` 打印。
- **gateway**：`getMonorepoVersion()` 分层取值：
  1. bundle 注入的 `TMEX_MONOREPO_VERSION`（`typeof` 守卫）—— 主生产路径（runtime bundle / docker 都注入）。
  2. production 下读 `installDir/install-meta.json.cliVersion`（兜底）。
  3. dev/test 读仓库 `packages/app/package.json`。
  4. 都失败 → `unknown`。
  - runtime bundle 注入：`packages/app/scripts/build-runtime.ts`（读 package.json version，spawn `bun build ... --define TMEX_MONOREPO_VERSION="x.y.z"`）替换 `build:runtime`。
  - docker：`apps/gateway` 增 `scripts/build.ts` 读 `../../packages/app/package.json`，Dockerfile builder 增 `COPY packages/app/package.json`。

### 安装方式检测（`apps/gateway/src/system/install-info.ts`）

- installDir：优先由 `TMEX_FE_DIST_DIR` 反推（`resolve(feDir,'../..')`），回退 `process.cwd()`。
- 读 `installDir/install-meta.json`：存在且可解析 → `installedViaCli=true`，取 `serviceName/cliVersion/platform`；`deployment = platform==='darwin'?'launchd':platform==='linux'?'systemd':'none'`。
- 不存在（docker/手动/dev）→ `installedViaCli=false`，`deployment='none'`。
- `canSelfUpdate = config.isProd && installedViaCli && deployment!=='none'`。

### 升级状态机 + 执行（`apps/gateway/src/system/upgrade.ts` 单例 `UpgradeController`）

- 状态：`idle / downloading / executing`，附 `targetVersion / error / startedAt`。
- 触发（仅 `canSelfUpdate`，且当前 `idle`）：
  1. `downloading`：`mkdtemp` 工作目录 + 全新 `BUN_INSTALL_CACHE_DIR`（无视缓存），写最小 package.json，`process.execPath`（bun）`add tmex-cli@<version>`。失败 → 回 `idle` + error（此阶段 gateway 仍存活，可上报）。
  2. `executing`：`spawn(process.execPath, [<stage>/node_modules/tmex-cli/bin/tmex.js, 'upgrade','--apply-current-package','--install-dir',installDir,'--version',version], { detached:true, stdio:'ignore', env:process.env })` + `unref()`。子进程停服务（杀掉 gateway）→ 部署 → 重启。新 gateway 启动即 `idle`（=成功，前端重连看到新版本）。
- 单例：并发触发返回 409。

### API（`apps/gateway/src/api/system.ts`，挂到 `api/index.ts`）

- `GET /api/system/info` → `SystemInfo`（version 显示值、baseVersion、isProd、installedViaCli、deployment、canSelfUpdate、serviceName）。
- `GET /api/system/update-check` → `UpdateCheckResult`（查 registry 取 latest+publishedAt，比较 semver；CDN 拉 changelog markdown，失败 null）。`no-store`。
- `GET /api/system/upgrade` → `UpgradeStatus`（轮询）。
- `POST /api/system/upgrade` `{version}` → 启动；非法/非 prod/非 CLI → 403；忙 → 409。

### 前端

- `SettingsPage` 新增 Tab `version`（`settings.version.title`）：当前版本、安装方式、检查更新按钮 → 展示 latest + changelog（markdown 复用 `markdown-preview`）+ 升级按钮（`!canSelfUpdate` 禁用并给原因）。升级 AlertDialog 警告中断访问/影响 tmux。POST 后轮询状态，连接断开/重连后刷新 `info` 显示新版本。
- `main.tsx` 启动 `console.info('tmex <displayVersion>')`。
- `vite-env.d.ts` 声明 `__MONOREPO_VERSION__`、`__IS_PROD__`。

### 发版流程（`scripts/release.ts`）

- `bun scripts/release.ts <newVersion>`：
  1. 校验 semver。
  2. 找上次 release commit（`git log --grep '^chore(release)' -n1`），取 `range..HEAD` commit。
  3. 按 conventional commit 前缀分组，生成**仅含当前版本**的 `packages/app/CHANGELOG.md`（版本号、日期、分组列表）。
  4. 写 `packages/app/package.json` version。
- `packages/app` `files` 增 `CHANGELOG.md`。
- 文档 `docs/release/` 记录新流程。

## 任务清单

- [ ] shared：`version.ts`（`formatDisplayVersion`）+ 类型（`SystemInfo/UpdateCheckResult/UpgradeStatus/GatewayDeployment/UpgradeState`）+ 从 index 导出。
- [ ] shared i18n：en/zh/ja 增 `settings.version.*`、`apiError.*`；`build:i18n`。
- [ ] gateway：`system/version.ts`、`system/install-info.ts`、`system/upgrade.ts`、`api/system.ts`，挂路由；`index.ts` + runtime `server.ts` 启动日志。
- [ ] packages/app：`scripts/build-runtime.ts` 注入 define；`build:runtime` 改写；`CHANGELOG.md` + `files`；`scripts/release.ts`。
- [ ] apps/gateway：`scripts/build.ts` 注入 define + Dockerfile COPY。
- [ ] fe：`vite.config.ts` define + dts；`main.tsx` console；`SettingsPage` 版本 Tab + API client。
- [ ] AGENTS.md 修正。
- [ ] 文档：`docs/update/2026061406-self-update.md`、`docs/release/`。
- [ ] 验证：build:i18n、tsc/biome、仓库内临时实例冒烟、对抗式 review。

## 验收标准

- dev 前端 console 与后端启动日志均出现 `X.Y.Z_dev`；设置页版本 Tab 显示 `_dev` 且升级按钮禁用（原因：非 production）。
- 模拟 CLI 安装（写 install-meta.json）的临时 prod 实例：`/api/system/info` 返回 `installedViaCli=true`、正确 deployment、`canSelfUpdate=true`。
- `/api/system/update-check` 能从 npm 取到 latest 与（若已发布）changelog。
- 升级状态机：触发后 `downloading`→`executing`；非法触发 403/409。
- `scripts/release.ts <ver>` 生成仅含该版本的 CHANGELOG 并 bump 版本。
- `bun build`（含 define 注入）产物含正确版本。

## 风险与注意事项

- **严禁触碰生产 tmex**：所有验证在仓库内临时实例（显式覆盖 env），不碰 9883/安装目录/launchd。
- 升级子进程必须 `detached + unref`，依赖 `KillMode=process`/`AbandonProcessGroup` 存活；env 透传以便 launchctl/systemctl 可用。
- 升级执行阶段跨重启，失败回滚后前端只能观察到「仍是旧版本」，不强求跨重启错误上报（符合三状态规约）。
- 生成文件（i18n resources.ts）不手动 lint；改 locale JSON 后跑 `build:i18n`。
- changelog 随包发布，仅当前版本；旧版本（如 0.10.0）无 CHANGELOG → CDN 404 → 回退版本+日期列表。
