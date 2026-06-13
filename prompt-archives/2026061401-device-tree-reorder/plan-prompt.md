# Prompt 存档

## 需求

> 分析需求给出方案 https://github.com/krhougs/tmex/issues/5

Issue #5 原文：

> Device Tree优化，device和pane支持调整顺序
>
> 在当前的 device tree 中，我们应该允许两个层级的位置调整：
> 1. 允许拖动 device 标题行对 device 进行顺序调整
> 2. 允许拖动 device tree 内的 window/pane 进行顺序调整，pane/window 下的 agent session 暂时不能排序
>
> 顺序调整应该持久化在服务端中。
> 需要照顾手机端的操作体验，可以适当带有对用户体验友好的动画

## 规划期补充指令

> 按照项目规范完成 plan，记得善用 subagent 以免大上下文影响思考质量

## 设计澄清（AskUserQuestion 结论）

1. **Window/Pane 顺序持久化方式**：选 **DB 显示层 overlay（window/pane 统一）**——新建 DB 表存 `(deviceId, windowId/paneId)` 的显示顺序，在快照下发时重排数组（复用现有 `windowCustomNames` overlay 机制）。不触碰 tmux 真实布局，重启后保留。代价：window 的 index 徽标可能与显示顺序不连续；不同步到原生 tmux 客户端（已接受）。
2. **拖拽交互实现**：选 **引入 @dnd-kit**——内置触摸 sensor、键盘可访问性、排序动画。

## 解读

device tree 渲染在 `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`（旧 `Sidebar.tsx` 为死代码）。三层排序走两条持久化路径：

- **Device**：DB 实体，但前端目前按名称字母序排（`:385`），`devices` 表无顺序列 → 加 `sort_order` 列 + REST 重排接口，前端改按 `sortOrder`。
- **Window/Pane**：来自 tmux 实时快照（不在 DB），按 tmux `index` 排 → 新表 `device_tree_order` + 新 WS 消息 `KIND_TMUX_REORDER` + 扩展 gateway 快照 overlay。
- **前端**：@dnd-kit 三层 `SortableContext`（不跨容器移动），移动端长按/手柄激活 + 友好动画。
