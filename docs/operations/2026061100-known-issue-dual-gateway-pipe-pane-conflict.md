# 已知问题：多个 gateway 同时接入同一 tmux 会话导致终端互相失效

## 背景

tmex gateway 通过外部 tmux CLI 订阅 pane 输出。当**两个及以上 gateway 实例**（典型场景：本机常驻的 tmex-cli 生产服务 + 仓库内启动的 dev gateway）各自存在指向**同一个 tmux 会话**的设备并同时 attach 时，两个实例的网页终端都会出现"输入无反应、内容不更新"的现象，看起来像页面卡死。

典型复现（2026-06-11 实验证实）：

1. 常驻生产服务运行中，页面工作正常；
2. 启动 dev gateway，并在 dev 页面打开指向同一 tmux 会话的设备；
3. 生产页面输出断流；dev 与生产在互相触发 resync 时交替抢占，双方都时好时坏；
4. kill dev gateway 后，生产服务在下一次页面刷新 / WebSocket 重连触发 re-pipe 时恢复正常（不会自动恢复）。

## 根因

两个 tmux 层共享资源都是"后到者直接顶掉前者"，且被顶掉的一方无任何感知：

- **pane 输出管道**：gateway 用 `tmux pipe-pane -O -t <pane> 'cat > <fifo>'` 订阅输出（`apps/gateway/src/tmux-client/local-external-connection.ts:746`，ssh 版本同理）。tmux 每个 pane 同一时刻只允许一个 pipe，后执行者直接替换前者，前者的 fifo 从此静默断流。
- **会话级 hook**：gateway 用 `set-hook -t <session> pane-exited/pane-died/after-new-window/after-split-window` 监听结构变化（同文件 `installHook`）。同名 hook 被后来者直接覆盖，前者收不到事件。

被抢的一方 `paneReaders` 中仍认为自己持有管道，不会重新执行 `pipe-pane`，因此不会自愈；只有当某个动作触发 detach → re-attach / `syncPipeReaders` 重建管道时才会"抢回来"，于是两个实例形成交替抢占。

注意：该问题与前端无关（同样的前端构建在持有管道的一侧工作完全正常）。

## 影响范围

- 本机同时运行常驻服务与 dev 环境，且两边设备指向同一 tmux 会话（开发者最常见）；
- 两台机器各跑一个 tmex，通过 ssh 设备接到同一远端 tmux 会话；
- 同一 gateway 内**不**受影响（单实例对每个 pane 只建一个 pipe）。

## 规避方法（当前版本）

任选其一：

1. dev 调试期间停掉常驻服务：`launchctl unload ~/Library/LaunchAgents/<tmex>.plist`（macOS）或 `systemctl --user stop tmex.service`（Linux），调试结束后再恢复；
2. dev 环境只使用独立的 tmux 会话建设备（例如 `tmex-dev`），不要复用日常会话；
3. 若已发生断流：kill 掉其中一个 gateway 后，**刷新存活一侧的页面**（触发 ws 重连 → re-pipe）即可恢复。

## 修复方案

### 根治（建议另立任务）

把输出订阅从 `pipe-pane` 迁移到 **tmux control mode**（`tmux -C attach`）：

- control mode 客户端通过 `%output` 通知接收 pane 输出，tmux 原生支持多客户端同时订阅，互不抢占；
- `%window-add` / `%unlinked-window-close` / `%layout-change` 等通知可同时替代现有的 `set-hook` 事件与快照轮询；
- 改动集中在 `local-external-connection.ts` / `ssh-external-connection.ts` 的订阅层，对上层 ws 协议无影响；
- 注意点：control mode 输出为转义编码（`\xxx` 八进制），需要解码；attach 会占用一个 tmux client，需用 `-f no-output` 之类的 flag 评估对 `attached` 状态与窗口尺寸协商（`window_size` / `aggressive-resize`）的影响。

### 过渡缓解（小改动，可先行）

被抢检测 + 显式报警，不做自动抢回（双实例自动抢回会形成互抢循环，比现状更糟）：

1. 建管道时写入归属标记：`set-option -p -t <pane> @tmex-pipe-owner <gatewayRuntimeId>`；
2. 周期或在快照轮询时校验 `display-message -p -t <pane> '#{@tmex-pipe-owner}'` 是否仍为自己；
3. 不一致时通过现有 error/notification 通道向前端推送明确提示（"该会话已被另一个 tmex 实例接管"），并停止本端管道，让用户明确选择由哪个实例接管。

## 参考

- 排查与实验记录：`prompt-archives/2026061100-web-terminal-shortcut-paste-copy/plan-00-result.md`
- 相关代码：`apps/gateway/src/tmux-client/local-external-connection.ts`（`startPipeForPaneNow` / `installHook` / `syncPipeReaders`）、`apps/gateway/src/tmux-client/ssh-external-connection.ts`
