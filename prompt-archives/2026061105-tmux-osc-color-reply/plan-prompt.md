# Prompt 存档

## 原始 prompt（2026-06-11）

> 检查一下终端类型、颜色相关的逻辑，解决一个问题：
> 本地codex tui的输入框，在其他普通终端里打开是有一个灰色打底的，但是在tmex中则没有画背景
>
> 我怀疑是终端类型造成的

## 背景与调查结论

- codex TUI（及同类 ratatui 程序）在启动时通过 OSC 10/11 查询终端前景/背景色，
  并据此混合出输入框（composer）的灰色底色。参考 openai/codex#22761、#8852。
- tmex 的 pane 跑在 tmux 内，OSC 10/11 查询由 tmux 拦截代答（不会透传到前端
  ghostty-wasm，gateway 的 pane-stream-parser 也只透传白名单 OSC）。
- tmux 3.4 代答逻辑（input.c: input_osc_10/11）：优先 `tty_default_colours`
  （window-style 等），否则 fallback 到 attached client 上报的 tty.fg/tty.bg。
  tmex 的控制模式 client 无法上报真实颜色，实测 tmex session 内查询返回
  fg=bg=rgb:0000/0000/0000（纯黑），codex 混色结果与底色相同 → 灰底不可见。
- 实验验证：对 window 设置 `window-style 'fg=#d0d0d0,bg=#262626'` 后，OSC 10/11
  返回正确颜色；tmux 3.4 不支持 session 级 window option（落到当前 window），
  需逐 window 设置 + `after-new-window` hook 覆盖新窗口；不能用 `-g`（会污染
  同 server 其他 session）。

## 后续 prompt（同日）

> 我新开的codex还是一样的问题，需要重启整个tmux session吗

调查结论：window-style 修复后 codex 仍不画底色。在 tmex pane 内实跑 codex 0.139.0，
capture-pane -e 显示界面无任何 48;2 SGR；以 `COLORTERM=truecolor codex` 重跑后出现
`48;2;64;64;64`（基于 OSC 11 的 #262626 混出的灰底）。第二个根因：tmux 不传播
COLORTERM，codex 据此判定不支持真彩色而跳过混色底色。补充修复：gateway 在受管
session 上 `set-environment COLORTERM truecolor`。

## 修复方案

- gateway 新增配置 `TMEX_TMUX_WINDOW_STYLE`，默认 `fg=#d0d0d0,bg=#262626`
  （与前端 seoul256 dark 主题一致），`off` 关闭。
- local / ssh 两个 external connection 的 configureSessionOptions：
  - `set-hook -t <session> after-new-window "set-option -w window-style '<style>'"`
  - `list-windows` 后对每个现有 window `set-option -w -t <window_id> window-style <style>`
- 更新对应单测（ssh 端"no longer provisions hooks"断言需放行 after-new-window）。
