# Prompt archive: Windows control command timeout handling

## 背景

Windows 使用 psmux 作为 tmux-compatible 后端时，Gateway 偶发报错：

```text
tmux control command timed out: capture-pane -p -e -J -N -t %7
```

atomic capture 会连续排入 metadata、visible capture 和 history capture。当前 `ControlModeCommandQueue` 在每条 command 写入时就启动 timer，因此后续 command 在等待队头期间也会消耗自己的超时预算。heartbeat command 的 rejection 路径还可能遗留 pending 状态，随后误判 control connection 失活。

## 需求

- psmux 修复服务端根因；tmex 同时修复客户端队列 deadline 和 heartbeat cleanup，形成防御性闭环。
- 对照 tmux command queue 的顺序完成语义，不通过扩大 timeout 掩盖问题。
- 补充长期有效的真实回归测试。
- Windows 真机完整验证通过后才创建 psmux 上游 PR。

完整跨仓库计划见 Vibex 主工作面：

```text
prompt-archives/2026080300-windows-control-mode-timeout/plan-00.md
```
