# Prompt 存档

## 初始 prompt（2026-06-15）

以main为base创建新的worktree排查问题：（生产环境仅用于复现，在生产环境操作开启关闭任何窗口）

以当前本机正在运行的生产环境为例，有一个pane对应的在浏览器里的URL是
`/devices/beeaf877-5b7e-4d7b-8de5-57bcaee3a6ed/windows/@0/panes/%250`
但是 telegram 推送中的URL实际打开却是
`/devices/beeaf877-5b7e-4d7b-8de5-57bcaee3a6ed/windows/%2540/panes/%25250`

## 背景与注意事项

- worktree 基于 main 创建：`worktree-debug-telegram-url-encoding`。
- 生产环境（launchd 守护，9883，`~/Library/Application Support/tmex/`）仅用于复现，
  允许开关窗口，禁止改动其文件/进程。
- 复现可直接用现有单测 `apps/gateway/src/events/index.test.ts`，无需触碰生产。
