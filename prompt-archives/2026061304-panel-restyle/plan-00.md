# Plan-00：侧栏三区"浮动圆角面板"统一重设计

## 背景

tmex 前端（`apps/fe`）侧栏已 Tab 化（`panes`/`agent`/`files`），但三个区域的视觉语言各自为政，和右侧终端壳的"浮动圆角面板"质感不统一：

- **终端壳**（视觉基准，`DevicePage.tsx:891-894`）：`rounded-xl` + 自有背景（`terminalTheme.background`）+ `px-3 py-1` 内边距，像一块浮动面板；下方快捷键条 `bg-muted rounded-xl`；侧栏本体用 shadcn `variant="inset"`（浮动+圆角+ring）。
- **Sidebar Tab**（`app-sidebar.tsx`）：`TabsList w-full p-1`，药丸 trigger。
- **Pane List**（`sidebar-device-list.tsx`）：设备段 `rounded-lg border` + header `bg-muted/30 border-b`，window/pane 行大量成对描边（`border border-primary/30`）+ `bg-primary/15`，描边噪点多。
- **Agent Chat**（`agent-tab.tsx`/`chat-thread.tsx`/`messages/*`）：聊天区已是 `bg-muted/50 rounded-xl`，但输入区是全宽 `border-t p-3` 横条，头部用 `Separator` 硬分隔。

## 目标

三个区域统一到终端壳的"圆角浮动面板 + 留白分层"语言，明暗两套用语义 token 自动适配，**不改交互逻辑/数据流**，仅 className 与容器层级微调。

## 设计 token（从终端壳提炼）

| 维度 | 规则 |
|---|---|
| 圆角层级 | 外层面板 `rounded-xl` → 内部交互行 `rounded-lg` → chip/badge `rounded-md`（同心收敛） |
| 表面分层 | 页底 `bg-sidebar` → 面板 `bg-card`/`bg-muted/50` → 行 hover `bg-accent` |
| 留白优先描边 | 面板间用 `gap`/`mx-2`，描边只保留极轻一道（`border-border/60`） |
| 浮层 | `border bg-background/95 shadow-md backdrop-blur`（SelectionToolbar 基准） |

## 任务清单

### 1. Sidebar Tab（`components/page-layouts/components/app-sidebar.tsx`）
- `TabsList`：`w-full p-1` → `w-full p-1 rounded-xl border border-border/60`（保留与 device 段一致的极轻描边）。
- trigger（`tabTriggerClassName`）：`rounded-md` → `rounded-lg`，与 xl 轨道同心收敛。
- Tab 栏左右内边距对齐下方面板（`SidebarHeader` 已含 padding，确认轨道不贴边）。

### 2. Pane List（`components/page-layouts/components/sidebar-device-list.tsx`）
- 设备段 `DeviceSection`：`rounded-lg border` → `rounded-xl border border-border/60`；选中 `bg-card`、在线 `bg-card/50`→`bg-muted/40`、离线 `bg-muted/20`。
- header：去掉 `border-b bg-muted/30` 硬分隔，改为安静内间距头部；选中态左侧 `w-0.5 accent` 条保留。
- `WindowItem` 行：去掉成对 `border border-primary/30`/`border-border/70` 描边 → 选中 `bg-primary/10`、active `bg-accent`，统一 `rounded-lg`，active 用左侧细条/无整圈描边。
- `PaneTreeItem`/会话行：同样去描边噪点，保留 `rounded-lg` + hover；树缩进 `border-l` 改 `border-border/50` 更轻。
- 同心圆角：外面板 `rounded-xl`，行 `rounded-lg`，badge `rounded-md`。

### 3. Agent Chat（`agent-tab.tsx` + `chat-thread.tsx` + `messages/*`）
- 输入区 `ChatInput`：全宽 `border-t p-3` → 收进 `bg-muted/50 rounded-xl mx-2 mb-2 p-2.5` 浮动面板，与聊天区上下成对。
- 头部：去掉 `<Separator />` 硬分隔，改留白；binding chip 维持 `rounded-full`。
- 气泡同心收敛：用户气泡 `rounded-lg` → `rounded-2xl`；工具卡 `rounded-md` → `rounded-lg`（`tool-call-card.tsx`）。
- 各 banner（orphan/mismatch/error）已是 `rounded-md`，统一为 `rounded-lg` 收敛。

## 验收标准

1. 三个区域与终端壳同属"圆角浮动面板 + 留白分层"语言，圆角同心收敛（xl→lg→md）。
2. 明暗两套都靠语义 token 自动适配，无硬编码颜色。
3. Tab 轨道保留与 device 段一致的极轻描边。
4. 交互逻辑、data-testid、数据流零改动；`bun run typecheck` / 既有 e2e 选择器不受影响。

## 风险

- `sidebar-device-list.tsx` 描边/背景条件分支较多，需逐处对齐，避免选中/active/hover 三态错乱。
- 不得触碰生产环境与生成文件；验证只在仓库内临时实例。
