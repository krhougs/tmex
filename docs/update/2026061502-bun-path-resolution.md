# bun 路径解析重构（issue #28）

## 背景

GitHub issue #28 报告 macOS 上 Homebrew 安装的 bun（`/opt/homebrew/bin/bun`）检测失败。经核验，**原始诊断有误**：

issue 贴出的报错是 `Bun check failed: Failed to execute bun --version` 且**带出了路径** `/opt/homebrew/bin/bun`。该报错对应 `checkBunVersion()` 的 `bun.versionExecFailed` 分支，只有 `findBunBinary()` **成功返回非空路径**时才会带路径——即 bun 已被检测到，失败在「执行该路径」。

真因（已端到端复现）：`locateBunFromShell()` 用 `zsh -lic 'command -v bun'`，`-i`（交互式）会加载 `.zshrc`，prompt 框架 / instant-prompt / banner 会向 stdout 注入 ANSI 控制序列，污染 `command -v bun` 的结果；`trim()` 去不掉中间的控制字符，于是返回的路径串夹带控制字符，`spawn()` 因字面路径不存在而 ENOENT → `versionExecFailed`。doctor 打印时控制序列（如 `ESC[2K\r`）让终端显示「看起来干净」，掩盖了真相。

issue 建议的修复（在 `locateBunFromShell()` 之后加 homebrew 路径检查）**无效**：`locateBunFromShell()` 已先返回非空（污染）值短路，后插的代码不会执行。

## 设计：bun 路径来源优先级

`checkBunVersion(minVersion?, { explicitPath?, metaBunPath? })` 按以下优先级解析，每个候选都过 `validateBunAt`（执行 `--version` + 版本比对）：

1. **显式** `--bun-path` flag / `TMEX_BUN_PATH` env —— 必须是「存在的绝对路径」，否则直接报 `explicitInvalid`，**不静默回退**。
2. **`process.execPath`**（仅当 `process.versions.bun` 存在，即 cli 被 bun 拉起，如自更新链路）—— 最权威。
3. **`meta.bunPath`**（init 持久化到 `install-meta.json`）。
4. **动态探测**：登录 shell 解析（`$SHELL` / zsh / bash 的 `-lic 'command -v bun'`，经净化 + 存在性校验）→ 当前进程 PATH 的裸 `bun`。
5. **硬编码常见安装路径**（`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/home/linuxbrew/.linuxbrew/bin`）—— **仅作 fallback**，动态探测全部失败时兜底。

核心思路：路径是**安装期一次性决策**，应持久化复用，而非每个命令现场探测；动态探测反映用户实际在用的 bun，硬编码只兜底。

### 输出净化 `sanitizeBunPath`

用码点判断（避免源码中出现不可见控制字符）剥离 ANSI CSI / OSC 转义与控制字符，按换行拆分后**优先返回最后一个绝对路径行**（应对 banner 出现在路径前/后的污染），否则返回最后一个非空行（如版本号）。这是 issue #28 的核心修复。

## 兼容性（现有用户）

升级本就会重写 `install-meta.json`，故 `bunPath` 只需纳入重写字段。`InstallMeta.bunPath` 声明为**可选**（旧 meta 无此字段，运行时为 `undefined`，由优先级链安全处理）。

- **网页自更新**：新 cli 被旧 gateway 用 bun 拉起 → `process.versions.bun` 存在 → #2 `process.execPath` 确定性命中正确 bun，**不依赖旧 meta、不依赖旧 gateway 改动**，结果写入重建的 meta。
- **手动 `npx tmex-cli upgrade`**：execPath 为 node（#2 不命中）、旧 meta 无 bunPath（#3 不命中）→ #4 动态探测（已修健壮）→ 结果写入重建 meta。
- gateway 侧 `spawnUpgrade` 额外显式传 `--bun-path process.execPath`，对装新版后的后续升级生效（属显式加固，非兼容必需）。

## 非交互环境 / fail-fast

`runCommand` 新增 `timeoutMs`（超时 SIGKILL + reject）；`stdio: 'pipe'` 时 stdin 重定向 `/dev/null`。shell 探测带 5s 超时，确保 `zsh -lic` 这类交互式 shell 在无 TTY 的 CI / launchd / systemd 自更新场景**不挂起**，超时即继续 fallback。

## run.sh 健壮性与安全

- `writeRunScript` 写入的 `exec` 用 bun 绝对路径；PATH 显式补全：动态 `${HOME}/.bun/bin` 条件块 + `extraPathDirs`（bun 实际目录 + homebrew/usr-local/linuxbrew，去重并排除 `~/.bun/bin` 以免与条件块重复）。
- bunPath 校验：含 shell 元字符（`"` `` ` `` `$` `\` 换行回车）时抛 `unsafePath`，防止生成的 run.sh 被注入 / 语法损坏（DoS）。

## 受影响范围

- `packages/app/src/lib/bun.ts`（核心）、`lib/process.ts`（超时）、`lib/install.ts`（run.sh）、`types.ts`、`commands/{init,doctor,upgrade}.ts`、`i18n/index.ts`。
- `apps/gateway/src/system/{install-info,upgrade}.ts`（meta 形状 + 自更新显式传参）。
- 新增 `packages/app/src/lib/bun.test.ts`。

## 验证

- `bun test src`（CLI 包，29 通过）；`bun build`（cli + gateway runtime）无错。
- 受控实验复现 issue #28 污染并确认净化生效；doctor 端到端冒烟覆盖显式有效 / env / 无参 / 显式无效（含相对路径拒绝）。
- 多维度对抗审查（兼容性 / 跨平台·非交互 / issue#28 真修 / 边界安全 / 质量），确认问题已逐条修复。
