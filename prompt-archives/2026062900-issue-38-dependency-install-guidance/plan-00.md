# Plan: Issue #38 - 安装体验优化（依赖引导与自动安装）

## 背景

tmex 运行依赖 bun（JS 运行时）和 tmux（终端复用器）。当前 CLI 的两个入口命令存在以下问题：

1. **`init` 命令**：仅检测 bun 是否可用，**完全没有检测 tmux**。tmux 是 tmex 的核心运行时依赖（gateway 通过 control mode 与 tmux 交互），用户可能在 init 成功后才在 runtime 报错。
2. **`doctor` 命令**：已覆盖 bun + tmux + ssh 的存在性检测，但所有 FAIL 项只报告"缺失"，**不提供安装引导**（如安装命令、最低版本要求等）。
3. **两个命令**均无 tmux 版本检测。gateway 要求 tmux >= 3.0（control mode 所需的 `%output`/`%window-add`/`%layout-change` 等通知自 3.0 起齐备，见 `apps/gateway/src/tmux-client/tmux-version.ts`），但 CLI 侧完全没有校验。
4. **无自动安装能力**：缺失依赖时用户需自行查找安装命令，体验差。

## 项目 Owner 的明确要求

- 所有平台推荐**官方方式**安装 bun（`curl -fsSL https://bun.sh/install | bash`）
- tmux 安装要**适配各发行版**（apt/dnf/pacman/brew 等）+ **版本检测**（>= 3.0）
- 安装前需**用户确认**（交互式）
- 考虑 **sudo 提权** edge case（Linux 包管理器通常需要 sudo）
- CLI 需有参数允许**静默安装**依赖（`--install-deps` / `--no-interactive` 场景）

## 设计思路

### 架构分层

本次改动仅涉及 **CLI 层**（`packages/app`），不涉及 gateway、前端、数据库。改动集中在：

```
packages/app/src/
  lib/
    dep-install.ts     (新增) 依赖安装引擎
    tmux.ts            (新增) tmux 检测与版本校验
  commands/
    init.ts            (修改) 增加 tmux 前置检测 + 安装引导
    doctor.ts          (修改) FAIL 项附带安装建议 + 可选 --fix
  constants.ts         (修改) 增加 MIN_TMUX_VERSION
  types.ts             (修改) 扩展 DoctorCheck 类型
  i18n/index.ts        (修改) 新增所有安装引导相关字符串
```

### 核心模块设计

#### 1. `lib/tmux.ts` — tmux 检测模块

类比 `lib/bun.ts` 的设计模式，为 tmux 建立独立的检测模块：

```typescript
export interface TmuxCheckResult {
  ok: boolean;
  path?: string;
  version?: { major: number; minor: number };
  versionRaw?: string;
  reason?: string;
}

// 检测 tmux 存在性 + 版本校验（>= MIN_TMUX_VERSION）
export async function checkTmuxVersion(
  minVersion?: { major: number; minor: number }
): Promise<TmuxCheckResult>;
```

**检测逻辑**：
- 执行 `tmux -V` 获取版本输出（如 `tmux 3.4`、`tmux 3.3a`、`tmux next-3.6`）
- 复用 gateway 已有的 `parseTmuxVersion()` 解析逻辑（从 `apps/gateway/src/tmux-client/tmux-version.ts` 提取为共享函数，或在 CLI 侧重新实现同样的简单正则——考虑到 CLI 包是独立发布的 npm 包，不应依赖 gateway 源码，选择在 CLI 侧**重新实现**同样的解析逻辑，保持与 gateway 一致的版本格式支持）
- 版本比较：major.minor >= 3.0
- 对于 `master`/未识别版本（`parseTmuxVersion` 返回 null），视为通过（与 gateway 行为一致）

**注意**：gateway 中 `MIN_CONTROL_MODE_VERSION = { major: 3, minor: 0 }`，CLI 侧的 `MIN_TMUX_VERSION` 应与之保持一致。

#### 2. `lib/dep-install.ts` — 依赖安装引擎

核心模块，负责检测当前平台/发行版并执行依赖安装。

```typescript
export type DepName = 'bun' | 'tmux';

export interface DepInstallPlan {
  dep: DepName;
  commands: InstallCommand[];   // 按优先级排列的安装方案
  currentVersion?: string;
  requiredVersion: string;
  issue: 'missing' | 'version-too-low';
}

export interface InstallCommand {
  label: string;                // 方案描述（如 "Homebrew"、"apt"）
  command: string;              // 完整安装命令
  requiresSudo: boolean;        // 是否需要 sudo
  packageManager: string;       // 包管理器标识
}

// 检测当前平台并生成安装方案
export function planDependencyInstall(
  dep: DepName,
  issue: 'missing' | 'version-too-low'
): InstallCommand[];

// 执行安装命令（含用户确认、sudo 提权、执行、结果校验）
export async function executeDependencyInstall(
  plan: DepInstallPlan,
  options: { nonInteractive: boolean; autoConfirm: boolean }
): Promise<boolean>;
```

##### 平台检测策略

**macOS（darwin）**：
- bun: `curl -fsSL https://bun.sh/install | bash`（官方推荐）
- tmux: `brew install tmux`（Homebrew）；若 Homebrew 不可用，提示先安装 Homebrew

**Linux**：
通过读取 `/etc/os-release` 的 `ID` 和 `ID_LIKE` 字段判断发行版家族：

| 发行版家族 | 检测方式 | tmux 安装命令 | 需要 sudo |
|------------|----------|---------------|-----------|
| debian/ubuntu | `ID=debian\|ubuntu` 或 `ID_LIKE=debian` | `sudo apt install -y tmux` | 是 |
| fedora/rhel/centos | `ID=fedora\|rhel\|centos` 或 `ID_LIKE=fedora\|rhel` | `sudo dnf install -y tmux` | 是 |
| arch/manjaro | `ID=arch\|manjaro` 或 `ID_LIKE=arch` | `sudo pacman -S --noconfirm tmux` | 是 |
| alpine | `ID=alpine` | `sudo apk add tmux` | 是 |
| opensuse | `ID=opensuse*` 或 `ID_LIKE=suse` | `sudo zypper install -y tmux` | 是 |
| 其他 | 无法识别 | 不自动安装，仅展示多种可能命令 | - |

- bun（所有 Linux）: `curl -fsSL https://bun.sh/install | bash`（官方推荐，不需要 sudo）

##### sudo 提权管理

```typescript
// 检测 sudo 是否可用
async function isSudoAvailable(): Promise<boolean>;

// 检测当前用户是否已是 root
function isRoot(): boolean;

// 需要 sudo 的命令，如果当前已是 root 则去掉 sudo 前缀
function resolveSudoPrefix(requiresSudo: boolean): string;
```

**edge case 处理**：
- 当前用户是 root（`process.getuid?.() === 0`）：跳过 sudo，直接执行
- sudo 不存在（某些容器/最小化安装）：报错提示用户手动安装或用 root 执行
- sudo 需要密码但在非交互模式：`sudo -n` 检测是否免密，不免密则报错退出
- sudo 超时/失败：捕获错误并给出清晰提示

##### 执行流程

1. 展示安装方案（命令、是否需要 sudo）
2. 交互模式下 `promptConfirm()` 确认（复用现有 `lib/prompt.ts`）
3. 执行安装命令（`runCommand` 使用 `stdio: 'inherit'` 让用户看到安装进度）
4. 安装后重新检测（调用 `checkBunVersion` / `checkTmuxVersion` 验证）
5. 返回安装结果

#### 3. `lib/linux-distro.ts` — Linux 发行版检测

```typescript
export interface LinuxDistroInfo {
  id: string;           // 如 "ubuntu", "fedora", "arch"
  idLike: string[];     // 如 ["debian"], ["rhel", "fedora"]
  versionId?: string;   // 如 "22.04"
  name?: string;        // 如 "Ubuntu 22.04.3 LTS"
}

// 解析 /etc/os-release
export async function detectLinuxDistro(): Promise<LinuxDistroInfo | null>;

// 判断包管理器家族
export type PackageManagerFamily = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper' | 'brew' | 'unknown';
export function detectPackageManager(distro: LinuxDistroInfo | null): PackageManagerFamily;
```

### 命令改动设计

#### `init` 命令改动

在 `runInit()` 中，**bun 检测之前**增加 tmux 检测（tmux 是更基础的系统依赖）：

```
当前流程：
  buildInitConfig → checkBunVersion → (若失败 throw) → 后续安装

改后流程：
  buildInitConfig
  → checkTmuxVersion → (若失败: 展示安装引导，可选自动安装，安装后重新检测)
  → checkBunVersion  → (若失败: 展示安装引导，可选自动安装，安装后重新检测)
  → 后续安装
```

**新增 flag**：
- `--install-deps`：主动安装缺失依赖（交互模式下弹确认，`--no-interactive` 下直接安装）
- `--skip-dep-check`：跳过依赖检测（高级用户 / CI 场景）

当检测到依赖缺失/版本过低时：
1. 展示具体问题（缺失 / 版本过低，当前版本 vs 最低要求）
2. 展示安装建议命令（按当前平台选择）
3. 如果有 `--install-deps`：自动走安装流程
4. 如果在交互模式且无 `--install-deps`：`promptConfirm()` 询问是否自动安装
5. 如果在非交互模式且无 `--install-deps`：throw 报错并附带安装命令

#### `doctor` 命令改动

**增强检测项输出**：每个 FAIL/WARN 项附带 actionable 的安装建议。

```
当前：
  [FAIL] 未检测到 tmux（tmex 需要 tmux 才能工作）。

改后：
  [FAIL] 未检测到 tmux（tmex 需要 tmux 才能工作）。
    安装建议: brew install tmux
```

**tmux 版本检测**：当前 doctor 只检测 tmux 存在性（`tmux -V` exit code），不解析版本。改为使用 `checkTmuxVersion()` 同时校验版本。

**新增 `--fix` flag**：
- 当 doctor 检测到 bun/tmux 缺失或版本过低时，`--fix` 触发自动安装流程
- 交互模式下逐项确认，非交互模式直接执行
- 安装完成后重新跑检测输出最终结果

**DoctorCheck 类型扩展**：

```typescript
export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  message: string;
  detail?: string;
  hint?: string;      // 新增：安装/修复建议命令
  fixable?: boolean;   // 新增：是否可以通过 --fix 自动修复
}
```

`printChecks` 函数在 FAIL/WARN 输出后追加 hint 行。JSON 输出中也包含 hint 和 fixable 字段。

### CLI 参数变更汇总

| 命令 | 新增参数 | 说明 |
|------|----------|------|
| `init` | `--install-deps` | 自动安装缺失依赖 |
| `init` | `--skip-dep-check` | 跳过依赖检测 |
| `doctor` | `--fix` | 自动修复可修复的检测项 |

`--no-interactive` + `--install-deps` 组合实现完全静默安装依赖。

### i18n 字符串新增

以下是需要新增的 i18n key（en + zh-CN）：

```
# tmux 检测
tmux.notFound          - tmux 未找到
tmux.versionTooLow     - tmux 版本过低（当前 / 要求）
tmux.ok                - tmux 检测通过

# 安装引导
deps.install.header    - 检测到缺失依赖：
deps.install.bun       - bun 安装命令提示
deps.install.tmux      - tmux 安装命令提示
deps.install.confirm   - 是否自动安装？
deps.install.running   - 正在安装...
deps.install.success   - 安装成功
deps.install.failed    - 安装失败
deps.install.manual    - 请手动安装后重试
deps.install.sudo      - 需要 sudo 权限
deps.install.sudoUnavailable - sudo 不可用
deps.install.skipNonInteractive - 非交互模式，跳过自动安装

# doctor hint
doctor.bun.hint.missing     - bun 安装建议命令
doctor.bun.hint.upgrade     - bun 升级建议命令
doctor.tmux.hint.missing    - tmux 安装建议命令（按平台）
doctor.tmux.hint.upgrade    - tmux 升级建议命令（按平台）
doctor.tmux.versionLow      - tmux 版本过低消息

# help 文本更新
cli.help                    - 追加新参数说明
```

## 详细任务清单

### 任务 1：新建 `lib/linux-distro.ts` — Linux 发行版检测

**文件**：`packages/app/src/lib/linux-distro.ts`（新建）

**内容**：
- 读取 `/etc/os-release` 解析 `ID`、`ID_LIKE`、`VERSION_ID`、`NAME` 字段
- 导出 `detectLinuxDistro()` 函数
- 导出 `detectPackageManager()` 函数，根据 distro 信息返回包管理器家族
- macOS 上返回 `'brew'`，Linux 上按发行版映射
- 非 Linux/macOS 返回 `'unknown'`

**验证点**：
- 单元测试覆盖各发行版的 `/etc/os-release` 解析（mock 文件内容）
- 边界：文件不存在、字段缺失、`ID_LIKE` 含多个值

### 任务 2：新建 `lib/tmux.ts` — tmux 检测模块

**文件**：
- `packages/app/src/lib/tmux.ts`（新建）
- `packages/app/src/lib/tmux.test.ts`（新建）

**内容**：
- 定义 `TmuxCheckResult` 接口
- 实现 `parseTmuxVersion()` — 从 `tmux -V` 输出解析版本号，逻辑与 gateway 的 `parseTmuxVersion` 保持一致（`/(\d+)\.(\d+)/` 正则匹配），但独立实现不依赖 gateway 包
- 实现 `compareTmuxVersion()` — 比较 `{ major, minor }` 格式的版本
- 实现 `checkTmuxVersion(minVersion?)` — 执行 `tmux -V`，解析版本并与 `MIN_TMUX_VERSION` 比较
- 在 `constants.ts` 中增加 `MIN_TMUX_VERSION = { major: 3, minor: 0 }`

**验证点**：
- 单元测试覆盖版本解析（`tmux 3.4`、`tmux 3.3a`、`tmux next-3.6`、`tmux master`、空字符串）
- 版本比较测试（>= 3.0 通过，< 3.0 失败，null 通过）
- 集成测试：`checkTmuxVersion()` 在当前开发机上应返回 ok（tmux 已安装）

### 任务 3：新建 `lib/dep-install.ts` — 依赖安装引擎

**文件**：
- `packages/app/src/lib/dep-install.ts`（新建）
- `packages/app/src/lib/dep-install.test.ts`（新建）

**内容**：
- 定义 `DepInstallPlan`、`InstallCommand` 类型
- 实现 `planBunInstall()` — 返回 bun 的安装命令列表：
  - 所有平台首选：`curl -fsSL https://bun.sh/install | bash`
- 实现 `planTmuxInstall()` — 根据平台/发行版返回 tmux 安装命令列表：
  - macOS：检测 `brew` 是否可用，可用则返回 `brew install tmux`
  - Linux：调用 `detectPackageManager()` 返回对应的 `apt`/`dnf`/`pacman`/`apk`/`zypper install tmux` 命令
- 实现 `getInstallHint(dep, platform)` — 返回适合展示在 doctor hint 中的安装建议字符串
- 实现 `isSudoAvailable()` — 检测 sudo 是否存在
- 实现 `isRoot()` — 检测当前是否 root 用户
- 实现 `executeDependencyInstall(plan, options)` — 核心安装执行器：
  1. 若 `options.nonInteractive && !options.autoConfirm`：仅打印建议命令并退出
  2. 若需要 sudo：检测 sudo 可用性；若不可用且非 root，报错
  3. 交互模式：`promptConfirm()` 确认
  4. 执行命令（`runCommand` with `stdio: 'inherit'`）
  5. 安装后重新检测验证
  6. 返回结果

**验证点**：
- 单元测试覆盖 `planBunInstall` 和 `planTmuxInstall` 在各平台/发行版下的返回值（mock `process.platform` 和 `detectLinuxDistro`）
- sudo 检测的边界测试（root 用户、sudo 不存在）
- 安装命令拼装正确性

### 任务 4：修改 `commands/init.ts` — 增加 tmux 检测与安装引导

**文件**：`packages/app/src/commands/init.ts`

**改动**：
1. 在 `buildInitConfig` 中增加对 `--install-deps` 和 `--skip-dep-check` flag 的解析
2. 扩展 `InitConfig` 类型：增加 `installDeps: boolean` 和 `skipDepCheck: boolean` 字段
3. 在 `runInit()` 中，`checkBunVersion` 调用之前，增加 `checkTmuxVersion()` 调用
4. 依赖检测失败时的处理逻辑：
   - 若 `skipDepCheck`：跳过检测继续
   - 若 `installDeps` 或交互模式确认安装：调用 `executeDependencyInstall()`
   - 安装成功后重新检测，仍失败则 throw
   - 非交互模式且未指定 `--install-deps`：throw 并附带安装命令
5. bun 检测失败的处理也按同样模式增强（当前只有一个 throw，需要增加安装引导）

**改动后 `runInit` 流程**：
```
1. buildInitConfig（含新 flag 解析）
2. if (!skipDepCheck):
   a. checkTmuxVersion() → 失败则走安装引导流程
   b. checkBunVersion()  → 失败则走安装引导流程
3. 后续安装流程（不变）
```

**验证点**：
- `--skip-dep-check` 跳过检测
- `--install-deps --no-interactive` 静默安装
- 交互模式弹出安装确认
- tmux 缺失时的错误信息包含安装命令

### 任务 5：修改 `commands/doctor.ts` — 增强检测输出与 --fix

**文件**：`packages/app/src/commands/doctor.ts`

**改动**：
1. 将 tmux 检测从简单的 `checkCommandExists` 替换为 `checkTmuxVersion()`，同时校验版本
2. bun 和 tmux 的 FAIL 检测项增加 `hint` 字段（调用 `getInstallHint()`）
3. 增加 `--fix` flag 解析
4. `printChecks` 函数增加 hint 输出（FAIL/WARN 行后追加 `  建议: <hint>`）
5. 当 `--fix` 启用时，遍历 fixable 的 FAIL 项，逐项执行安装，完成后重新跑检测
6. JSON 输出中包含 `hint` 和 `fixable` 字段

**改动后 tmux 检测逻辑**：
```typescript
// 替换原有的 checkCommandExists 调用
const tmux = await checkTmuxVersion();
if (tmux.ok) {
  checks.push({
    id: 'tmux',
    level: 'pass',
    message: t('doctor.tmux.ok'),
    detail: tmux.versionRaw ? `tmux ${tmux.versionRaw}` : undefined,
  });
} else if (tmux.reason === 'version-too-low') {
  checks.push({
    id: 'tmux',
    level: 'fail',
    message: t('doctor.tmux.versionLow', { ... }),
    hint: getInstallHint('tmux', process.platform),
    fixable: true,
  });
} else {
  checks.push({
    id: 'tmux',
    level: 'fail',
    message: t('doctor.tmux.fail'),
    hint: getInstallHint('tmux', process.platform),
    fixable: true,
  });
}
```

**验证点**：
- doctor 输出中 FAIL 项附带 hint
- `--json` 输出中包含 hint 和 fixable
- tmux 版本过低时输出 FAIL（而非仅检测存在性）
- `--fix` 触发安装流程

### 任务 6：修改 `types.ts` — 扩展类型

**文件**：`packages/app/src/types.ts`

**改动**：
- `DoctorCheck` 增加 `hint?: string` 和 `fixable?: boolean` 字段
- `InitConfig` 增加 `installDeps: boolean` 和 `skipDepCheck: boolean` 字段

### 任务 7：修改 `constants.ts` — 增加 MIN_TMUX_VERSION

**文件**：`packages/app/src/constants.ts`

**改动**：
- 增加 `MIN_TMUX_VERSION = { major: 3, minor: 0 }`（与 gateway 的 `MIN_CONTROL_MODE_VERSION` 保持一致）

### 任务 8：修改 `i18n/index.ts` — 新增国际化字符串

**文件**：`packages/app/src/i18n/index.ts`

**改动**：为 en 和 zh-CN 两种语言添加所有新增的 i18n key，包括：

**tmux 检测相关**：
- `tmux.notFound` — "tmux not found. tmex requires tmux >= 3.0 to operate." / "未检测到 tmux。tmex 需要 tmux >= 3.0 才能工作。"
- `tmux.versionTooLow` — "tmux version too low: current {{version}}, required >= 3.0" / "tmux 版本过低：当前 {{version}}，要求 >= 3.0"

**安装引导相关**：
- `deps.install.confirm` — "Install {{dep}} now?" / "是否现在安装 {{dep}}？"
- `deps.install.running` — "Installing {{dep}}..." / "正在安装 {{dep}}..."
- `deps.install.success` — "{{dep}} installed successfully." / "{{dep}} 安装成功。"
- `deps.install.failed` — "Failed to install {{dep}}." / "安装 {{dep}} 失败。"
- `deps.install.manual` — "Please install manually and retry." / "请手动安装后重试。"
- `deps.install.sudoRequired` — "This operation requires sudo." / "此操作需要 sudo 权限。"
- `deps.install.sudoUnavailable` — "sudo is not available. Please run as root or install sudo." / "sudo 不可用，请以 root 身份执行或安装 sudo。"
- `deps.install.nonInteractive` — "Missing dependency: {{dep}}. Use --install-deps to install automatically." / "缺少依赖：{{dep}}。使用 --install-deps 自动安装。"
- `deps.install.hint` — "Suggested install command: {{command}}" / "建议安装命令：{{command}}"
- `deps.install.brewMissing` — "Homebrew not found. Install Homebrew first: https://brew.sh" / "未检测到 Homebrew，请先安装 Homebrew：https://brew.sh"
- `deps.install.unknownDistro` — "Unable to detect Linux distribution. Please install {{dep}} manually." / "无法检测 Linux 发行版，请手动安装 {{dep}}。"

**doctor 相关**：
- `doctor.tmux.versionLow` — "tmux version too low: {{version}} (requires >= 3.0)" / "tmux 版本过低：{{version}}（要求 >= 3.0）"
- `doctor.tmux.version` — "tmux installed: {{version}}" / "tmux 已安装：{{version}}"
- `doctor.fix.header` — "Attempting to fix issues..." / "正在尝试修复问题..."
- `doctor.fix.skip` — "Skipping unfixable item: {{id}}" / "跳过无法自动修复的项目：{{id}}"

**help 文本**：更新 `cli.help` 增加 `--install-deps`、`--skip-dep-check`、`--fix` 参数说明。

### 任务 9：修改 `commands/upgrade.ts` — bun 检测失败时增加安装引导

**文件**：`packages/app/src/commands/upgrade.ts`

**改动**：
- upgrade 中 `checkBunVersion` 失败时，附带安装建议信息（与 init 一致的逻辑）
- 注意：upgrade 不做自动安装（升级流程不应自动引入新依赖安装逻辑，保持最小改动）

### 任务 10：更新已有测试 + 新增测试

**文件**：
- `packages/app/src/lib/linux-distro.test.ts`（新建）
- `packages/app/src/lib/tmux.test.ts`（新建）
- `packages/app/src/lib/dep-install.test.ts`（新建）

**测试覆盖**：

1. **linux-distro.test.ts**：
   - 各发行版 `/etc/os-release` 内容解析（Ubuntu、Fedora、Arch、Alpine、openSUSE）
   - `ID_LIKE` 多值解析
   - 文件不存在时返回 null
   - `detectPackageManager()` 映射正确性

2. **tmux.test.ts**：
   - `parseTmuxVersion` 解析各格式版本号（与 gateway 测试对齐）
   - `checkTmuxVersion` 版本比较逻辑
   - tmux 不存在时返回 `ok: false`

3. **dep-install.test.ts**：
   - `planBunInstall()` 返回值验证
   - `planTmuxInstall()` 在各平台/发行版下的返回值验证
   - `getInstallHint()` 返回字符串验证
   - `isSudoAvailable()` 和 `isRoot()` 边界测试

## 测试策略

### 单元测试

- 所有新建模块（`linux-distro.ts`、`tmux.ts`、`dep-install.ts`）配套 `.test.ts`
- 平台/发行版相关逻辑通过依赖注入 mock（如传入 `platform` 参数、mock 文件读取）
- 使用 `bun test` 运行

### 集成测试

- 在开发机（macOS）上运行 `bun run build:cli` 确认编译通过
- 手动验证 `tmex doctor` 输出中包含 hint 信息
- 手动验证 `tmex doctor --json` 输出 JSON 中包含 hint 和 fixable
- 手动验证 `tmex doctor --fix` 在依赖齐全时不执行安装

### 跨平台验证

- macOS：bun 和 tmux 检测、brew 安装建议
- Linux（通过 Docker 或 CI）：
  - Ubuntu/Debian 镜像：apt 安装建议
  - Fedora 镜像：dnf 安装建议
  - Arch 镜像：pacman 安装建议
  - Alpine 镜像：apk 安装建议

## 验收标准

1. `tmex init` 在 tmux 缺失时拒绝继续并展示安装命令
2. `tmex init` 在 tmux 版本 < 3.0 时拒绝继续并展示升级建议
3. `tmex init --install-deps` 在依赖缺失时自动安装（交互模式弹确认，非交互模式直接安装）
4. `tmex init --skip-dep-check` 跳过所有依赖检测
5. `tmex doctor` 的 FAIL 项包含可执行的安装建议命令
6. `tmex doctor --json` 输出中包含 `hint` 和 `fixable` 字段
7. `tmex doctor --fix` 自动安装缺失依赖并重新检测
8. tmux 版本检测阈值为 >= 3.0，与 gateway 的 `MIN_CONTROL_MODE_VERSION` 一致
9. bun 安装建议在所有平台为官方安装脚本
10. tmux 安装建议按平台/发行版正确适配
11. sudo 提权 edge case 正确处理（root / sudo 不存在 / 非交互模式）
12. 所有新增功能有中英文 i18n 支持
13. `bun test src` 全部通过

## 风险和注意事项

1. **CLI 包独立性**：`packages/app` 作为 npm 包独立发布，不应 import gateway 代码。tmux 版本解析逻辑需在 CLI 侧重新实现（逻辑简单，只是一个正则），并保持与 gateway 一致。未来如果 MIN_TMUX_VERSION 需要升级，需要同时改 CLI 的 `constants.ts` 和 gateway 的 `tmux-version.ts`。

2. **自动安装安全性**：执行外部命令（curl | bash、apt install 等）有安全风险。必须：
   - 安装前展示完整命令让用户确认
   - 非交互模式需要显式 `--install-deps` opt-in
   - 不从不可信源下载脚本（仅使用 bun.sh 官方和系统包管理器）

3. **sudo 密码交互**：`runCommand` with `stdio: 'inherit'` 可以让 sudo 向用户请求密码。但在 `--no-interactive` 模式下，sudo 可能阻塞等待密码输入。解决方案：非交互模式下使用 `sudo -n`（no-prompt），如果需要密码则立即失败。

4. **包管理器检测误判**：某些系统可能同时安装了多个包管理器（如 Arch 上也有 brew），`detectPackageManager` 应优先使用系统原生包管理器。

5. **tmux 版本格式多样性**：除常见的 `tmux 3.4`、`tmux 3.3a`，还有 `tmux next-3.6`、`tmux master`（从源码编译）。CLI 的版本解析需要与 gateway 行为一致：无法解析的版本（如 `master`）视为通过。

6. **Homebrew 缺失场景**：macOS 上 tmux 主要通过 Homebrew 安装。如果 Homebrew 不可用，需要提示用户先安装 Homebrew，而非直接 `brew install`。

7. **i18n 字符串中的安装命令**：安装命令本身不应国际化（保持原样），但提示文字需要中英文。

8. **DoctorCheck 类型扩展的向后兼容**：新增 `hint` 和 `fixable` 为可选字段，不影响现有使用方。`--json` 输出增加字段是追加式的，不破坏已有消费者。

9. **init 中 bun 检测失败的安装引导**：当前 `checkBunVersion` 内部有完善的多路径探测（显式路径 -> process.execPath -> meta -> 登录 shell -> PATH -> 硬编码路径），仅在全部失败时返回 `ok: false`。安装引导应在这一层之上，不改变 `checkBunVersion` 内部逻辑。

10. **不要触碰生产环境**：所有测试和验证在开发/测试环境进行，严禁操作 `~/Library/Application Support/tmex/` 或生产服务。
