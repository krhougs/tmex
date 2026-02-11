# Plan 00：双向尺寸同步与新窗口首帧宽度溢出修复

时间：2026-02-11

## 背景

当前终端链路可以单向从浏览器发送 resize，但缺少 iTerm2 -> 浏览器回传应用；同时新建窗口存在首帧字体度量未稳定导致的 1-5 列溢出，刷新后历史颜色仍可能受时序影响丢失。

## 目标

1. 浏览器 resize / 同步按钮可驱动 iTerm2 对应 tmux 尺寸变化。
2. iTerm2 resize 可回传并驱动浏览器 xterm cols/rows 更新。
3. 新建窗口首帧宽度不再溢出 1-5 列。
4. 刷新后普通输出与 TUI 历史颜色保留稳定。

## 任务

1. gateway 连接层设置 tmux window-size 策略为 latest + aggressive-resize。
2. ws 层增加 snapshot 低频轮询兜底，提升 iTerm2 侧变化可见性。
3. 前端 DevicePage 增加双向尺寸状态机（本地发包、远端回传、回环抑制）。
4. 前端新增新窗口/新 pane 双阶段 fit（即时 + 延迟 + fonts.ready）消除首帧溢出。
5. 后端 capture-pane 同时抓普通屏与 alternate screen，前端历史初始化改为 history/live 缓冲合并。
6. 执行构建与定向 e2e 验证，并产出结果归档。
