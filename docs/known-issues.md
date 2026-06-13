# 已知问题（Known Issues）

本文件登记尚未解决的已知问题。解决后从本文件移除（并在对应模块文档留存背景）。

## KI-2：缺真 tmux 全链路 e2e 集成测试（run_command）

- **背景**：run_command/流式读屏的各层已分别单测覆盖（真 OSC 字节过 parser、真 ghostty wasm、run_command 全分支以 fake emulator）。
- **现状**：缺一条「真 tmux → control-mode 流 → parser → emulator → run_command」的端到端集成测试（验证长输出不丢/退出码正确/vim 等 alternate 屏被拒）。
- **解决方向**：参考 `local-external-connection.integration.test.ts` 的 `-L` 临时 socket 模式，起带 control-mode 流的真实会话跑 run_command。
- **详情**：`docs/agent/2026061303-run-command-headless-ghostty.md`。
