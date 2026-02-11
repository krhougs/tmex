# Prompt Archive

## 背景请求

用户提出实现 terminal bell 推送能力，典型场景是 tmux session 任意 pane 的 coding agent 任务完成后触发终端响铃，并向 Telegram 推送设备/窗口/pane 定位与直达链接。

## 关键约束

1. 为所有已添加设备维护与前端无关的 tmux 连接。
2. 设备删除或修改时要正确关闭或重连。
3. 本地与 SSH 会话都要支持断线重连（tmux 进程可能被外部杀掉）。
4. 用户明确要求：
   - 前端获得 tmux 数据方式不变；
   - 后端处理前端连接方式不变；
   - 用于推送的 supervisor 为独立模块。
5. 用户确认目标：同一次 bell 事件，用户可以同时收到网页 Toast 与 Telegram Bot 消息。

## 过程补充

过程中针对 control mode bell 通知来源做了澄清，用户要求以一手资料为准并核对 iTerm2 与 man tmux。

