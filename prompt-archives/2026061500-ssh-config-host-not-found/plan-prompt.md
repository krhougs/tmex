# Prompt 存档：SSH 设备 Host not found 排查与修复

## 初始 prompt（排查）

开一个新的 worktree，base 为 main，排查：

当前有个 dev server http://127.0.0.1:19883/devices （和你不在一个 worktree 上但是你可以在上面进行只读排查）
上面我新添加的两个叫做 pve 和 pve2 的设备无法连接，提示
“Host not found: Unable to resolve hostname. Please check DNS or hostname configuration.”

1. 请你检查代码确保他打出来的是实际错误信息而不是自己乱 handle 的错误
2. 我确定这个机器连的上，请你检查一下哪里出问题了

## 后续 prompt（修复方向确认）

按照你说的修复方案来。
前端里 ssh config 位置输入框也应该挪去认证方式下面的二级设置中，且只在选择了 SSH Config 作为认证方式时生效。

## #3 实现取舍（AskUserQuestion 结论）

「真实错误透出」选定方案：**raw 拼进 last_error**（不新增 DB 列、不改分类器映射）。

## 执行约束（/goal）

按照项目规范执行 plan，注意 worktree 和 subagent 的使用。
