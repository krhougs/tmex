# Claude Code OSC 通知不被处理：根因与修复计划

## 背景

tmex gateway 通过 `pane-stream-parser` 从 pipe-pane 原始流中解析 OSC 9 / 777 / 1337 通知。用户反馈 Claude Code 的 OSC 通知不被处理。

## 根因（从 Claude Code 2.1.170 二进制内嵌源码逆向确认）

Claude Code 通知发送逻辑（变量名为编译产物混淆名）：

```js
// 渠道分发
case"iterm2":  notifyITerm2(_)            // OSC 9
case"kitty":   notifyKitty({...,id})      // OSC 99（kitty 桌面通知协议，3 段）
case"ghostty": notifyGhostty({...})       // OSC 777;notify;title;body
// auto：按 attacher_term ?? TERM_PROGRAM 检测，仅 iTerm.app/kitty/ghostty/Apple_Terminal 有效，否则 no_method_available（什么都不发）

// 所有序列发出前经过 X0() 包装：
function X0(H){
  let _=aR8();
  if(_==="tmux")  return`\x1BPtmux;${H.replaceAll("\x1B","\x1B\x1B")}\x1B\\`;
  if(_==="screen")return`\x1BP${H.replaceAll("\x1B","\x1B\x1B")}\x1B\\`;
  return H
}
```

三个问题：

1. **【主因】tmux passthrough 包装不被解析**：tmex 的 pane 必在 tmux 内（$TMUX 存在），Claude Code 所有通知序列都被包成 `ESC Ptmux; <内层序列，ESC 翻倍> ESC \`。`pane-stream-parser` 的 `esc` 阶段遇 `P`(0x50) 直接原样透传，内层 OSC 永远不会被解析。
2. **OSC 99（kitty 渠道）不支持**：白名单只有 0/1/2/9/777/1337。Claude Code kitty 渠道发三段：
   - `ESC]99;i=<id>:d=0:p=title;<title>ESC\`
   - `ESC]99;i=<id>:p=body;<body>ESC\`（d 缺省 = done）
   - `ESC]99;i=<id>:d=1:a=focus;ESC\`
3. **既有状态机 bug**：`osc-st` 阶段遇 ESC 后非 `\` 字节时 phase 未回 `osc-body`，导致 payload 中出现 ESC 后解析错乱（后续每字节前都被插入 0x1b，且任意 `\` 字符会提前终结 OSC）。

另有行为说明（非代码 bug）：`preferredNotifChannel: auto`（默认）下，Claude Code 检测不到 iTerm/kitty/ghostty 终端时**根本不发通知**。tmex 网页终端内 TERM_PROGRAM=tmux 且无 attach client，auto 必然 no_method_available。用户需在 Claude Code 设置 `preferredNotifChannel`（iterm2 / ghostty / kitty 任一）。

## 修复清单

1. `pane-stream-parser.ts`：
   - 新增 `ESC Ptmux;` passthrough 解包（`ESC ESC`→`ESC` 解码后重新逐字节喂回状态机；非 `tmux;` 前缀的 DCS 保持原样透传；内容设上限防失控）。
   - OSC 白名单加 `99`，按 kitty 协议解析（metadata 冒号分隔 i/d/p/a；按 id 聚合 title/body；d≠0 时 emit）。
   - 修复 `osc-st` 阶段 phase 不回 `osc-body` 的 bug。
2. `packages/shared/src/index.ts`：`NotificationSource` 加 `'osc99'`；`ws-borsh/convert.ts` 枚举映射加 `osc99: 4`。
3. `apps/gateway/src/ws/index.ts` source 白名单加 `osc99`。
4. 单测：passthrough 包装的 OSC 9/777、OSC 99 三段聚合、osc-st 回归用例。
5. 文档：known-issue 或 terminal 文档补充 Claude Code 通知配置说明（auto 渠道在 tmex 下不生效，需显式设置 preferredNotifChannel）。

## 验收标准

- parser 单测覆盖：`ESC Ptmux;` 包装的 OSC 9（BEL/ST 两种终结）、OSC 777、OSC 99 三段消息，均产生正确 notification 且不向前端泄漏序列字节。
- gateway / shared 全量 bun test 通过。
- 真实链路验证：tmux pane 内 printf 模拟 Claude Code 包装序列，网页端收到通知 toast。
