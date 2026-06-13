# Prompt 存档：run_command + headless ghostty 终端工具重构

## 触发问题

> 我发现有一个很严重的问题，capture_screen只能获取当前屏幕内的问题，这很合理。但是当send_input发送之后，终端返回了一些很长的内容，返回值就会被截断。我们需要设计一些更合理的工具来操作执行命令这个场景

## 关键往返（设计决策）

- 完成判定方向：**C（混合）**，并补充要考虑 1) TUI/alternate 2) 非类 bash shell 3) 网络设备 shell；要求调研 Warp 如何区分命令输出。
  - 调研结论：Warp 用 OSC 133 shell 集成；tmux 不支持 OSC 133 且 capture-pane 吃掉标记 → 必须读原始流。
- > A+B混合，优先OSC133；我之前也想说这里的命令执行tool 应该有能力读取终端stream
- > 我们现在有方法能拿到OSC9 OSC77之类的东西，tmux有passthrough mode，OSC 133应该也能拿得到
  - → 复用现有 `PaneStreamParser`（已抽 OSC 9/99/777/1337 + tmux passthrough）加 OSC 133。
- > 同时我们也应该改造提示词，让agent自己detect环境，选择是run_command还是读写屏幕，但是我希望读写屏幕也应该是基于stream的而不是单纯的capture
  - → 读屏数据源用服务端 headless ghostty（渲染态网格）。
- AskUserQuestion：读屏数据源=**Headless ghostty**；推进方式=**一次性整套**。
- > 你想用服务端的ghostty我觉得没啥问题，我也赞同这种tool call完全放在服务端，但是你必须考虑到资源复用和内存泄漏问题
  - → §5 资源复用/防泄漏列为一等约束（引用计数注册表 + bounded scrollback + 驱逐 + 显式 free + 生命周期挂钩）。
- > 你还是没有说清楚TUI和网络设备这种非标shell下怎么处理
  - → §4a/§4b 具体化：TUI 走 ghostty 渲染态交互、run_command 检出 alternate 即 entered_tui；网络设备 mode=cli（学提示符/关分页/提示符重现判完成/--More-- 自动续翻/错误串启发，无退出码）。
- > 这次我们开一个独立的worktree干活
  - → worktree `run-command-headless-ghostty`。

## Spike 结论
ghostty-vt.wasm 在 Bun 里 headless 跑通（getGhosttyBindings + writeVt + formatViewport 出渲染态纯文本），gating 风险解除。

## 备注
完整设计见同目录 `plan-00.md`。
