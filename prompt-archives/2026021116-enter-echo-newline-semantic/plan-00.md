# Plan 00：回车后命令回显错位（CR/LF 语义）修复

时间：2026-02-11

## 背景

用户给出新样例显示：执行 `111` 后出现 `111zsh: command not found: 111`。该表现与“换行后未回到行首”高度一致，说明输出链路中存在裸 `LF` 未补 `CR` 的情况。

## 目标

1. 修复实时输出中裸 `LF` 导致的续列显示错位。
2. 维持 `%output/%extended-output` 去重策略不回退。
3. 保持对 chunk 边界（上包 `CR` + 下包 `LF`）的正确处理。

## 实施任务

### 任务 1：后端 parser 对实时输出做 LF->CRLF 归一化（含跨包状态）

- 文件：`apps/gateway/src/tmux/parser.ts`
- 内容：
  - 新增输出字节归一化函数：仅对“未被 `CR` 前导的 `LF`”补 `CR`。
  - 新增跨包状态 `lastOutputEndedWithCR`，避免 `CR` 与下一包 `LF` 组合时重复补 `CR`。
  - `%output` 与 `%extended-output` 分支统一走归一化后再 `onTerminalOutput`。

### 任务 2：前端实时输出兜底归一化（含跨包状态）

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 内容：
  - 新增 `liveOutputEndedWithCR` 状态与二进制归一化函数。
  - 在 `subscribeBinary` 路径中先归一化再写入/缓存。
  - pane 会话切换时重置该状态。

### 任务 3：测试更新

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 内容：
  - 更新 `%output` 相关断言到 `\r\n` 语义。
  - 新增“已含 CRLF 不重复补偿”测试。
  - 新增“跨包 CR + LF 不重复补偿”测试。

### 任务 4：验证

- `bun test apps/gateway/src/tmux/parser.test.ts`
- `bun run --cwd apps/gateway build`
- `bun run --cwd apps/fe build`

## 注意事项

1. 不改 shared 协议和 ws 消息结构。
2. 不改输入发送 API，仅修输出渲染语义。
3. 保持改动聚焦，避免引入无关行为变化。
