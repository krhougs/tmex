# Canonical Terminal Checkpoint Continuity 实施结果

## 结果

- 保持 canonical wire schema 不变，在 checkpoint data 尾部追加自包含 ANSI continuation trailer。
- `tmex-terminal` 导出当前 SGR 与已跟踪 mode；只有 pane epoch/terminal seq 与 capture barrier 完全一致时才使用，unknown 明确回到 default SGR。
- control/fallback 共用 pane frame 格式和解析器；恢复 DECSTBM、origin、insert、wrap、cursor visibility、application cursor/keypad 与 cursor。
- trailer 计入 fixed overhead，文本可以按既有策略截断，但 trailer 本身不会被截断。
- psmux 的占位 mode 不覆盖 exact emulator state；未加入无法可靠表达 unknown 的 tab-stop 恢复。

## Review 结论

1. capture/base sequence/trailer/cursor-region 定序无阻塞；tmux info/capture 双命令原子性是既有协议边界，不在本轮扩张。
2. psmux format 实现核对后采信兼容修正：exact emulator mode 优先。
3. 最终 diff 无无关格式化、临时探针或 wire schema 变化。

## 验证

- `cargo test -p tmex-gateway -p tmex-terminal`：306 + 37 项通过。
- `cargo clippy -p tmex-terminal --all-targets -- -D warnings`：通过。
- `cargo fmt --all --check`、`git diff --check`：通过。
- tmux 3.7b 独立 socket 验证了目标 frame fields 和 `capture-pane -e -N` 样式输出。
- Gateway 全量 clippy 的失败仅来自未改动 `key_input.rs` 中既有 deny lint；未为本任务扩项。
