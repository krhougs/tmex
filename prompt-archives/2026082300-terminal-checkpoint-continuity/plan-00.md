# Canonical Terminal Checkpoint Continuity 实施计划

**Goal：** 让 canonical screen checkpoint 同时重建可见 grid 与 barrier 后增量输出所依赖的通用终端延续状态。

**Architecture：** 不扩 canonical wire schema；在现有 snapshot data 尾部追加由 mux barrier metadata 与 `tmex-terminal` 当前 SGR/mode 共同生成的 ANSI continuation trailer。无法证明 emulator identity 时使用显式 default，禁止从最后一个 cell 或应用类型猜测；psmux 仅提供占位值的 mode 在 exact emulator state 可用时不得覆盖它。

## Task 1：导出 SGR continuation

- 修改 `crates/tmex-terminal/src/lib.rs`。
- 从 active cursor template 导出颜色/属性，并导出 emulator 已跟踪的 continuation modes，确定性编码 ANSI。
- 测试 default、indexed/RGB、组合 flags 与 reset 清理。

## Task 2：扩展 barrier metadata

- 修改 `apps/gateway/src-rust/tmux/control_mode_capture.rs`、`capture_history.rs`、`tmux_commands.rs`、`mod.rs`。
- control/fallback 共用字段和解析语义；有界校验 region。tab stops 因无法跨 tmux/psmux 区分“未知”与“显式清空”，不纳入本轮。
- 测试完整、缺失与非法 tmux format 输出。

## Task 3：组装 self-contained checkpoint

- 修改 `apps/gateway/src-rust/tmux/device_session_runtime.rs`、`pane_emulator.rs`。
- 在 body 末尾恢复 SGR、scroll region/modes/cursor；exact emulator state 优先于 mux 占位 mode，状态 trailer 不得被 byte limit 截断。
- 测试背景泄漏、DECSTBM 后增量输出、known/unknown SGR 和小预算 fail closed。

## Gate

```bash
cargo test -p tmex-terminal
cargo test -p tmex-gateway tmux::control_mode_capture
cargo test -p tmex-gateway tmux::device_session_runtime
cargo fmt --check
cargo clippy -p tmex-terminal -p tmex-gateway -- -D warnings
```

完成后由 vibex 主 Agent按完整调用链 Review、实测并验收。
