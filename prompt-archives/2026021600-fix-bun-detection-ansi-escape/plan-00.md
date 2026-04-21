# 计划：修复 Bun 检测因 ANSI 转义码失败问题

## 背景

用户在执行 `bunx tmex-cli init` 时遇到错误：

```
Failed to execute bun --version. Please verify Bun installation.
```

此错误导致 tmex-cli 初始化流程中断。

## 问题分析

错误来源于 `packages/app/src/lib/bun.ts` 中的 `checkBunVersion` 函数。该函数通过 `findBunBinary` 定位 Bun 可执行文件，然后执行 `bun --version` 验证版本。

`findBunBinary` 首先调用 `locateBunFromShell`，该方法通过 `zsh -lic 'command -v bun'` 在 shell 中查找 Bun 路径。然而，在交互式 shell 环境下，该命令的输出包含 **ANSI 转义码**（特别是 iTerm2 的 shell 集成序列和其他终端控制序列）。这些转义码被保留在 `stdout` 中，导致返回的路径字符串包含非路径字符（如 `\x1b]1337;...\x07`）。

当该路径被传递给 `child_process.spawn` 时，系统无法找到对应的可执行文件，因此 `bun --version` 执行失败，抛出 `bun.versionExecFailed` 错误。

## 根本原因

`locateBunFromShell` 函数未对 shell 命令的输出进行清理，直接使用 `trim()` 仅去除空白字符，无法移除 ANSI 转义序列。

## 解决方案

### 方案一：清理 ANSI 转义码（推荐）

修改 `locateBunFromShell` 函数，在 `trim()` 之前增加一个步骤，使用正则表达式移除所有 ANSI 转义序列（包括 CSI 序列 `\x1b[...` 和 OSC 序列 `\x1b]...\x07`）。

**优点**：
- 直接、可靠，不依赖外部环境变量
- 代码改动小，易于测试
- 不引入新的依赖

**缺点**：
- 需要编写或引入 ANSI 转义码清理逻辑

### 方案二：设置 `TERM=dumb` 环境变量

在执行 `zsh -lic` 命令时设置环境变量 `TERM=dumb`，以抑制 shell 集成序列的输出。

**优点**：
- 可能避免转义码的产生
- 无需清理输出

**缺点**：
- 依赖 shell 对 `TERM` 变量的响应，可能在某些配置下仍输出转义码
- 环境变量可能被 shell 配置覆盖

### 方案三：使用 `which` 命令替代 `command -v`

通过 `spawn('which', ['bun'])` 查找路径，避免使用交互式 shell。

**优点**：
- 可能不产生转义码

**缺点**：
- `which` 命令并非所有系统都预装（macOS 有，但可能不在 PATH 中）
- 仍然需要处理可能的转义码（如果 shell 配置添加了输出钩子）

## 设计决策

采用 **方案一**（清理 ANSI 转义码），因为它最直接且可控。我们将实现一个简单的 `stripAnsi` 函数，使用正则表达式匹配并移除常见的 ANSI 转义序列。

## 实施步骤

1. 在 `packages/app/src/lib/bun.ts` 中添加 `stripAnsi` 辅助函数。
2. 修改 `locateBunFromShell` 函数，在返回路径前对 `stdout` 应用 `stripAnsi`。
3. 添加单元测试验证 `stripAnsi` 函数。
4. 运行现有测试确保无回归。
5. 构建 `tmex-cli` 并手动验证 `bunx tmex-cli init` 可正常执行。

## 代码改动

### `packages/app/src/lib/bun.ts`

```typescript
function stripAnsi(text: string): string {
  // 移除 CSI 序列 \x1b[... 和 OSC 序列 \x1b]...\x07
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
}

async function locateBunFromShell(): Promise<string | null> {
  const result = await runCommand('zsh', ['-lic', 'command -v bun'], { stdio: 'pipe' }).catch(
    () => null
  );

  if (!result || result.code !== 0) {
    return null;
  }

  const bin = stripAnsi(result.stdout).trim();
  if (!bin) {
    return null;
  }

  return bin;
}
```

## 测试计划

1. **单元测试**：为 `stripAnsi` 函数编写测试，验证其能正确移除各类 ANSI 序列。
2. **集成测试**：运行 `bun test src` 确保现有测试通过。
3. **手动测试**：
   - 在本地执行 `bun run build:tmex` 构建 CLI。
   - 运行 `bunx tmex-cli init --dry-run`（或使用 `--help`）验证不再出现 `bun.versionExecFailed` 错误。
   - 验证 `bunx tmex-cli doctor` 能正确报告 Bun 版本。

## 风险评估

- **低风险**：改动仅限于路径清理逻辑，不影响核心功能。
- **回归风险**：如果 `stripAnsi` 函数过度清理，可能误删路径中的合法字符（极不可能）。
- **兼容性风险**：正则表达式可能无法覆盖所有可能的 ANSI 序列变体。若发现遗漏，可扩展表达式或改用 `strip-ansi` 包（已作为间接依赖存在）。

## 回滚方案

若出现问题，可回退到修改前的版本，或采用方案二（设置 `TERM=dumb`）作为备选。

## 验收标准

- `bunx tmex-cli init` 不再因 `bun.versionExecFailed` 失败。
- `tmex-cli doctor` 正确显示 Bun 版本。
- 所有现有测试通过，包括 `bun run --filter tmex-cli test`。