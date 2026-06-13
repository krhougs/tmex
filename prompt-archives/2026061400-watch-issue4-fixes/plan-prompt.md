# Prompt 存档：watch issue #4 修复

## 初始 prompt

> 调研 https://github.com/krhougs/tmex/issues/4 给出继续工作的方案

## 执行指令

> 按照项目规范执行 plan，注意善用 subagent

## Issue #4 原文（watch功能两个问题）

来源：一条实际发出的 Telegram 通知

```
👁️ 👁️ Watch 规则错误
站点：shanghai-macmini
时间：2026/6/13 20:30:31
设备：local (local)
窗口：0 (@137)
Pane：0 (%242)
直达：https://sh-dev.01.do/devices/beeaf877-5b7e-4d7b-8de5-57bcaee3a6ed/windows/%40137/panes/%25242
信息：监控「卡住」连续失败 10 次，已自动停用：can't find pane: %2965
```

两个问题：
1. telegram 消息没有正确 escape（请妥善复用已有的 escape 逻辑，并检查有无类似问题顺手修复）
2. pane 销毁后没有正确清理 watch 任务，用户猜测 watch 存储用的 pane key 是纯数字窗口 id 和 pane id，而不是 tmux 中的字符串 id

enhancement：
- 所有的类似提示信息（包含 OSC 通知和 bell 通知）应该包含 pane 当前标题和进程

## 关键决策（AskUserQuestion 确认）

- Pane 被销毁后：**立即删除规则** + 清理通知（非停用、非静默）
- 标题/进程数据源：**复用快照**（扩展 list-panes 格式加 `#{pane_current_command}`）
