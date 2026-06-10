# Claude Code 终端通知（OSC）支持说明

## 背景

Claude Code（CLI）在任务完成或需要注意时会向终端发送 OSC 通知序列。此前 tmex 收不到这些通知，2026-06-11 已修复。本文记录根因、tmex 侧的支持范围，以及用户必须做的 Claude Code 配置。

## 根因（对 Claude Code 2.1.170 内嵌源码的分析结论）

1. **tmux passthrough 包装**：Claude Code 检测到自己运行在 tmux 内（`$TMUX` 存在）时，会把所有通知序列包成 tmux passthrough：`ESC Ptmux; <内层序列，ESC 翻倍> ESC \`。tmex 的 `pane-stream-parser` 此前不解析 DCS，内层 OSC 被原样透传、永远不会被识别为通知。
2. **kitty 渠道使用 OSC 99**：此前 parser 只支持 OSC 9 / 777 / 1337，OSC 99 直接被忽略。
3. parser 既有 bug：OSC body 中出现 `ESC + 非 ST` 字节时状态机不回到 body 状态，payload 解析错乱。

## 修复内容

- `apps/gateway/src/tmux-client/pane-stream-parser.ts`：
  - 解包 `ESC Ptmux;` passthrough（`ESC ESC` 还原为 `ESC` 后重新喂回状态机；非 `tmux;` 前缀的 DCS 保持原样透传；64KB 上限）。
  - 支持 OSC 99（kitty 桌面通知协议）：解析 `i`/`d`/`p` 元数据，按 id 聚合 title/body 分片，完成时上报。
  - 修复 `osc-st` 状态机 bug。
- `NotificationSource` 新增 `osc99`（shared 类型、Borsh u8=4、gateway ws 白名单、协议文档同步）。

## Claude Code 渠道与 tmex 的对应关系

Claude Code 各通知渠道发出的序列（在 tmux 内均经 passthrough 包装，tmex 已能全部解包）：

| `preferredNotifChannel` | 序列 | tmex 支持 |
| --- | --- | --- |
| `iterm2` / `iterm2_with_bell` | `OSC 9 ; <message> BEL` | ✅ |
| `ghostty` | `OSC 777 ; notify ; <title> ; <body> BEL` | ✅ |
| `kitty` | `OSC 99`（三段：title / body / focus，按 `i=<id>` 聚合） | ✅ |
| `terminal_bell` | 裸 `BEL` | ✅（走 bell 通知） |
| `auto`（默认） | 见下 | ⚠️ 不会发通知 |

## auto 渠道的自动识别（2026-06-11 起默认支持）

Claude Code 默认 `preferredNotifChannel: auto` 时按终端探测决定渠道，其检测优先级（逆向自 2.1.170）：

```js
if (process.env.TERM === "xterm-ghostty") return "ghostty";   // 优先于 TERM_PROGRAM
if (process.env.TERM?.includes("kitty")) return "kitty";
if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM; // tmux 3.2+ 强制为 "tmux"
if (process.env.TMUX) return "tmux";
```

tmux 3.2+ 在派生 pane 进程时**强制覆盖** `TERM_PROGRAM=tmux`（会话环境变量无法覆盖），因此唯一可注入的钩子是 `TERM=xterm-ghostty`。tmex 现在默认（`TMEX_TMUX_TERM_PROGRAM=ghostty`）在接管会话时：

1. 检测宿主（本地或 SSH 远端）是否有 `xterm-ghostty` terminfo，缺失则用内置源（`apps/gateway/src/tmux-client/ghostty-terminfo.ts`，自 Ghostty 官方导出）通过 `tic -x` 安装到 `~/.terminfo`；
2. 成功后把 tmux `default-terminal` 设为 `xterm-ghostty`（注意：这是 **tmux server 级选项**，影响该 server 上所有会话的新 pane）；
3. 同时写入会话环境 `TERM_PROGRAM=ghostty`（对不覆盖该变量的 tmux <3.2 生效）。

之后新开的 pane / window 中 `TERM=xterm-ghostty`，Claude Code auto 渠道即识别为 ghostty 并通过 OSC 777 发送通知。**已存在的 shell 进程不受影响**，需要新开 pane 或重启 shell。

- tmex 终端引擎本身就是 ghostty-vt（WASM），terminfo 声明的能力与前端真实能力一致。
- 设 `TMEX_TMUX_TERM_PROGRAM=off` 可完全关闭该行为。
- `tic` / `infocmp` 不可用（无 ncurses 工具）或安装失败时自动跳过 `default-terminal` 设置，保持 tmux 默认 TERM，不会破坏现有程序。
- 不想依赖该机制时，仍可在 Claude Code 设置中显式指定：`{ "preferredNotifChannel": "iterm2" }`（iterm2 / ghostty / kitty 均受 tmex 支持）。

## 验证方式

在 tmex 页面打开的 pane 中执行（模拟 Claude Code 在 tmux 内发出的包装序列）：

```bash
printf '\033Ptmux;\033\033]9;hello from claude\007\033\\'
```

网页端应弹出通知 toast（需站点设置中 `enableBrowserNotificationToast` 开启，默认开启；同一 pane 同一来源默认 3 秒节流）。

## 参考

- 排查记录：`prompt-archives/2026061101-claude-code-osc-notification/`
- 协议文档：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`（notification `source` 枚举）
