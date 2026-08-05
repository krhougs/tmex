# Prompt 存档

## 2026-08-05 需求(krhougs,经 vibex 侧转达)

Windows 上 opencode 类 alt-screen TUI 退出后有概率"卡住几秒,随后报告窗口关闭"。
取证结论(vibex 侧 companion.log + raw TCP 探针):

- TUI 全屏重绘洪流下,control mode 消费端(gateway)变慢,tmux/psmux 服务端断开
  control 连接,gateway 看到 stdout EOF → kill → 重连;
- 重连初始化的 display-message/capture-pane 淹没在洪流后触发队头 10s 超时 →
  ControlModeCommandQueue.poison → 再次 kill/重连,循环 20+ 分钟;
- fetchPaneHistory 返回 null 时 ws 层静默不回包,客户端首屏永久 loading;
- 本地 run(逐条 tmux 子进程)无超时,CLI 卡死会永久挂起调用方。

服务端断连问题在 psmux 侧另行修复(输出背压缓冲);本档为 gateway 侧韧性防御。

## 任务

1. 队头超时不再立即毒化整条 control 连接:超时命令单独 reject,占位保持 FIFO
   块对位;迟到块到达后丢弃;占位超硬时限(流真停滞)才毒化重连。
2. fetchPaneHistory null/异常时回空 TermHistory 响应,客户端结束 loading 进入
   实时流,不再永久卡住。
3. capture 屏障三连中的 history 段改为条件入队:alternate screen 或零历史时跳过
   (tmux 对 alt 屏的 history capture 会退化返回可见区首行,纯浪费)。
4. defaultRun 子进程加 30s 超时 kill,防单条 CLI 卡死挂起调用方。
