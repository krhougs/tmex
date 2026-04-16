# Plan 00 执行结果：terminal 空白行修复

时间：2026-04-16

## 完成内容

### 1）提取并覆盖归一化逻辑

- 新增文件：`apps/fe/src/components/terminal/normalization.ts`
- 调整点：
  - 提取 `normalizeHistoryForTerminal()` 与 `normalizeLiveOutputForTerminal()`。
  - `normalizeHistoryForTerminal()` 在将 CRLF 规整为 LF 后，如果 history 末尾存在一个换行，则只裁掉这一个末尾换行，再把中间 LF 转回 CRLF。
- 目的：避免 pane 初次 history 回放时把光标额外推进到下一空白行。

### 2）终端组件改为复用归一化模块

- 修改文件：`apps/fe/src/components/terminal/Terminal.tsx`
- 调整点：
  - 删除内联的 history/live output 归一化实现。
  - 改为从 `./normalization` 导入并复用。

### 3）补充最小失败测试并转绿

- 新增文件：`apps/fe/src/components/terminal/normalization.test.ts`
- 覆盖场景：
  - history 回放末尾换行不应再导致额外一行推进。
  - live output 的分块 `CR` / `LF` 边界不应插入重复 `CR`。

## 验证证据

### Red

- 命令：`bun test apps/fe/src/components/terminal/normalization.test.ts`
- 结果：修复前 2 个 history 相关断言失败，证明测试确实命中问题假设。

### Green

- 命令：`bun test apps/fe/src/components/terminal/normalization.test.ts`
- 结果：`3 pass, 0 fail`

### 类型与现有测试

- 命令：`bunx tsc -p apps/fe/tsconfig.json --noEmit`
- 结果：通过。

- 命令：`bun test packages/ghostty-terminal/src/terminal.canvas.test.ts`
- 结果：`6 pass, 0 fail`

### 手动可观测验证

使用本地 gateway + fe dev server，分别验证了：

1. **冷启动直入普通 shell pane**
   - tmux pane 初始输出：`HELLO_1`、`HELLO_2`、`sh-3.2$`
   - 页面可见内容连续显示为三行，没有在 prompt 前后出现额外空白行。

2. **切换到另一个普通 shell pane**
   - pane 0：`P0_A`、`P0_B`、`sh-3.2$`
   - 切换到 pane 1 后可见内容为：`P1_A`、`P1_B`、`sh-3.2$`
   - 未观察到切 pane 后多出一行空白。

3. **切 pane 后继续产生 live output**
   - 在 pane 1 输入：`printf 'SW1\\nSW2\\n'`
   - 页面可见内容依次为：`P1_A`、`P1_B`、`sh-3.2$printf 'SW1\\nSW2\\n'`、`SW1`、`SW2`、`sh-3.2$`
   - `SW1` 与 `SW2` 之间、以及输出末尾到 prompt 之间未出现额外空白行，未见明显更新错位。

### 额外记录

- 命令：`bun run --cwd apps/fe test:e2e -- tests/ws-borsh-pane-route.spec.ts`
- 结果：失败，但失败表现与既有 E2E 探针/会话环境有关，不能作为本次修复失效证据。

## 结论

本次最小修复已完成，并通过单测、类型检查、现有 ghostty 测试以及两类真实浏览器场景验证。当前证据表明，history 回放末尾多出的一个换行是导致额外空白行的主要来源，本次修复已消除该现象；现阶段无需继续扩大到 ghostty viewport 路径。 
