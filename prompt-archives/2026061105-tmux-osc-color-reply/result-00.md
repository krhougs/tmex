# 执行结果总结

问题有两个叠加的根因，缺一不可：OSC 10/11 颜色查询（混色基准）与 COLORTERM
（真彩色开关）。仅修 window-style 后 codex 仍不画底色，实跑 codex 0.139.0 验证
COLORTERM 为第二根因。

## 根因一：OSC 10/11 代答颜色错误

codex TUI 启动时通过 OSC 10/11 查询终端前景/背景色，并据此混合出输入框的灰色底色
（参考 openai/codex#22761、#8852）。tmex 的 pane 在 tmux 内，查询由 tmux 拦截代答
（不透传到前端 ghostty-wasm）。tmux 3.4 的代答逻辑（input.c: input_osc_10/11）优先取
window-style，否则 fallback 到 attached client 上报的 tty.fg/tty.bg；tmex 的控制模式
client 无法上报真实颜色，实测查询返回 fg=bg=rgb:0000/0000/0000（纯黑），codex 混色
结果与底色同色 → 灰底不可见。与终端类型（TERM=xterm-ghostty）无关。

## 根因二：COLORTERM 缺失

tmux 不传播 COLORTERM（真 ghostty 会设 `COLORTERM=truecolor`），codex 据此判定终端
不支持真彩色，直接跳过混色底色。实证：tmex pane 内 codex 界面无任何 `48;2` SGR；
`COLORTERM=truecolor codex` 后出现 `48;2;64;64;64`（#404040，基于 OSC 11 报告的
#262626 混出）。

## 修复

- `apps/gateway/src/config.ts`：新增 `TMEX_TMUX_WINDOW_STYLE`，默认
  `fg=#d0d0d0,bg=#262626`（前端 seoul256 dark 主题），`off` 关闭。
- `apps/gateway/src/tmux-client/window-style.ts`：新增 `resolveTmuxWindowStyle`，
  校验 style 字符集（值会嵌入 set-hook 命令字符串）。
- local / ssh 两个 external connection 的 `configureSessionOptions` 末尾新增
  `configureWindowStyle()`：
  - `set-hook -t <session> after-new-window "set-option -w window-style '<style>'"`
    （window option 无 session 层，tmux 3.4 实测 `set-option -t <session>` 落在当前
    window，新窗口不继承；不能用 `-g`，会污染同 server 其他 session）
  - `list-windows -F '#{window_id}'` 后对每个现有 window 设置 window-style。
- local / ssh 的 `configureSessionOptions` 同时新增
  `set-environment -t <session> COLORTERM truecolor`（与 TERM_PROGRAM 设置平行）。

## 验证

- 单测：local/ssh connection 测试更新后全部通过；gateway 套件其余 4 个失败
  （telegram html、i18n default language）在干净 main 上同样失败，为既有问题。
- 真实环境：对常驻 tmex session 应用同序列命令后，pane 内 OSC 10/11 查询返回
  `rgb:d0d0/d0d0/d0d0` / `rgb:2626/2626/2626`；hook 对新窗口生效。
- biome/tsc 对改动文件无新增告警（报错均为既有代码行）。

## 注意事项

- codex 只在启动时查询一次颜色，已运行的 codex 需重启才能拿到新颜色。
- session environment 只注入新建 pane；已存在窗口里的 shell 环境已定型，需
  `export COLORTERM=truecolor` 后再跑 codex，或直接开新窗口。
- window-style 对 tmex 前端渲染无影响（前端只消费 %output 原始流）；用普通终端
  attach 受管 session 时 pane 会显示该背景色（与 tmex dark 主题一致，env 可关）。
- 前端 light 主题用户可通过 `TMEX_TMUX_WINDOW_STYLE='fg=#616161,bg=#e1e1e1'` 调整；
  动态跟随前端主题未做（多浏览器客户端主题可能不一致，且 TUI 不会重新查询）。
