# Plan 00 执行结果（第二轮追修）：回车后命令回显粘连

时间：2026-02-11

## 复盘结论

用户继续反馈“未修好”，并给出样例 `111zsh: command not found: 111`。

进一步分析后确认：

1. 仅靠“输出模式锁定（只收 `%output` 或 `%extended-output`）”有误伤风险，会在某些场景丢掉另一通道的真实不同内容。
2. 本问题更稳妥的策略是“跨模式同内容去重”，而不是“硬锁某个模式”。

## 最终修复

### 1）后端 parser 改为跨模式相邻同内容去重

- 文件：`apps/gateway/src/tmux/parser.ts`
- 关键变更：
  - 移除 `outputTransportMode` 锁定逻辑。
  - 新增 `lastOutputFrame` 记录上一帧（mode/paneId/data）。
  - 新增 `emitTerminalOutput(mode, paneId, data)`：
    - 若当前帧与上一帧“跨模式 + 同 pane + 字节完全一致”则去重。
    - 否则正常下发。
- 保留此前 CR/LF 归一化与跨包处理逻辑。

### 2）前端保留 convertEol 与实时输出兜底

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 保留：
  - `convertEol: true`
  - 实时输出归一化（跨包 CR/LF 状态）

### 3）测试更新

- 文件：`apps/gateway/src/tmux/parser.test.ts`
- 新增/调整：
  - `%output` 与 `%extended-output` 相邻同内容去重。
  - `%output` 与 `%extended-output` 不同内容不丢失。
  - 其余 CR/LF 与 flush 行为测试继续通过。

## 验证结果

- `bun test apps/gateway/src/tmux/parser.test.ts`：17 pass
- `bun run --cwd apps/gateway build`：通过
- `bun run --cwd apps/fe build`：通过（既有 CSS warning）

## 当前状态

已将策略从“模式锁定”升级为“跨模式同内容去重 + 不丢不同内容”，理论上更符合 tmux control mode 在 pause-after/extended-output 下的实际行为，也更能覆盖用户给出的粘连场景。

## 追加验证（当前会话）

时间：2026-02-11（追加）

### 关键观察

- 使用 `tmux pipe-pane -O` 抓到原始字节后，可见标题序列 `ESC k111 ESC \\` 与错误输出相邻。
- 该序列中的 `111` 在浏览器端路径里可能被误显示为可见文本，形成 `111zsh: command not found: 111` 的粘连现象。

### 代码状态（当前）

- 后端 `apps/gateway/src/tmux/parser.ts` 已在 `%output/%extended-output` 解析链路中加入标题序列剥离（`ESC k ... ESC \\`）。
- 保留跨模式相邻同内容去重与 CR/LF 归一化（含跨包状态）。
- 前端 `apps/fe/src/pages/DevicePage.tsx` 保留 `convertEol: true` 与实时输出 CR/LF 兜底归一化。

### 回归验证

- `bun test apps/gateway/src/tmux/parser.test.ts`：17 通过，0 失败。
- `bun test apps/gateway/src/ws/index.test.ts`：2 通过，0 失败。
- `bun test apps/gateway/src/tmux/connection.test.ts`：4 通过，0 失败。
- `bun run --cwd apps/gateway build`：通过。
- `bun run --cwd apps/fe build`：通过（存在既有 CSS warning，非本次改动引入）。

### 结论

- 当前代码与测试结果一致，关键链路（输入→tmux→输出→ws→xterm）未出现回归失败。
- 用户最新反馈已确认“问题修好”，本轮作为最终回归闭环。
