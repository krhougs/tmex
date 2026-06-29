# Plan: Issue #34 — 修复文件浏览器中 CJK（非 ASCII）文件名显示为八进制转义

## 背景

### 问题描述

文件浏览器中，文件名包含非 ASCII 字符（如中文、日文、韩文）时，显示为八进制转义序列（如 `三` 显示为 `\344\270\211`），且这些文件无法打开（提示"文件不存在"）和下载。

### 根因

`apps/gateway/src/files/rsync.ts` 的 `baseSubprocessEnv()` 函数（第 52-62 行）为所有 rsync 子进程强制设置 `LC_ALL=C`。GNU rsync（Linux 生产环境）在 C locale 下，`--list-only` 的输出会将非 ASCII 字节转义为八进制序列（`\NNN`），而 macOS 的 openrsync 不做此转义，因此开发环境未能复现。

### 传播链

1. `rsync.ts:60` — `LC_ALL=C` 导致 GNU rsync `--list-only` 输出八进制转义文件名
2. `rsync.ts:195-216` `parseListOnly()` — 正则捕获 `m[9]` 直接取用转义后的字符串，无反转义逻辑
3. `device-storage.ts:130-140` `entryToDto()` — 将转义后的 `entry.name` 直接写入 `FileEntryDto.name` 和 `path`
4. `api/files.ts:172` — JSON 响应原样返回
5. 前端 `files-tab.tsx` — `{entry.name}` 直接渲染转义串
6. 后续 stat / open / download 请求携带转义后的路径，与真实磁盘路径不匹配 → rsync 报 not_found

### 影响范围

- **显示**：所有含非 ASCII 字符的文件/目录名在文件浏览器中显示为八进制转义序列
- **打开/下载**：前端用转义后的路径请求后端 → rsync stat/copy 找不到文件
- **上传到含非 ASCII 名称的目录**：`statViaRsync()` 解析出错误目录名
- **仅影响 Linux（GNU rsync）部署**；macOS（openrsync）不受影响

## Owner 的明确要求

1. **跨平台兼容性**：修复方案必须在 macOS（openrsync）和 Linux（GNU rsync）上都能正确工作
2. **测试要写清楚**：单元测试覆盖各种边界情况

## 设计思路

采用**双重防御**策略，保持 `LC_ALL=C` 不变（它确保 rsync 输出格式的确定性解析）。

### 第一层防御：rsync 参数 `--8-bit-output`

在 `rsyncListArgs()` 生成的参数列表中加入 `--8-bit-output`（GNU rsync 短写 `-8`），告知 rsync 不要转义非 ASCII 字节，直接按原始字节输出文件名。

- **GNU rsync**：支持 `--8-bit-output`（rsync 3.x 标准选项），加上后即使 `LC_ALL=C` 也不再转义
- **macOS openrsync**：自身不转义（即本身就是 8-bit 输出行为），且 `--8-bit-output` 在其 `--help` 输出中存在，不会报错
- **LC_ALL=C 保留**：日期格式（`YYYY/MM/DD HH:MM:SS`）、权限格式、大小格式的确定性解析依赖它

### 第二层防御：`parseListOnly()` 中添加八进制反转义

作为防御性兜底，在 `parseListOnly()` 的 `name` 提取阶段，对 `\NNN`（三位八进制数字）形式的转义序列进行反转义：将连续的八进制字节还原为原始字节，再按 UTF-8 解码。

这确保：
- 即使 rsync 版本不支持 `--8-bit-output`（极端老版本），也能正确解析
- 即使未来 rsync 行为变化，也有兜底保护

### 改动层次

| 层 | 文件 | 改动 |
|---|---|---|
| rsync 参数 | `ssh-command.ts` | `rsyncListArgs()` 添加 `--8-bit-output` |
| 解析兜底 | `rsync.ts` | 新增 `unescapeOctal()` 函数；`parseListOnly()` 中调用 |
| 无改动 | `device-storage.ts` | 不需要改动（`entryToDto` 已正确传递 name/path） |
| 无改动 | `api/files.ts` | 不需要改动（JSON 序列化已正确处理 UTF-8） |
| 无改动 | 前端代码 | 不需要改动（已正确渲染 UTF-8 字符串） |
| 无改动 | `fileUrl.ts` | 不需要改动（`base64urlEncode` 已正确处理 UTF-8） |

## 详细任务清单

### 任务 1：实现 `unescapeOctal()` 函数

**文件**：`apps/gateway/src/files/rsync.ts`

**改动内容**：

新增导出函数 `unescapeOctal(input: string): string`，用于将 GNU rsync 的八进制转义序列还原为原始 UTF-8 字符。

**逻辑**：
1. 使用正则 `/\\(\d{3})/g` 匹配所有 `\NNN` 形式的转义序列
2. 将匹配到的八进制数字转换为字节值（`parseInt(digits, 8)`），校验范围 0-255
3. 收集连续的转义字节为 `Uint8Array`，用 `TextDecoder` 以 UTF-8 解码
4. 非转义部分原样保留

**注意事项**：
- GNU rsync 的转义是逐字节转义（UTF-8 一个字符可能对应 1-4 个 `\NNN` 序列），必须先收集所有转义字节再统一 UTF-8 解码，不能逐个 `\NNN` 单独解码
- 反斜杠自身的转义：GNU rsync 在 `LC_ALL=C` 下会将文件名中的真实反斜杠 `\` 转义为 `\\`，需要正确处理
- 八进制值超出 0-255 范围时（不应出现，但防御性处理）保持原样
- UTF-8 解码失败时（损坏的字节序列），`TextDecoder` 配合 `fatal: false`（默认行为）用替换字符 U+FFFD 替代

### 任务 2：在 `parseListOnly()` 中调用 `unescapeOctal()`

**文件**：`apps/gateway/src/files/rsync.ts`

**改动内容**：

在 `parseListOnly()` 函数中，对正则捕获的文件名 `m[9]` 调用 `unescapeOctal()`：

```typescript
let name = unescapeOctal(m[9]);
```

**位置**：第 203 行，`let name = m[9];` 改为 `let name = unescapeOctal(m[9]);`

**注意**：symlink 的 ` -> target` 分割在反转义之后进行（先反转义完整的 `m[9]`，再做 arrow 分割），因为 symlink target 也可能包含非 ASCII 字符。不过 symlink target 在此处被丢弃（`name = name.slice(0, arrow)`），所以对功能无影响。重要的是 symlink 自身的名字部分已被正确反转义。

### 任务 3：`rsyncListArgs()` 添加 `--8-bit-output`

**文件**：`apps/gateway/src/files/ssh-command.ts`

**改动内容**：

在 `rsyncListArgs()` 函数中，在 `--list-only` 后面添加 `--8-bit-output` 参数：

```typescript
export function rsyncListArgs(spec: RsyncDeviceSpec, remotePath: string): string[] {
  const args = ['--list-only', '--8-bit-output'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, remotePath));
  return args;
}
```

**原因**：
- 这是第一层防御，告知 GNU rsync 直接输出原始字节，避免八进制转义
- 只需在 `--list-only`（列目录）场景添加，`rsyncCopyArgs` / `rsyncUploadArgs` 不涉及文件名解析，无需此标志

### 任务 4：单元测试 — `unescapeOctal()`

**文件**：`apps/gateway/src/files/rsync.test.ts`

**新增 `describe('unescapeOctal')` 测试组**，覆盖以下场景：

| 用例 | 输入 | 期望输出 | 说明 |
|---|---|---|---|
| 纯 ASCII | `'hello.txt'` | `'hello.txt'` | 无转义，原样返回 |
| 单个中文字符 | `'\\344\\270\\211.md'` | `'三.md'` | `三` = UTF-8 `E4 B8 89` = 八进制 `344 270 211` |
| 多个中文字符 | `'\\344\\270\\211\\347\\224\\263.md'` | `'三申.md'` | 两个连续 CJK 字符 |
| 混合 ASCII 与 CJK | `'2022-\\346\\274\\224\\347\\244\\272.md'` | `'2022-演示.md'` | ASCII 与 CJK 交错 |
| 完整 issue 样例 | 完整八进制转义串 | `'三申机型2022-演示流程设计.md'` | 复现 issue 中的原始样例 |
| 日文片假名 | 对应八进制序列 | 日文文件名 | 覆盖日文场景 |
| 韩文音节 | 对应八进制序列 | 韩文文件名 | 覆盖韩文场景 |
| 带空格和 CJK | 混合序列 | 正确还原 | 空格不被转义（0x20 < 0x80） |
| 真实反斜杠 | `'a\\\\b'` | `'a\\b'` | `\\\\` 是 rsync 对真实 `\` 的转义 |
| 无效八进制（防御） | `'\\999'` | `'\\999'`（原样） | 超出八进制范围，不是合法转义 |
| 空字符串 | `''` | `''` | 边界情况 |
| 部分转义（2位数字后跟非数字） | `'\\34x'` | `'\\34x'`（原样） | 不是完整的三位八进制序列 |
| symlink 名含 CJK | `'\\344\\270\\211 -> /target'` | `'三 -> /target'` | 确保 symlink 行也被反转义 |

### 任务 5：单元测试 — `parseListOnly()` 扩展

**文件**：`apps/gateway/src/files/rsync.test.ts`

在现有 `describe('parseListOnly')` 测试组中**新增**以下用例：

| 用例 | 说明 |
|---|---|
| `parses GNU rsync output with octal-escaped CJK names` | 模拟 GNU rsync `LC_ALL=C` 输出（文件名为八进制转义的中文），验证 `parseListOnly` 返回的 `entry.name` 是正确的 UTF-8 中文，`entry.type` / `entry.size` / `entry.modifiedAt` 正确 |
| `parses mixed ASCII and escaped names in same listing` | 一个目录包含 ASCII 文件和 CJK 文件，验证全部正确解析 |
| `handles escaped directory names` | 目录名含 CJK 的八进制转义，验证 `type === 'dir'` 且 `name` 正确反转义 |
| `handles escaped symlink names with arrow` | symlink 名含 CJK 八进制转义且有 ` -> target`，验证 `name` 正确反转义且 target 被剥离 |
| `handles already-decoded UTF-8 names (openrsync)` | 模拟 macOS openrsync 输出（文件名直接是 UTF-8），验证不受反转义影响（无转义序列则原样返回） |

### 任务 6：单元测试 — `rsyncListArgs()` 更新

**文件**：`apps/gateway/src/files/ssh-command.test.ts`

更新现有 `rsync arg builders` 测试组中与 `rsyncListArgs` 相关的断言：

- `'list args (local)'`：期望输出从 `['--list-only', '/a/']` 改为 `['--list-only', '--8-bit-output', '/a/']`
- `'list args (ssh) include -e'`：期望输出从 `['--list-only', '-e', 'ssh -p 22', "u@h:'/a/'"]` 改为 `['--list-only', '--8-bit-output', '-e', 'ssh -p 22', "u@h:'/a/'"]`

## 测试策略

### 单元测试（`bun test`）

全部在 `apps/gateway/src/files/` 目录下的测试文件中完成，不依赖外部 rsync 进程或网络。

1. **`rsync.test.ts`**：
   - `unescapeOctal()` 函数的全部边界用例（任务 4）
   - `parseListOnly()` 处理八进制转义输入的用例（任务 5）
   - 现有测试应全部通过（不破坏已有行为）

2. **`ssh-command.test.ts`**：
   - `rsyncListArgs()` 的断言更新（任务 6）
   - 现有测试应全部通过

### 验证命令

```bash
# 在仓库根目录执行
bun test apps/gateway/src/files/rsync.test.ts
bun test apps/gateway/src/files/ssh-command.test.ts

# 全量测试确保无回归
bun test
```

### 跨平台验证

- **macOS（openrsync）**：开发环境直接跑 `bun test`；openrsync 本身不转义非 ASCII 文件名，`--8-bit-output` 标志不会导致报错或行为变化，`unescapeOctal()` 对无转义的 UTF-8 字符串原样返回
- **Linux（GNU rsync）**：通过单元测试模拟 GNU rsync 的八进制转义输出来验证解析逻辑。生产验证需在 Linux 部署环境中测试含 CJK 文件名的目录

## 验收标准

1. `bun test` 全量通过，无回归
2. `unescapeOctal()` 单元测试覆盖：纯 ASCII、单 CJK 字符、多 CJK 字符、混合 ASCII/CJK、日文/韩文、反斜杠转义、无效输入
3. `parseListOnly()` 能正确解析包含八进制转义文件名的 GNU rsync 输出
4. `parseListOnly()` 对 openrsync 的直接 UTF-8 输出仍然正确（无回归）
5. `rsyncListArgs()` 输出包含 `--8-bit-output` 参数
6. 生产验证（Linux 部署环境）：含 CJK 文件名的目录能正确列出、打开、下载

## 风险和注意事项

### 低风险

1. **`--8-bit-output` 兼容性**：
   - macOS openrsync 已验证支持此标志（`--help` 中列出）
   - GNU rsync 3.x 全系列支持
   - 极老版本（rsync 2.x）可能不认识此标志并报错，但生产环境普遍为 3.x+，且有第二层防御兜底

2. **反斜杠处理**：
   - GNU rsync 在 `LC_ALL=C` + 无 `--8-bit-output` 时，真实文件名中的 `\` 会被转义为 `\\`
   - 加上 `--8-bit-output` 后，rsync 不做任何转义，`\` 原样输出
   - `unescapeOctal()` 需正确区分：
     - 输入来自 `--8-bit-output` 模式：无转义序列，`unescapeOctal` 原样返回（正确）
     - 输入来自非 `--8-bit-output` 模式（兜底场景）：`\\` 应还原为 `\`，`\NNN` 应还原为字节
   - 实际上两层防御同时生效时，第二层（`unescapeOctal`）处理的输入已是原始 UTF-8，不会误触发转义处理

3. **正则匹配**：
   - `LIST_RE` 正则的 `(.*)$` 部分已能匹配 UTF-8 字节和八进制转义序列（`.` 默认匹配除 `\n` 外的任意字符），无需修改

### 注意事项

1. **不修改 `LC_ALL=C`**：保留此设置以确保 rsync 输出格式（日期、权限、大小）的确定性解析
2. **不修改前端代码**：bug 完全在 gateway 层解决，前端只需正确渲染 gateway 返回的 UTF-8 字符串
3. **不修改 `device-storage.ts`**：`entryToDto()` 是 passthrough，不需要额外处理
4. **不涉及数据库**：文件路径不持久化到数据库，无迁移需要
5. **生成文件**：本次改动不涉及 i18n 等生成文件，无需 `bun run build:i18n`
