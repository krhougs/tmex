# 计划：bun 路径解析重构（issue #28 真因修复 + 显式传入 + 持久化）

## Context（背景与动机）

GitHub issue #28 报告"macOS Homebrew 安装的 bun 检测不到"，但经核验**诊断错误**：

- issue 贴出的报错是 `Bun check failed: Failed to execute bun --version` 且**带出了路径 `/opt/homebrew/bin/bun`**。该报错对应 `checkBunVersion()` 的 `bun.versionExecFailed` 分支，只有 `findBunBinary()` **成功返回非空路径**时才会带路径——即 bun **已被检测到**，失败在"执行这个路径"那一步。
- 真因（已用受控实验端到端复现）：`locateBunFromShell()` 执行 `zsh -lic 'command -v bun'`，`-i`（交互式）会加载 `.zshrc`，prompt 框架/instant-prompt/banner 等会向 stdout 输出 ANSI 控制序列，污染 `command -v bun` 的结果。`trim()` 去不掉非空白控制字符，于是返回的 `bunPath` 字符串夹带控制字符；doctor 打印时控制序列（如 `ESC[2K\r`）让终端显示"看起来干净"，但 `spawn(该字符串)` 因字面路径不存在而 ENOENT → `versionExecFailed`。
- issue 建议的修复（"在 `locateBunFromShell()` 之后插入 homebrew 路径检查"）**无效**：`findBunBinary()` 是 `const zshBin = await locateBunFromShell(); if (zshBin) return zshBin;`，污染场景下 `zshBin` 非空会短路，后插的代码永不执行。

跨平台同类隐患（比 issue 范围更大）：

1. `locateBunFromShell` 硬编码 `zsh`，而 tmex 官方支持 Linux（`platform.ts:11-13`，systemd），Linux 默认 shell 是 bash 且常无 zsh → 第一跳直接失效。
2. fallback 链里只有 `~/.bun/bin`（官方 curl 安装）是稳的；Homebrew(`/opt/homebrew/bin`、`/usr/local/bin`)、linuxbrew、npm 全局均无专属兜底。
3. `upgrade.ts:98` 升级时**重新探测**，在 launchd/systemd 极简 PATH 下会重新踩同一个坑。
4. `InstallMeta`（`types.ts:27-34`）**没存 bunPath**，导致每个命令各自现场探测。
5. `install.ts:75-82` 的 run.sh PATH 补丁只补 `~/.bun/bin`，若 bunPath 落到字面量 `'bun'`，homebrew 安装的服务可能起不来。
6. `bun.ts` 无任何单测。

**期望结果**：bun 路径从"每个命令各自现场探测"改为"安装期一次性确定 → 持久化到 meta → 后续复用"，并允许显式传入；探测仅作兜底且修健壮。**用户已确认采用此方案（安装期定 + 存 meta + 复用）。**

## 设计：bun 路径来源优先级

定义统一解析（每个候选取得后都过 `validateBun`：净化 → `existsSync` → 能跑 `--version` → 版本达标，不过则继续下一候选）：

1. **显式** `--bun-path` flag / `TMEX_BUN_PATH` env（最高优先，用户/上游指定）
2. **`process.versions.bun` 存在 → `process.execPath`**：cli 被 bun 拉起（自更新链路 `gateway spawn(execPath=bun, [binPath,...])`），此 path 100% 是正确 bun。已验证：bun 运行时 `process.versions.bun` 有值、node 下为 `undefined`、bun 执行带 node-shebang 的 .js 时仍有值。
3. **`meta.bunPath`**：init 持久化的路径（新装用户）
4. **健壮探测**：兜底（手动 `npx upgrade` 且旧 meta 无 bunPath、首次 init）

## 兼容性（现有用户）

**前提：升级本来就会重写 metadata。** `upgrade.ts` 现状是 `readJsonFile<InstallMeta>` → 改字段 → `writeInstallMeta` 重写（`upgrade.ts:103,116-118`，沿用 init 时的 serviceName/autostart/installDir/platform）。因此 **`bunPath` 只需纳入这次重写的字段**——"旧 meta 无 bunPath"只是升级前的一次性过渡态，**任何一次升级都会把它补齐**，无需特殊的"探测兜底回写"逻辑。

那"升级这一次"用哪个 bun（并写进重建的 meta）：

| 场景 | 这次升级用的 bun 来源 | 说明 |
|---|---|---|
| **现有用户·网页自更新** | **#2 `process.execPath`** | 新 cli 被旧 gateway 用 bun 拉起，`process.versions.bun` 有值 → 确定性正确，**不依赖旧 meta、不依赖旧 gateway 改动**，写入重建 meta |
| 现有用户·手动 `npx tmex-cli upgrade` | #4 健壮探测（或 #1 显式） | execPath=node、旧 meta 无 bunPath → 探测，但已修健壮，结果写入重建 meta |
| 新装用户 init | #1 显式 / #4 探测 → 写 meta | 一开始就有 meta.bunPath |
| doctor（已装） | #3 meta.bunPath（升级前的旧装机若缺 → #4 探测） | 升级一次后必定命中 #3 |

关键：**现有用户最常用的"网页自更新"通过 #2 确定性修复，无需他们做任何事**；升级重写 meta 时顺带补齐 bunPath。gateway 侧 `InstallMetaShape.bunPath` 为可选，旧 meta 读出 `undefined` 不影响既有逻辑。

## 改动清单

### 1. `packages/app/src/lib/bun.ts`（核心）
- 新增 `sanitizeBunPath(raw)`：去 ANSI（`\x1b\[[0-9;]*[a-zA-Z]`）+ 控制字符 + 取最后一行 + trim。
- 新增 `validateBun(path, minVersion)`：净化 → `existsSync`（裸 `bun` 除外，留给 PATH）→ `runCommand(path,['--version'])` → 版本比对，返回 `{ok, version}`。
- `locateBunFromShell()`：净化输出并校验，校验不过返回 null（不再把污染串当路径）；zsh 失败继续（已 catch）。
- 新增硬路径候选常量：`/opt/homebrew/bin/bun`、`/usr/local/bin/bun`、`/home/linuxbrew/.linuxbrew/bin/bun`、`~/.bun/bin/bun`。
- 新增 `resolveBunPath(opts: { explicitPath?; metaBunPath? })`：按 #1→#2→#3→#4 返回首个通过 `validateBun` 的路径（#4 内含 zsh 解析 + 硬路径候选 + PATH `bun`）。
- `checkBunVersion(minVersion?, opts?)` 改为调用 `resolveBunPath` + `validateBun`，透传 `explicitPath` / `metaBunPath`。保持现有返回结构 `BunCheckResult`。

### 2. `packages/app/src/types.ts`
- `InstallMeta` 增 `bunPath: string`。

### 3. `packages/app/src/commands/init.ts`
- 读 `--bun-path`（`asString(parsed.flags['bun-path'])`）/ `process.env.TMEX_BUN_PATH`。
- `checkBunVersion(undefined, { explicitPath })`。
- meta 对象增 `bunPath: bun.path`（`init.ts:197-205`）。

### 4. `packages/app/src/commands/upgrade.ts`
- 读 `--bun-path` / `TMEX_BUN_PATH`，先读 meta 拿 `meta.bunPath`。
- 把裸 `checkBunVersion()`（`:98`）改为 `checkBunVersion(undefined, { explicitPath, metaBunPath: meta.bunPath })`。
- meta 重写时（现有 `meta.updatedAt/cliVersion` 赋值处 `:116-118`）加 `meta.bunPath = bun.path`——沿用现有"升级重写 metadata"机制，自然补齐旧 meta，无需额外逻辑。

### 5. `apps/gateway/src/system/upgrade.ts`（自更新显式加固，非兼容必需）
- `spawnUpgrade` 的 args 增 `'--bun-path', process.execPath`（`:116-126`）。注：对现有用户"这次"升级无影响（跑旧 gateway），对装新版后的后续升级生效；cli 侧 #2 已兜住兼容性，这步是"显式优于隐式"。
- 需重新构建 runtime（`bun run build`）。

### 6. `apps/gateway/src/system/install-info.ts`
- `InstallMetaShape` 增 `bunPath?: string`；`InstallInfo` 增 `bunPath: string | null`；`getInstallInfo` 返回 `meta.bunPath ?? null`（供诊断/展示，可选消费）。

### 7. `packages/app/src/commands/doctor.ts`
- 已装（`metaPath` 存在）：读 `meta.bunPath` 传给 `checkBunVersion(undefined, { metaBunPath })`，校验实际使用的 bun；未装：探测。
- 支持 `--bun-path` 覆盖。detail 显示实际 path。

### 8. `packages/app/src/lib/install.ts` `writeRunScript`
- PATH 兜底：在现有 `~/.bun/bin` 基础上，把 `dirname(bunPath)` 以及 homebrew/linuxbrew 常见目录前插 PATH，保证 run.sh 健壮。bunPath 保证绝对路径（resolve）。

### 9. `packages/app/src/i18n/index.ts`（en + zh-CN 同步）
- 更新 `cli.help`：init/doctor/upgrade 增 `[--bun-path <path>]`。
- 新增：`bun.explicitInvalid`（显式路径无效）、doctor 用 meta path 的可选提示文案。
- **注意**：这是 CLI 自带的手写 i18n（`MESSAGES` 对象），**不是**前端生成的 `resources.ts`，可直接改、不触发"勿动生成文件"红线。

### 10. 测试 `packages/app/src/lib/bun.test.ts`（新增）
- `sanitizeBunPath`：剥离 ANSI/控制字符、取末行。
- `resolveBunPath` 优先级：explicit > execPath(bun) > meta > 探测。
- `validateBun`：existsSync/版本校验失败回退。
- 回归 issue#28：构造含控制字符的"路径"，断言被净化/拒绝而非直接返回。
- 复核 `install.test.ts` 是否因 meta 增字段需更新。

### 11. 文档 `docs/update/<日期编号>-bun-path-resolution.md`
- 记录来源优先级、兼容性矩阵、issue#28 真因与修复。

## 验证

1. `cd packages/app && bun test src`（含新增 `bun.test.ts`，全绿）。
2. `bun run build`（packages/app + 触及 gateway 的 runtime 重建），确认无类型/构建错误。
3. **复现 issue#28 已修**：用 `/tmp` 临时 HOME + 会向 stdout 吐控制序列的 `.zshrc`，跑修复后的 `findBunBinary/checkBunVersion`，断言不再 `versionExecFailed`、返回净化后的真实路径。
4. **仓库内临时实例** doctor 冒烟（显式覆盖 `TMEX_FE_DIST_DIR`/`GATEWAY_PORT`/`TMEX_BIND_HOST`，**严禁碰生产 9883/`~/Library/Application Support/tmex`**）：分别验证 `--bun-path` 显式、`TMEX_BUN_PATH` env、无参探测三条路径。
5. **兼容性**：构造一份**无 `bunPath` 字段的旧 meta**，跑 `upgrade --apply-current-package` 在 `--bun-path` 缺失下回退探测；再设 `process.versions.bun` 场景（用 bun 直接跑 cli）确认 #2 命中。

## 执行顺序（先存档，再干活 —— AGENTS.md 红线）

0. **先存档**：在 `prompt-archives/<日期编号>-issue28-bun-path/` 建目录，写 `plan-prompt.md`（本轮 prompt 存档）+ `plan-00.md`（本计划）。
1. bun.ts 核心（含单测，TDD：先写 bun.test.ts）。
2. types.ts / init / upgrade / doctor / install.ts。
3. gateway install-info.ts / upgrade.ts。
4. i18n。
5. 构建 + 全部验证。
6. 文档 + `plan-00-result.md` 总结。

## 注意事项

- **严禁触碰生产 tmex**：不写 `~/Library/Application Support/tmex/`、不 kill/重启服务、不碰 9883。验证一律仓库内临时实例并显式覆盖被 shell 继承的 app.env 变量。
- 三套环境：测试走 `test`（`test.env`），临时 dev 实例走 `development`。
- 不对生成文件 lint/format（CLI i18n 是手写的，可改）。
- 工作在 worktree `issue-28-bun-detection`。
