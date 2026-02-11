# Prompt Archive

## 用户原始需求

请修复以下问题：

1. sidebar两个按钮里面应该左对齐
2. sidebar不同设备中如果有id相同的window或者pane则会被错误高亮

## 用户补充

连接状态不应该影响sidebar中device的顺序。

## 实现前确认（本轮已确认）

- “两个按钮左对齐”范围：两组都改（展开态底部“管理设备/设置” + 折叠态底部两个快捷按钮）。
- device 顺序规则：按设备名排序（不受连接状态影响）。

## 用户执行指令

Implement the plan.
