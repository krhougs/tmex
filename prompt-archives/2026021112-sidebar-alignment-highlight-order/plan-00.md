# 计划：Sidebar 对齐与高亮误判修复

## 背景

- 当前 Sidebar 底部按钮在视觉上为居中排列，不满足“按钮内容左对齐”的需求。
- 当前 window/pane 高亮判定仅依赖路由中的 `windowId/paneId`，在不同设备中出现同 ID 时会误高亮。
- 当前 device 列表受连接状态影响顺序，和产品要求冲突。

## 注意事项

- 仅改 Sidebar 相关逻辑与样式，避免扩大改动范围。
- 不改后端接口，不改 shared type。
- 先补回归用例再改实现，确保问题可复现与可验证。
- 保持现有 `data-testid` 命名，避免破坏现有测试选择器。

## 实施步骤

1. 在 `apps/fe/tests/tmux-sidebar.e2e.spec.ts` 增加回归用例：
   - 验证展开态底部按钮内容左对齐；
   - 验证折叠态底部快捷按钮图标左对齐；
   - 验证跨设备同 ID 时仅当前设备高亮；
   - 验证设备列表按名称排序且不受连接状态影响。
2. 修改 `apps/fe/src/components/Sidebar.tsx`：
   - 两组底部按钮从 `justify-center` 调整为左对齐；
   - window/pane 选中判定增加“仅当前设备”约束；
   - 设备排序改为按设备名排序，去掉连接状态排序逻辑。
3. 运行定向 e2e 验证新增与相关用例。
4. 将执行结果写入 `plan-00-result.md`。
