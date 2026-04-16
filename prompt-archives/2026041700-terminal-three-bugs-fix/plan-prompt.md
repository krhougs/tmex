# 终端三个 Bug 修复

## 背景

在最近的 SSH 设备连接实现完成后（参考 `2026041606-ssh-device-connect`），发现了三个终端相关的回归/遗留 Bug。本任务不涉及大架构调整，聚焦在局部修复并补齐回归用例。

## 用户 prompt（原文）

> 修复bug:
> 1. vim退出后没有释放鼠标，退出后鼠标滚轮事件应该变回scroll普通终端，而不是继续发送鼠标事件
> 2. 刚刚的ssh实现完成后引入了新bug，终端中打开opencode，刷新或切换窗口后恢复的TUI是残缺的
> 3. 点击新建窗口没有反应，但是当前console被输入了 `0;1;12m`

## 关注点

- Bug1：vim 退出时会 reset mouse report mode（DEC 私有 1000/1002/1003/1006 等），但我们的终端未正确跟随状态变更，导致 scroll wheel 依然被转成 SGR mouse 序列而不是翻译为方向键/滚动。
- Bug2：SSH 恢复逻辑在 snapshot/attach 时重发 DECRQSS/resize 流，opencode（基于 BubbleTea）对首帧敏感，可能缺失初始 alt screen / clear。需要审视 `packages/ghostty-terminal` 与 `apps/fe` 的 restore 相关改动。
- Bug3：新建窗口按钮所在容器可能在未释放 mouse grab 的情况下把 click 事件当作 CSI 序列吃了。`0;1;12m` 是 SGR 鼠标报告尾部，说明容器误把鼠标事件注入到 PTY/输入框，但上层按钮 click 未生效。

## 参考

- 相关旧分支/提交：`5b61afc`、`664b511`、`494cbd1`、`9de181c`、`4e41fe0`
- `new-window-noop.png` 是用户截图（疑似空白）
