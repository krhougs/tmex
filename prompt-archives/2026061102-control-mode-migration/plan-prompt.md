# Prompt 存档：gateway 迁移到 tmux control mode

## 2026-06-11 初始 prompt

> docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md
> 将当前的gateway实现方式迁移到tmux control mode
> 你需要：
> - 阅读tmux最新版本的文档和control mode的具体实现代码，严格按照其规范解析control mode的数据，并为parser的各种边界情况提前准备好测试
> - 确保 "Claude Code 离开 60 秒后通知能弹" 这个行为在重构后依然工作
> - 注意各种时序问题和IO流的边界情况
> - 确保现有通知解析功能正常工作
> - 确保现有全部功能工作正常

## 背景

- 已知问题文档：`docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md`
- 根因：pipe-pane 与 set-hook 都是"后到者顶掉前者"，双 gateway 实例互相抢占
- 方案：迁移到 `tmux -C attach` control mode，`%output` 通知原生支持多客户端订阅
- 关键回归点：Claude Code 通知的 user_present 判定依赖 focus 语义（详见上述文档
  "Control mode 重构注意事项"一节），control client attach 不能让 pane 收到 ESC[I
  焦点事件，否则通知永久静默
