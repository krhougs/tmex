# Plan-00 执行结果 — 完善更新功能

## 完成情况（9/9 需求 + 发版流程）

| # | 需求 | 实现 |
|---|---|---|
| 1 | AGENTS.md 升级表述 | 改为 `npx tmex-cli@version upgrade`（终端执行） |
| 2 | 设置页独立版本 section | 新增「版本与更新」Tab（`apps/fe/src/components/settings/version-tab.tsx`） |
| 3 | 安装方式检测 | `apps/gateway/src/system/install-info.ts`：CLI?/launchd/systemd/none |
| 4 | 前端 console + 后端启动日志 | FE `main.tsx` console.info；gateway `index.ts` + runtime `server.ts` 启动日志 |
| 5 | 检查更新 + changelog + 确认弹窗 | 查 npm registry + CDN changelog；弹窗警告中断访问/影响 tmux |
| 6 | 唯一升级状态机 | `UpgradeController`：idle/downloading/executing |
| 7 | 升级无视缓存 | 全新 `BUN_INSTALL_CACHE_DIR` 临时目录 |
| 8 | 非 production → `_dev` + 禁更新 | `formatDisplayVersion`；`canSelfUpdate` 含 `isProd` 闸门 |
| 9 | 非 CLI 安装禁更新 | `canSelfUpdate` 含 `installedViaCli` 闸门 |
| + | 发版生成 changelog | `scripts/release.ts`（读 commit，仅含当前版本）+ `packages/app/CHANGELOG.md` 随包发布 |

## 关键实现

- **版本注入**：`packages/app/scripts/build-runtime.ts`、`apps/gateway/scripts/build.ts` 构建期 `--define TMEX_MONOREPO_VERSION`；dev 回退读仓库 package.json；vite `define __MONOREPO_VERSION__/__IS_PROD__`。docker builder 增 `COPY packages/app/package.json`。
- **升级两阶段**：`bun add tmex-cli@ver`（fresh cache）→ detached spawn 下载包 `bin/tmex.js upgrade --apply-current-package`，靠 `KillMode=process`/`AbandonProcessGroup` 在服务重启时存活。
- **新类型**：`@tmex/shared` 增 `SystemInfo/UpdateCheckResult/UpgradeStatus/GatewayDeployment/UpgradeState` + `formatDisplayVersion`。
- **API**：`/api/system/{info,update-check,upgrade(GET/POST)}`。

## 验证

- dev/prod-CLI/prod-非CLI 三路径 `getSystemInfo` 直测：版本/安装方式/canSelfUpdate 正确。
- 真实 npm `bun add tmex-cli@0.10.0`（fresh cache）成功，下载包含 `bin/tmex.js` + `dist/runtime` + `resources/{fe-dist,gateway-drizzle}`。
- 真实 npm registry update-check 直测通过。
- 经 `createGatewayRuntime` 的 HTTP 端到端：info 200 / upgrade idle / POST 403(dev 闸门) / 未知路径 404 回退。
- FE/gateway tsc 我的文件 0 错误（gateway 既有 tsc 错误均在未触碰文件，pre-existing）；biome 我的文件干净。
- 全量 `bun run build:tmex` 通过，define 注入到最终 bundle。

## 对抗式 review（4 维度 × 独立验证，16 raw → 5 confirmed / 11 rejected）

已修复：
- **双 toast bug**（version-tab 完成检测 effect 两个独立 `if state===idle`）→ 改为 if/else 链，error 与 success 互斥。
- **bun add 产物未校验**（detached 子进程无法回报错误）→ 执行前 `existsSync(binPath)` 校验，缺失则趁本进程存活报错回 idle。

未采纳（理由）：
- zh_CN `apiError.notFound`/`websocket.upgradeFailed` 等未翻译：pre-existing（commit 1afddde / 更早），属仓库既有 i18n 缺口，超本特性范围。
- 「minimal package.json」：verifier 自身结论为无需改动。
- 11 项 rejected 均为误报（fd close-after-spawn、XDG env、cleanup race、refetchInterval 闭包、removeQueries API 等经核验均正确）。

## 遗留 / 提示

- 仓库存在一批 pre-existing 未翻译 zh_CN 字符串（notFound/upgradeFailed/deviceNotFound/urlAndSecretRequired/invalidMessage 等），建议另起 i18n 清理任务统一处理，未在本特性改动。
- 0.10.0 之前版本未随包发布 CHANGELOG，旧装机检查更新时 changelog 回退为「版本+发布时间」。
- 升级执行阶段失败回滚后，前端只能观察到「仍是旧版本」，符合三状态规约（不跨重启上报 execute 阶段错误）。
