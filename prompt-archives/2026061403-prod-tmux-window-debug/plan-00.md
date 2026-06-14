# 生产 tmux window 报错调查计划

## 背景

远端 `ssh dns` 上运行的生产 tmex 持续出现 `can't find window: @0_0_bash_1`、`can't find window: @56_0_bash_1` 这类 tmux 报错。用户要求先调查并给出结论与修复方案，不实施代码或生产变更。

## 注意事项

- 必须使用新 worktree 做代码调查，避免污染当前工作区。
- 禁止修改本机生产 tmex 服务和安装目录。
- 远端排查以只读命令为主：systemd 日志、版本信息、tmux 状态、生产构建元信息。
- 根因未明确前不提出拍脑袋式修复；修复方案必须能对应证据。

## 任务清单

1. 创建隔离 worktree，用于读取仓库代码和定位相关逻辑。
2. 在 worktree 中检索 tmux 窗口、pane、target 标识相关实现。
3. 通过 `ssh dns` 只读获取 systemd 报错日志、tmex 版本、OS 版本、tmux 版本和当前 tmux 状态。
4. 查阅 tmux / systemd / 相关运行时文档，确认不同版本对 target 解析、窗口 ID、pane ID、命令失败行为的定义。
5. 对照代码、日志行号和版本行为，形成根因结论。
6. 输出修复方案、验证方案、风险点；不实施修复。

## 验收标准

- 明确说明报错由哪个代码路径触发，引用 systemd 日志行号或堆栈。
- 明确说明远端 tmex、tmux、OS 版本信息。
- 结论解释 `@0_0_bash_1` / `@56_0_bash_1` 为什么会被 tmux 当作 window target，以及为什么找不到。
- 修复方案包含代码层改法、测试或复现验证方案、生产发布注意事项。
