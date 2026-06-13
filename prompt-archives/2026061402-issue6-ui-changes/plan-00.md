# Issue #6: UI 改动（移动端侧栏 + 设备树交互修复）

## TL;DR

> **Quick Summary**: 修复 GitHub Issue #6 的 4 项前端 UI 改动：Sheet 全屏边框去除、移动端触发器图标更换、新建 Agent Session 按钮收进 pane 菜单、DropdownMenu 点击外部关闭 bug 修复。
>
> **Deliverables**:
> - 移动端 Sheet 全屏时无右侧边框
> - 移动端左上角 sidebar 触发器使用 Menu（汉堡）图标
> - 新建 Agent Session 入口从内联按钮迁移到 pane 的 DropdownMenu
> - DropdownMenu 打开时外部点击正确关闭菜单，不穿透到下层元素
>
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1（并行）→ Final Verification

---

## Context

### Original Request
GitHub Issue #6 提出的 4 项 UI 改动需求：
1. 手机端 Sheet 全屏后右侧边框应去除
2. 手机左上角 sidebar 图标应更换（动画已改为从上往下）
3. Device tree 新建 agent session 按钮应收在对应 pane 的 context menu 中
4. Bug：sidebar 中 context menu 展开时点击其他位置触发底层元素而非关闭菜单

### Interview Summary
**Key Discussions**:
- 图标选择：用户确认使用 `Menu`（汉堡菜单）图标替代 `PanelLeftIcon`
- Bug 修复方案：用户选择方案 A（modal 模式），但 Metis 审查发现 `modal` prop 在 base-ui 1.2.0 中**不控制 FloatingFocusManager**（硬编码为 `isContextMenu`），方案无效
- 测试策略：用户选择无自动化测试，使用 Agent 执行的 QA 场景验证

### Metis Review
**Identified Gaps** (addressed):
- **CRITICAL - Bug #4 修复方案无效**：`MenuRoot.modal` prop 仅控制滚动锁定，不影响 `FloatingFocusManager.modal`（base-ui `MenuPopup.js` 第 115 行硬编码 `modal: isContextMenu`）。已改用 `MenuBackdrop` 方案——base-ui 1.2.0 提供了 `@base-ui/react/menu/backdrop` 组件，渲染全屏遮罩拦截外部触摸事件。
- **CRITICAL - 单 pane 窗口回归**：单 pane 窗口（`!hasMultiplePanes`）直接渲染 `PaneSessionBranch`（第 1137-1147 行），**不经过 `PaneRow`**，因此没有 pane DropdownMenu。如果移除内联按钮，单 pane 窗口将完全丧失创建 Agent Session 的能力。解决方案：单 pane 窗口保留内联按钮。
- **MINOR - Menu 图标未导入**：`sidebar.tsx` 第 24 行仅导入 `PanelLeftIcon`，需添加 `Menu`。
- **MINOR - data-testid 变更**：移除内联按钮会移除 `agent-session-create-inline` test ID，新的菜单项需分配新 test ID。
- **MINOR - i18n 复用**：`agent.session.new` key 已存在（en/zh/ja 三语），直接复用，不新增。

---

## Work Objectives

### Core Objective
修复 Issue #6 的 4 项移动端 UI 问题，提升移动端侧栏交互体验。

### Concrete Deliverables
- `apps/fe/src/components/ui/sidebar.tsx`：移动端 SheetContent 去除边框 + SidebarTrigger 条件图标
- `apps/fe/src/components/ui/dropdown-menu.tsx`：DropdownMenuContent 支持 Backdrop 渲染
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`：新建 session 按钮迁移 + 启用 Backdrop

### Definition of Done
- [ ] 移动端（375x812）打开侧栏，Sheet 右边缘无边框线
- [ ] 移动端左上角显示 Menu（汉堡）图标，桌面端仍显示 PanelLeftIcon
- [ ] 多 pane 窗口的 pane 菜单（⋯）中包含"新建 Agent Session"选项
- [ ] 单 pane 窗口仍有内联"新建 Agent Session"按钮
- [ ] 移动端打开任意 DropdownMenu 后，点击菜单外部仅关闭菜单，不触发下层元素

### Must Have
- 所有改动仅影响前端（`apps/fe/src/`）
- 遵循现有代码模式（isMobile 条件、DropdownMenuItem 结构、lucide 图标）
- 使用现有 i18n key `agent.session.new`

### Must NOT Have (Guardrails)
- ❌ 禁止修改 `sheet.tsx`（共享 UI 原语，边框修复仅在 sidebar.tsx 消费侧处理）
- ❌ 禁止修改 base-ui node_modules 源码
- ❌ 禁止新增 i18n key
- ❌ 禁止将 Backdrop 修改扩散到 `DevicesPage.tsx` 等非侧栏组件（除非明确需要）
- ❌ 禁止创建独立的 `MobileSidebarTrigger` 组件（在现有 `SidebarTrigger` 内条件渲染即可）
- ❌ 禁止过度抽象：不创建 `MobileDropdownMenu` 等新包装器组件
- ❌ 禁止添加不必要的代码注释（遵循 AGENTS.md 规范）

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES（bun test，但无前端 UI 测试框架）
- **Automated tests**: None（用户选择无自动化测试）
- **Framework**: N/A

### QA Policy
每个任务包含 Agent 执行的 QA 场景（Playwright 移动端视口 375x812 + 桌面端 1280x800）。
Evidence 保存到 `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`。

- **Frontend/UI**: Playwright - Navigate, interact, assert DOM, screenshot
- 工具：`playwright` skill + dev server（`bun run dev` 或等效）

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately - 2 independent tasks):
├── Task 1: sidebar.tsx 边框去除 + 移动端图标更换 [quick]
└── Task 2: dropdown-menu.tsx Backdrop 支持 + sidebar-device-list.tsx 按钮迁移 + 启用 Backdrop [deep]

Wave FINAL (After ALL tasks):
├── Task F1: Plan compliance audit [oracle]
├── Task F2: Code quality review [unspecified-high]
├── Task F3: Real manual QA - Playwright [unspecified-high]
└── Task F4: Scope fidelity check [deep]
-> Present results -> Get explicit user okay

Critical Path: Task 2 → F1-F4 → user okay
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 2 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | None | F1-F4 |
| 2 | None | F1-F4 |
| F1-F4 | 1, 2 | user okay |

### Agent Dispatch Summary

- **Wave 1**: **2** - T1 → `quick`, T2 → `deep`
- **FINAL**: **4** - F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. sidebar.tsx 边框去除 + 移动端图标更换

  **What to do**:
  - 在 `apps/fe/src/components/ui/sidebar.tsx` 中完成两项修改：
  - **边框去除**：在第 266 行移动端 SheetContent 的 className 中添加 `border-none`，覆盖 sheet.tsx 中的 `data-[side=left]:border-r`。当前 className 为 `"bg-sidebar text-sidebar-foreground p-0 [&>button]:hidden"`，改为 `"bg-sidebar text-sidebar-foreground p-0 [&>button]:hidden border-none"`
  - **图标更换**：在第 24 行的 lucide-react import 中添加 `Menu`（当前仅导入 `PanelLeftIcon`）。修改 `SidebarTrigger` 组件（第 392-416 行），从 `useSidebar()` 解构 `isMobile`，条件渲染 `{isMobile ? <Menu /> : <PanelLeftIcon />}`

  **Must NOT do**:
  - 不修改 `sheet.tsx`（共享 UI 原语）
  - 不创建新的 `MobileSidebarTrigger` 组件
  - 不添加 SSR/hydration 处理（Vite SPA 无此问题）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 2 处 className/import 修改，逻辑简单明确
  - **Skills**: [`frontend-design`]
    - `frontend-design`: 涉及 UI 组件修改和移动端适配

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: F1-F4
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/fe/src/components/ui/sidebar.tsx:266` - 当前移动端 SheetContent className，需在其末尾添加 `border-none`
  - `apps/fe/src/components/ui/sidebar.tsx:392-416` - SidebarTrigger 组件定义，`useSidebar()` 已调用，需从中解构 `isMobile`
  - `apps/fe/src/components/ui/sidebar.tsx:24` - lucide-react import 行，当前为 `import { PanelLeftIcon } from "lucide-react"`，需改为 `import { Menu, PanelLeftIcon } from "lucide-react"`

  **API/Type References**:
  - `apps/fe/src/components/ui/sidebar.tsx:84` - `useSidebar()` context 已提供 `isMobile: boolean`，SidebarTrigger 已调用 `const { toggleSidebar } = useSidebar()`，改为 `const { toggleSidebar, isMobile } = useSidebar()`

  **WHY Each Reference Matters**:
  - Line 266: 这是移动端 Sheet 渲染处，border-none 加在这里而非 sheet.tsx，避免影响其他 Sheet 使用者
  - Line 392-416: SidebarTrigger 是唯一的 sidebar 触发器组件，在 `main.tsx:139` 使用。条件渲染 isMobile 即可
  - Line 24: `Menu` 图标必须在 import 中才能使用。lucide-react 的 `Menu` 是标准汉堡菜单图标（三横线）

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 移动端 Sheet 无右侧边框
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running, 打开应用首页
    Steps:
      1. 设置视口为 375x812 (iPhone X)
      2. 点击 [data-testid="mobile-sidebar-open"] 打开侧栏
      3. 等待 [data-testid="mobile-sidebar-sheet"] 可见
      4. 对 [data-testid="mobile-sidebar-sheet"] 截图
      5. 获取 SheetContent 元素的 computed style，检查 border-right-width
    Expected Result: border-right-width 为 "0px" 或 border-style 为 "none"
    Failure Indicators: border-right-width 大于 0，或截图右边缘有可见竖线
    Evidence: .sisyphus/evidence/task-1-border-removal.png

  Scenario: 移动端图标为 Menu（汉堡）
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running
    Steps:
      1. 设置视口为 375x812
      2. 检查 [data-slot="sidebar-trigger"] 内的 SVG 元素
      3. 截图 trigger 按钮
    Expected Result: SVG 为汉堡菜单图标（三条水平线），非 PanelLeft 图标
    Evidence: .sisyphus/evidence/task-1-mobile-icon.png

  Scenario: 桌面端图标仍为 PanelLeftIcon
    Tool: Playwright (desktop viewport 1280x800)
    Preconditions: Dev server running
    Steps:
      1. 设置视口为 1280x800
      2. 检查 [data-slot="sidebar-trigger"] 内的 SVG 元素
      3. 截图 trigger 按钮
    Expected Result: SVG 为 PanelLeft 图标（左侧面板形状），非汉堡菜单
    Evidence: .sisyphus/evidence/task-1-desktop-icon.png
  ```

  **Commit**: YES
  - Message: `fix(ui): remove mobile sidebar border + use Menu icon on mobile`
  - Files: `apps/fe/src/components/ui/sidebar.tsx`
  - Pre-commit: `bun run lint`

- [ ] 2. DropdownMenu Backdrop 支持 + Agent Session 按钮迁移 + 启用 Backdrop

  **What to do**:
  分为三个子修改，全部在 `apps/fe/src/components/ui/dropdown-menu.tsx` 和 `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx` 中完成：

  **子修改 A — DropdownMenuContent 支持 Backdrop（dropdown-menu.tsx）**:
  - 在 import 中添加 `MenuBackdrop`：从 `@base-ui/react/menu` 导入（当前 import 为 `import { Menu as MenuPrimitive } from "@base-ui/react/menu"`，MenuBackdrop 已在 Menu 命名空间下，可直接用 `MenuPrimitive.Backdrop`）
  - 为 `DropdownMenuContent` 添加 `backdrop?: boolean` prop（默认 `false`）
  - 在 `MenuPrimitive.Portal` 内部、`MenuPrimitive.Positioner` 之前，当 `backdrop === true` 时渲染：
    ```tsx
    {backdrop && (
      <MenuPrimitive.Backdrop className="fixed inset-0 z-50" />
    )}
    ```

  **子修改 B — 新建 Agent Session 按钮迁移（sidebar-device-list.tsx）**:
  - **多 pane 窗口**：在 `PaneRow` 的 DropdownMenuContent（第 1255-1271 行）中，在现有"打开监控"菜单项之后添加分隔线 + "新建 Agent Session"菜单项：
    ```tsx
    <DropdownMenuSeparator />
    <DropdownMenuItem data-testid={`pane-session-create-${pane.id}`} onClick={() => onCreateSession()}>
      <Plus className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
      {t('agent.session.new')}
    </DropdownMenuItem>
    ```
    遵循第 1259-1269 行现有 DropdownMenuItem 的样式模式（isMobile 条件类名）
  - 然后在 `PaneSessionBranch`（第 1378-1438 行）中，**仅当通过 PaneRow 渲染时**（即多 pane 场景）移除内联按钮。由于 `PaneSessionBranch` 同时被多 pane（通过 PaneRow）和单 pane（直接渲染）使用，需要添加一个 prop（如 `hideCreateButton?: boolean`）来控制是否显示内联按钮
  - **单 pane 窗口**：在 `WindowItem` 第 1139-1146 行，`PaneSessionBranch` 调用不传 `hideCreateButton`，保留内联按钮

  **子修改 C — 为侧栏 DropdownMenu 启用 Backdrop（sidebar-device-list.tsx）**:
  - 在以下 3 处 `DropdownMenuContent` 调用中添加 `backdrop` prop：
    - 第 1057 行（WindowItem 窗口菜单）：`<DropdownMenuContent align="end" backdrop ...>`
    - 第 1255 行（PaneRow pane 菜单）：`<DropdownMenuContent align="end" backdrop ...>`
    - 第 1349 行（SessionActionsMenu 会话菜单）：`<DropdownMenuContent align="end" backdrop ...>`

  **Must NOT do**:
  - 不修改 `sheet.tsx` 或其他共享 UI 组件
  - 不将 `backdrop` 默认值设为 `true`（避免影响非侧栏的 DropdownMenu 使用者，如 `DevicesPage.tsx`）
  - 不新增 i18n key（复用 `t('agent.session.new')`）
  - 不在 `DevicesPage.tsx` 中添加 backdrop（超出范围）
  - 不修改 base-ui node_modules 源码

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 涉及 3 个子修改、跨 2 个文件、需要理解组件间的 props 传递关系（PaneSessionBranch 的双重使用场景），有逻辑复杂度
  - **Skills**: [`frontend-design`]
    - `frontend-design`: UI 组件修改、DropdownMenu 结构变更、移动端交互修复

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: F1-F4
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/fe/src/components/ui/dropdown-menu.tsx:33-49` - DropdownMenuContent 当前结构（Portal > Positioner > Popup），Backdrop 需插入在 Portal 内、Positioner 前
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:1255-1271` - PaneRow 的 DropdownMenuContent，现有"打开监控"菜单项的样式模式（isMobile 条件 className、图标大小）
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:1428-1436` - 当前内联"新建 Agent Session"按钮（需在多 pane 场景移除）
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:1137-1147` - 单 pane 窗口的 PaneSessionBranch 调用（需保留内联按钮）

  **API/Type References**:
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:1153-1183` - PaneRow 组件 props 定义，`onCreateSession: () => void` 已存在（第 1165 行）
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:1378-1392` - PaneSessionBranch 组件 props 定义，`onCreateSession` 已存在
  - `node_modules/.bun/@base-ui+react@1.2.0.../menu/backdrop/MenuBackdrop.js` - base-ui MenuBackdrop 源码：渲染 `<div role="presentation">`，`hidden: !mounted`（菜单关闭时隐藏），`pointerEvents` 对点击触发菜单为默认值（auto，会拦截触摸事件）

  **Test References**:
  - `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:69` - `Plus` 图标已从 lucide-react 导入

  **External References**:
  - base-ui Menu Backdrop 文档：组件渲染全屏遮罩，拦截外部 pointer/touch 事件，菜单关闭时自动隐藏。`pointerEvents` 在点击触发（非 hover 触发）时为默认值，会拦截事件

  **WHY Each Reference Matters**:
  - dropdown-menu.tsx:33-49: Backdrop 必须渲染在 Portal 内部（与 Positioner 同级），才能正确处理层叠顺序。Portal 渲染到 document.body，Backdrop 在 DOM 顺序上先于 Positioner，因此位于 Positioner 之下但在 SheetContent 之上
  - sidebar-device-list.tsx:1137-1147: 这是 Metis 审查发现的关键回归点——单 pane 窗口直接渲染 PaneSessionBranch 而非 PaneRow，因此没有 pane DropdownMenu。必须为单 pane 保留内联按钮
  - MenuBackdrop.js: 确认 Backdrop 在 base-ui 1.2.0 中存在且行为正确：点击触发菜单时 `pointerEvents` 为 auto（拦截触摸），hover 触发时为 none（不拦截）

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 多 pane 窗口的 pane 菜单含"新建 Agent Session"
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running, 已连接设备, 有一个包含 2+ pane 的窗口
    Steps:
      1. 打开移动端侧栏
      2. 展开设备树到 pane 级别
      3. 点击 [data-testid="pane-menu-{paneId}"] 打开 pane 菜单
      4. 检查菜单内容是否包含 t('agent.session.new') 对应文本（中文："新建会话"或类似）
      5. 点击该菜单项
    Expected Result: 菜单包含"新建 Agent Session"项，点击后触发创建流程
    Failure Indicators: 菜单中无该项，或点击无反应
    Evidence: .sisyphus/evidence/task-2-pane-menu-create.png

  Scenario: 单 pane 窗口仍有内联"新建 Agent Session"按钮
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running, 已连接设备, 有一个仅含 1 个 pane 的窗口
    Steps:
      1. 打开移动端侧栏
      2. 展开设备树到该窗口
      3. 检查是否可见内联"新建 Agent Session"按钮（data-testid="agent-session-create-inline"）
    Expected Result: 内联按钮可见且可点击
    Failure Indicators: 按钮不存在（回归 bug）
    Evidence: .sisyphus/evidence/task-2-single-pane-inline.png

  Scenario: DropdownMenu 外部点击仅关闭菜单（移动端核心 bug 修复）
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running, 已连接设备, 有 pane 级别的 DropdownMenu
    Steps:
      1. 打开移动端侧栏
      2. 点击 [data-testid="pane-menu-{paneId}"] 打开 pane 菜单
      3. 确认菜单可见
      4. 点击菜单外部的另一个 pane 项（如 [data-testid="pane-item-{anotherPaneId}"]）
      5. 检查菜单是否已关闭
      6. 检查被点击的 pane 是否未被选中（即 onClick 未触发）
    Expected Result: 菜单关闭，被点击的 pane 项未被激活/选中
    Failure Indicators: 菜单关闭但 pane 被选中（onClick 穿透），或菜单未关闭
    Evidence: .sisyphus/evidence/task-2-click-outside-fix.png

  Scenario: 会话菜单外部点击同样修复
    Tool: Playwright (mobile viewport 375x812)
    Preconditions: Dev server running, 已有 Agent Session
    Steps:
      1. 打开移动端侧栏
      2. 点击 [data-testid="agent-session-menu-{sessionId}"] 打开会话菜单
      3. 点击菜单外部的另一个会话项
      4. 检查菜单是否已关闭且被点击会话未被选中
    Expected Result: 菜单关闭，会话未切换
    Evidence: .sisyphus/evidence/task-2-session-click-outside.png

  Scenario: 桌面端 DropdownMenu Backdrop 不影响正常交互
    Tool: Playwright (desktop viewport 1280x800)
    Preconditions: Dev server running, 已连接设备
    Steps:
      1. 在桌面端打开 pane 菜单
      2. 点击菜单外部
      3. 确认菜单正常关闭
    Expected Result: 菜单正常关闭，无异常
    Evidence: .sisyphus/evidence/task-2-desktop-dropdown.png
  ```

  **Commit**: YES
  - Message: `fix(ui): move agent session button to pane menu + fix dropdown outside-click`
  - Files: `apps/fe/src/components/ui/dropdown-menu.tsx`, `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
  - Pre-commit: `bun run lint`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, check DOM). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run lint` on changed files. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start dev server. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Test edge cases: single-pane window, multi-pane window, empty sessions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **1**: `fix(ui): remove mobile sidebar border + use Menu icon on mobile` - apps/fe/src/components/ui/sidebar.tsx
- **2**: `fix(ui): move agent session button to pane menu + fix dropdown outside-click` - apps/fe/src/components/ui/dropdown-menu.tsx, apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx

---

## Success Criteria

### Verification Commands
```bash
# Lint
bun run lint

# Dev server (for Playwright QA)
bun run dev
```

### Final Checklist
- [ ] 移动端 Sheet 无右侧边框
- [ ] 移动端左上角为 Menu 图标
- [ ] 桌面端左上角仍为 PanelLeftIcon
- [ ] 多 pane 窗口的 pane 菜单含"新建 Agent Session"
- [ ] 单 pane 窗口仍有内联"新建 Agent Session"按钮
- [ ] DropdownMenu 打开时外部点击仅关闭菜单
- [ ] 无 lint 错误
