# Plan: Issue #30 — 新终端可配置默认工作目录

## 背景

tmex 以系统服务（launchd / systemd）运行，服务模板的 `WorkingDirectory` 指向安装目录（如 `~/Library/Application Support/tmex/`）。tmux 的 `new-window` 在未指定 `-c` 参数时会继承服务进程的 cwd 作为新窗口的工作目录，导致用户通过前端新建终端时，shell 总在安装目录打开而非用户 home。

`ensureSession()` 在创建 session 时已传递 `-c homedir()` / `-c this.remoteHomeDir`，但这仅影响 session 首窗口。后续 `createWindow()` 和 `closeWindowInternal()` 中的 `new-window` 均未传 `-c`，也未设置 tmux 的 `default-path` session 选项，因此新窗口回退到服务 cwd。

## 项目 owner 的明确要求

- device 表新增一个 **tmux 默认目录**字段（`defaultWorkingDir`）
- 留空时默认为当前用户的 home 目录
- 该字段应可在前端设备编辑表单中配置

## 设计思路

### 分层改动

改动涉及 5 个层面：数据库 schema → 共享类型/协议 → gateway 后端逻辑 → REST API → 前端 UI。

#### 1. 数据库层（schema + migration）

在 `devices` 表新增 `default_working_dir` 列（TEXT, nullable, 默认 NULL）。NULL / 空串 均表示「使用用户 home」。

#### 2. 共享类型层（@tmex/shared）

- `Device` 接口新增 `defaultWorkingDir?: string`
- `CreateDeviceRequest` / `UpdateDeviceRequest` 新增 `defaultWorkingDir?: string`

不涉及 ws-borsh 协议改动——`createWindow` 的工作目录由 gateway 在服务端根据 device 配置决定，无需客户端传递。

#### 3. Gateway 后端逻辑

核心改动在两个 connection 文件和 configureSessionOptions：

**3a. `configureSessionOptions()` — 设置 tmux `default-path`**

在 `configureSessionOptions()` 末尾，根据 `this.device.defaultWorkingDir` 调用 `set-option -t <session> default-command` 之前，使用：

```
tmux set-option -t <session> default-path <dir>
```

- local: `dir` = `device.defaultWorkingDir?.trim() || homedir()`
- ssh: `dir` = `device.defaultWorkingDir?.trim() || this.remoteHomeDir`

`default-path` 是 tmux 3.2+ 的 session 级选项，当用户在 tmux 内部按 `prefix+c` 或 tmex 发 `new-window`（不带 `-c`）时生效。这是最干净的方案——一次设置，后续所有 `new-window` 自动继承，无需逐命令传 `-c`。

**兼容 tmux < 3.2**：`default-path` 在 tmux 3.0/3.1 不存在，`set-option` 会报错。由于此处使用 `runTmuxAllowFailure`，错误会被静默忽略。作为 fallback，同时在 `createWindow()` 和 `closeWindowInternal()` 的 `new-window` 中显式传 `-c` 参数。这确保所有 tmux >= 3.0 均可工作。

**3b. `createWindow()` — 显式 `-c`**

local-external-connection.ts（第 310 行）和 ssh-external-connection.ts（第 212 行）的 `createWindow()` 方法中，为 `new-window` 命令追加 `-c <dir>` 参数。

当前代码：
```typescript
const argv = name
  ? ['new-window', '-t', this.sessionName, '-n', name]
  : ['new-window', '-t', this.sessionName];
```

改为：
```typescript
const dir = this.resolveDefaultWorkingDir();
const argv = ['new-window', '-t', this.sessionName, '-c', dir];
if (name) {
  argv.push('-n', name);
}
```

其中 `resolveDefaultWorkingDir()` 是新增的 private 方法：
- local: `return this.device?.defaultWorkingDir?.trim() || homedir();`
- ssh: `return this.device?.defaultWorkingDir?.trim() || this.remoteHomeDir;`

**3c. `closeWindowInternal()` — 备用窗口也传 `-c`**

两个 connection 文件的 `closeWindowInternal()` 中，当只剩最后一个窗口时会 `new-window -d` 创建备用窗口：

```typescript
await this.runTmux(['new-window', '-d', '-t', this.sessionName]);
```

同样追加 `-c <dir>`：

```typescript
await this.runTmux(['new-window', '-d', '-t', this.sessionName, '-c', this.resolveDefaultWorkingDir()]);
```

**3d. `ensureSession()` — 保持一致**

`ensureSession()` 已经为首窗口传了 `-c homedir()` / `-c this.remoteHomeDir`。改为使用 `resolveDefaultWorkingDir()` 以尊重自定义配置：

```typescript
await this.runTmux(['new-session', '-d', '-c', this.resolveDefaultWorkingDir(), '-s', this.sessionName]);
```

#### 4. REST API 层

**`handleCreateDevice`** 和 **`handleUpdateDevice`**（`apps/gateway/src/api/index.ts`）：

- 创建时从 `body.defaultWorkingDir` 读取并写入 device
- 更新时支持 `body.defaultWorkingDir !== undefined` 时更新

**`updateDevice` DB 函数**（`apps/gateway/src/db/index.ts`）：

- `updateDevice()` 中增加 `if (updates.defaultWorkingDir !== undefined)` 分支
- `createDevice()` 的 `insert` values 中增加 `defaultWorkingDir`
- `toDevice()` 映射中增加 `defaultWorkingDir`

**`shouldReconnectPushSupervisor`**：`defaultWorkingDir` 变更**不需要**触发重连——它只影响后续 `new-window` 的 `-c` 参数和 `default-path` 选项，已连接的 session 在下次 `createWindow` 时自然生效。但需要在连接已建立后更新 tmux session 的 `default-path`。

更合理的做法：`shouldReconnectPushSupervisor` 不触发（避免断连所有终端），但在 `handleUpdateDevice` 中，当 `defaultWorkingDir` 发生变化时，通过 runtime registry 获取对应 device 的 runtime connection，调用一个新的 `updateDefaultPath()` 方法来运行 `set-option -t <session> default-path <dir>`。

考虑到简化实现，也可以选择：**在 `shouldReconnectPushSupervisor` 中加入 `defaultWorkingDir` 变更检测，触发重连**。这会导致修改默认目录时终端短暂断连重连，但逻辑最简单且不引入新的 runtime 方法。推荐此方案。

#### 5. 前端 UI 层

**`DevicesPage.tsx` 的 `DeviceDialog` 组件**：

- `DeviceFormValues` 类型新增 `defaultWorkingDir: string`
- `createDefaultFormValues()` 中，新建时默认空串，编辑时从 device 读取
- `buildCreatePayload()` / `buildUpdatePayload()` 中，将 `defaultWorkingDir` 传入 payload（空串时传 `undefined` 或空串，后端统一处理）
- 表单 UI：在 "基本信息" section 中，`session` 字段下方新增 `defaultWorkingDir` 输入框
  - label: 使用 i18n key `device.defaultWorkingDir`
  - placeholder: 使用 i18n key `device.defaultWorkingDirPlaceholder`（提示 "留空使用用户 home 目录"）
  - 类型: text input
  - 对所有设备类型（local + ssh）均可见

**i18n 文本**（`en_US.json` + `zh_CN.json` + `resources.ts`）：

- `device.defaultWorkingDir`: "Default Working Directory" / "默认工作目录"
- `device.defaultWorkingDirPlaceholder`: "Leave empty for user home directory" / "留空使用用户 home 目录"

## 详细任务清单

### 任务 1: 数据库 migration

**涉及文件**：
- `apps/gateway/drizzle/` — 新建 migration SQL 文件
- `apps/gateway/src/db/schema.ts` — devices 表新增 `defaultWorkingDir` 列

**改动内容**：
1. 在 `schema.ts` 的 `devices` 表定义中添加 `defaultWorkingDir: text('default_working_dir')` 列（nullable，无默认值，NULL = 使用 home）
2. 运行 `bun run drizzle-kit generate` 生成 migration 文件（或手写 `ALTER TABLE devices ADD COLUMN default_working_dir TEXT;`）

**验证点**：migration 正常应用，现有 device 行的 `default_working_dir` 为 NULL。

### 任务 2: 共享类型更新

**涉及文件**：
- `packages/shared/src/index.ts`

**改动内容**：
1. `Device` 接口新增 `defaultWorkingDir?: string`
2. `CreateDeviceRequest` 接口新增 `defaultWorkingDir?: string`
3. `UpdateDeviceRequest` 接口新增 `defaultWorkingDir?: string`

**验证点**：TypeScript 编译通过，无类型错误。

### 任务 3: DB 操作函数更新

**涉及文件**：
- `apps/gateway/src/db/index.ts`

**改动内容**：
1. `toDevice()` 映射函数中新增 `defaultWorkingDir: optional(row.defaultWorkingDir)`
2. `createDevice()` 的 insert values 中新增 `defaultWorkingDir: device.defaultWorkingDir ?? null`
3. `updateDevice()` 中新增 `if (updates.defaultWorkingDir !== undefined) { setValues.defaultWorkingDir = updates.defaultWorkingDir || null; }`（空串归一化为 NULL）

**验证点**：`createDevice` / `updateDevice` / `getDeviceById` 正确读写 `defaultWorkingDir`。

### 任务 4: REST API 更新

**涉及文件**：
- `apps/gateway/src/api/index.ts`

**改动内容**：
1. `handleCreateDevice` 中从 `body.defaultWorkingDir` 读取并设置到 device 对象
2. `handleUpdateDevice` 中处理 `body.defaultWorkingDir !== undefined` 的更新
3. `shouldReconnectPushSupervisor` 中增加 `defaultWorkingDir` 变更检测（`if (updates.defaultWorkingDir !== undefined && updates.defaultWorkingDir !== existing.defaultWorkingDir) return true;`）

**验证点**：API 端点正确接收和存储 `defaultWorkingDir`。

### 任务 5: Gateway tmux 连接逻辑

**涉及文件**：
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`

**改动内容**：

**local-external-connection.ts**:
1. 新增 `private resolveDefaultWorkingDir(): string` 方法，返回 `this.device?.defaultWorkingDir?.trim() || homedir()`
2. `ensureSession()` 中 `new-session -c` 改用 `this.resolveDefaultWorkingDir()`
3. `configureSessionOptions()` 末尾新增 `set-option -t <session> default-path <dir>`（`runTmuxAllowFailure`）
4. `createWindow()` 中为 `new-window` 追加 `-c this.resolveDefaultWorkingDir()`
5. `closeWindowInternal()` 中备用窗口的 `new-window -d` 追加 `-c this.resolveDefaultWorkingDir()`

**ssh-external-connection.ts**:
1. 新增 `private resolveDefaultWorkingDir(): string` 方法，返回 `this.device?.defaultWorkingDir?.trim() || this.remoteHomeDir`
2. `ensureSession()` 中 `new-session -c` 改用 `this.resolveDefaultWorkingDir()`
3. `configureSessionOptions()` 末尾新增 `set-option -t <session> default-path <dir>`（`runTmuxAllowFailure`）
4. `createWindow()` 中为 `new-window` 追加 `-c this.resolveDefaultWorkingDir()`
5. `closeWindowInternal()` 中备用窗口的 `new-window -d` 追加 `-c this.resolveDefaultWorkingDir()`

**验证点**：新建窗口在指定目录打开；留空时在 home 目录打开。

### 任务 6: DeviceSessionRuntime 接口

**涉及文件**：
- `apps/gateway/src/tmux-client/device-session-runtime.ts`

**改动内容**：无需改动。`createWindow()` 接口签名不变（`name?: string`），工作目录由 connection 内部根据 device 配置决定。

### 任务 7: 前端表单 + i18n

**涉及文件**：
- `apps/fe/src/pages/DevicesPage.tsx`
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`（如存在）

**改动内容**：

**DevicesPage.tsx**:
1. `DeviceFormValues` 新增 `defaultWorkingDir: string`
2. `createDefaultFormValues()` 中：新建默认空串，编辑从 `device.defaultWorkingDir ?? ''`
3. `buildCreatePayload()` 中：`defaultWorkingDir: normalizeText(values.defaultWorkingDir)`
4. `buildUpdatePayload()` 中：`defaultWorkingDir: normalizeText(values.defaultWorkingDir) ?? ''`（空串表示清除自定义值）
5. 表单 JSX：在 session 输入框下方，新增 defaultWorkingDir 输入框（位于 "基本信息" section 内），对 local 和 ssh 类型均显示

**i18n**:
1. 新增 `device.defaultWorkingDir` / `device.defaultWorkingDirPlaceholder` 翻译键
2. `en_US.json`: `"defaultWorkingDir": "Default Working Directory"`, `"defaultWorkingDirPlaceholder": "Leave empty for user home directory"`
3. `zh_CN.json`: `"defaultWorkingDir": "默认工作目录"`, `"defaultWorkingDirPlaceholder": "留空使用用户 home 目录"`
4. 运行 `bun run build:i18n` 重新生成 `resources.ts` 和 `types.ts`

**验证点**：表单正确显示输入框，保存后值持久化。

### 任务 8: 单元测试

**涉及文件**：
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`

**改动内容**：

**local-external-connection.test.ts**:
1. 修改 `createDevice()` 测试工厂函数，增加 `defaultWorkingDir` 参数
2. 更新 `createRunStub` 中 `ensureSession` / `createWindow` 的命令匹配（现在会带 `-c` 参数）
3. 新增测试用例：
   - `createWindow() uses user home when defaultWorkingDir is empty`：验证空 defaultWorkingDir 时 new-window 传 `-c <homedir>`
   - `createWindow() uses custom dir when defaultWorkingDir is set`：验证自定义 defaultWorkingDir 时 new-window 传 `-c /custom/path`
   - `configureSessionOptions sets default-path`：验证 `set-option -t <session> default-path` 被调用
4. 更新已有测试的命令匹配逻辑（`isConfigureSessionOptionCommand` 增加 `default-path` 匹配）

**ssh-external-connection.test.ts**:
1. 类似的改动，适配 SSH 的命令格式（shell-quoted 参数）
2. 新增对应测试用例

**验证点**：`bun test apps/gateway/src/tmux-client/local-external-connection.test.ts` 和 `bun test apps/gateway/src/tmux-client/ssh-external-connection.test.ts` 全部通过。

### 任务 9: DB 层测试

**涉及文件**：
- `apps/gateway/src/db/` 下相关测试（若有 device CRUD 测试则更新）

**改动内容**：
- 验证 `createDevice` 写入 `defaultWorkingDir`
- 验证 `updateDevice` 更新 `defaultWorkingDir`
- 验证 `getDeviceById` 正确返回 `defaultWorkingDir`

**验证点**：DB 测试通过。

### 任务 10: 全量构建验证

**改动内容**：
1. `bun run build` 全量构建通过
2. `bun test` 全量测试通过（排除 integration 测试）
3. 类型检查无错误

## 测试策略

### 单元测试（必须）
- local-external-connection: 验证 `createWindow`、`closeWindowInternal`、`ensureSession`、`configureSessionOptions` 的 tmux 命令参数
- ssh-external-connection: 同上，适配 SSH shell-quoted 格式
- DB CRUD: 验证 `defaultWorkingDir` 的读写和 NULL 归一化

### 集成测试（可选，需本地 tmux）
- 在 dev 模式下创建 device，设置 `defaultWorkingDir` 为特定目录，新建窗口后验证 `pwd` 输出

### 跨平台验证
- macOS (launchd) + Linux (systemd): 服务以安装目录为 cwd，验证新窗口不再继承安装目录
- SSH device: 验证远程 `remoteHomeDir` 和自定义 `defaultWorkingDir` 的行为

## 验收标准

1. **核心功能**：新建终端窗口在用户 home 目录打开（默认行为），不再在安装目录打开
2. **自定义目录**：device 设置了 `defaultWorkingDir` 后，新窗口在指定目录打开
3. **留空行为**：`defaultWorkingDir` 为空/NULL 时，local 使用 `homedir()`，SSH 使用远程 home
4. **前端 UI**：设备表单中可编辑默认工作目录，保存后生效
5. **向后兼容**：已有 device 无需任何操作即可正常工作（migration 加列，默认 NULL = home）
6. **session 共享兼容**：已连接的 session 在 device 配置变更后，通过重连自动获取新的 `default-path`
7. **所有现有测试通过**

## 风险和注意事项

### tmux 版本兼容

- `default-path` 是 tmux 3.2+ 选项。tmex 最低要求 tmux 3.0（control mode）。对 3.0/3.1 用户，`set-option default-path` 会静默失败（`runTmuxAllowFailure`），但 `createWindow()` 中显式的 `-c` 参数可覆盖，功能不受影响。

### 路径验证

- 后端**不校验**路径是否存在——tmux 本身在 `-c` 目录不存在时会回退到 home 或当前目录。前端可加一条 hint 提示用户输入绝对路径。
- SSH device 的路径是远程路径，网关无法验证。

### 安全边界

- `defaultWorkingDir` 作为 tmux `-c` 参数传入，tmux 自身会安全处理。但仍需确保参数不包含 shell 注入风险。
- local 端：`-c` 参数直接传给 `Bun.spawn` 的 argv（已 escaped），无注入风险。
- SSH 端：通过 `quoteShellArg()` 进行 shell 转义，安全。

### 重连行为

- 更改 `defaultWorkingDir` 时触发 pushSupervisor 重连：会导致终端短暂断连（已有终端的 tmux session 不会被销毁，重连后恢复）。这是现有的 session/host 变更行为，用户预期一致。

### 不影响 ws-borsh 协议

- `TmuxCreateWindowSchema` 不需要新增字段。工作目录由 gateway 根据 device 配置在服务端决定，前端无需关心。

### 不影响 parking window

- `createParkingWindow()` 创建的临时窗口（`sleep 30`）不需要工作目录，保持现状。

### i18n 生成文件

- 修改 `en_US.json` / `zh_CN.json` 后必须运行 `bun run build:i18n` 重新生成 `resources.ts` 和 `types.ts`。禁止手动编辑生成文件。
