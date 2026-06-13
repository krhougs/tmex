# Plan #00 执行结果总结

## 基本信息

- **Issue**: [#6 UI改动](https://github.com/krhougs/tmex/issues/6)
- **Worktree**: `/Users/krhougs/LocalCodes/tmex-issue-6`
- **Branch**: `fix/issue-6-ui-changes`
- **Commit**: `6610079` — `fix(ui): mobile sidebar border, Menu icon, dropdown backdrop, agent session menu migration`
- **变更统计**: 3 files changed, 41 insertions(+), 14 deletions(-)

## 执行过程

### Wave 1（并行实现）
- **Task 1**（quick agent）：`sidebar.tsx` 边框去除 + 移动端 Menu 图标 — ✅ 完成
- **Task 2**（deep agent）：`dropdown-menu.tsx` Backdrop 支持 + `sidebar-device-list.tsx` 按钮迁移 + 启用 Backdrop — ✅ 完成

### Final Verification Wave（并行审查）
- **F1 Plan Compliance**（oracle）：Must Have 14/14, Must NOT Have 7/7 — **APPROVE**
- **F2 Code Quality**（unspecified-high）：LSP 3/3 clean, 0 issues — **APPROVE**
- **F4 Scope Fidelity**（deep）：2/2 tasks compliant, 0 越界 — **APPROVE**

> F3 Playwright QA 未执行（需要完整 dev server + 设备模拟环境），建议合并前在本地手动验证。

## 变更内容

### `apps/fe/src/components/ui/sidebar.tsx`
1. 移动端 SheetContent className 添加 `border-none`（去除全屏时右侧边框）
2. import 添加 `Menu` from lucide-react
3. SidebarTrigger 条件渲染：`{isMobile ? <Menu /> : <PanelLeftIcon />}`

### `apps/fe/src/components/ui/dropdown-menu.tsx`
1. 新增 `backdrop?: boolean` prop（默认 `false`）
2. 当 `backdrop === true` 时，在 Portal 内、Positioner 前渲染 `<MenuPrimitive.Backdrop className="fixed inset-0 z-50" />`

### `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
1. 导入 `DropdownMenuSeparator`
2. PaneRow 的 pane 菜单新增"新建 Agent Session"菜单项（带 data-testid、Plus 图标、isMobile 样式）
3. PaneSessionBranch 新增 `hideCreateButton?: boolean` prop，控制内联按钮显示
4. PaneRow 调用 PaneSessionBranch 时传 `hideCreateButton`（多 pane 场景隐藏内联按钮）
5. 单 pane 场景保留内联按钮（未传 `hideCreateButton`）
6. 3 处侧栏 DropdownMenuContent 启用 `backdrop`：窗口菜单、pane 菜单、会话菜单

## 关键技术决策

- **Bug #4 修复方案变更**：原选 `modal={true}`，Metis 审查发现 base-ui 1.2.0 中 `FloatingFocusManager.modal` 硬编码为 `isContextMenu`，与 `MenuRoot.modal` prop 无关。改用 `MenuBackdrop` 组件渲染全屏遮罩拦截外部触摸事件。
- **单 pane 窗口保护**：单 pane 窗口直接渲染 PaneSessionBranch（不经过 PaneRow），无 pane DropdownMenu。通过 `hideCreateButton` prop 区分：多 pane 场景隐藏内联按钮（按钮在菜单中），单 pane 场景保留。

## 待办

- [ ] 合并前 Playwright 移动端 QA（需手动执行）
- [ ] PR 创建
