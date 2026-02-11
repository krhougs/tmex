# Prompt Archive

## 用户原始需求

修复以下问题：

1. 通过 ssh agent 方式连接无法连接到对方机器，已知当前用户 shell 里直接 `ssh 127.0.0.1` 是可以登陆的，但是通过 tmex 则不行。
2. gateway 启动时应该给所有 chat 推送上线信息。

## 本轮实现过程中的补充 Prompt（系统内隐式）

- 要求遵循仓库 `AGENTS.md` 规范。
- 使用 Bun 运行测试并验证修改。
