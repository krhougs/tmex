# 本次 Prompt 存档

> 说明：以下内容用于按仓库规范归档本次对话中用户提供的关键信息与需求（含后续追加的目标调整）。

## 用户描述（原始）

实际上根本不工作，没有报错，gateway 输出：

```txt
[ws] client connected
[tmux] non-control output: 
```

然后卡住。

ws 里可以看到：

```json
{"type":"event/device","payload":{"deviceId":"a443ac36-8fb8-4fcf-84ff-bd44c4d296f6","type":"disconnected"}}
```

并要求：请你想办法自己修了测一下。

## 用户追问

你是否读过：

https://github.com/tmux/tmux/wiki/Control-Mode

## 目标调整（用户反馈）

不，你偷懒了，你说的非目标在应该是最初的目标。

## 用户最终指令

Implement the plan.

