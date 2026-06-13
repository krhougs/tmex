# Device Tree 排序优化（Issue #5）— 定稿

## Context

Issue #5：device tree 支持两层拖拽排序并**持久化服务端**，照顾移动端触摸与友好动画：

1. 拖动 device 标题行调整设备顺序；
2. 拖动 device tree 内 window / pane 调整顺序（agent session 暂不排序）。

现状：device 是 DB 实体但前端按**名称**排序（`sidebar-device-list.tsx:385`），表无顺序列；window/pane 来自 **tmux 实时快照**，按 tmux `index` 排。gateway 已有内存 overlay 范式 `windowCustomNames`（`ws/index.ts:671-715`，下发前改写 payload）。

**已确认设计**：window/pane 用 **DB 显示层 overlay（统一）**，不触碰 tmux 真实布局；拖拽用 **@dnd-kit**。

> 本计划已经一轮并行只读核查 + 架构评审加固（3 个 blocker 已纳入）。

---

## 关键设计决策（定稿）

- **顺序数据单一真源 = DB**：不再维护内存顺序 Map（避免双写一致性）。下发快照时**同步读** `device_tree_order` 表（bun-sqlite 同步、PK 查询，开销可接受），喂给纯函数 `applyDeviceTreeOverlay` 重排数组；随后再叠加现有 `applyWindowCustomNames`（先重排、后改名，互不覆盖）。这同时解决了"重启/冷连接如何 hydrate"——每次下发都读最新 DB。
- **reorder 后必须主动重广播**：`handleReorder*` 照搬 `handleRenameWindow`（`ws/index.ts:684-685）`收尾——取 `entry.lastSnapshot`，存在则立即 `sendSnapshotToClients(entry, lastSnapshot)`。**不触发** `requestSnapshot`/`scheduleSnapshot`（reorder 不碰 tmux，poll 仅选中态 1s，依赖它会漏刷）。
- **device 排序统一在后端**：`getAllDevices` 改 `orderBy(asc(sortOrder))`，所有消费 `/api/devices` 的视图（sidebar、DevicesPage、agent-tab 等 4+ 处）自动一致；sidebar 不再按 name 排，信任后端顺序。
- **WS 消息粒度（定稿）**：两个常量、单 scope 增量——`KIND_TMUX_REORDER_WINDOWS = 0x020b`（payload: deviceId + 有序 windowIds）、`KIND_TMUX_REORDER_PANES = 0x020c`（payload: deviceId + windowId + 有序 paneIds）。`b.vec(b.string())` 为数组原语（已验证 `HelloS2CSchema.capabilities` 在用），泛型 `encodePayload/decodePayload` 足够，无需写 convert.ts。
- **降级规则（纯函数内确定性实现）**：每个数组按保存 order 过滤出仍存在的 live id 保序在前，order 中没有的 live id 按 tmux index 追加在后，order 里已不存在的 stale id 忽略（即清理）。DB 写回**惰性**——仅 `handleReorder` 写入时用当前 live id 覆盖，下发路径只读不写。

---

## Part A：Device 排序（服务端 + 全视图统一）

- `packages/shared/src/index.ts`：`Device` 接口加 `sortOrder: number`。
- `apps/gateway/src/db/schema.ts`：`devices` 加 `sortOrder: integer('sort_order').notNull().default(0)`。
- 迁移：`cd apps/gateway && bun run db:generate` 生成；**手工编辑**生成 SQL 追加按 `created_at` 回填（子查询计数，**不用 ROWID** 防 VACUUM 后不连续）：
  ```sql
  UPDATE `devices` SET `sort_order` = (
    SELECT COUNT(*) FROM `devices` d2 WHERE d2.`created_at` < `devices`.`created_at`
  );
  ```
- `apps/gateway/src/db/index.ts`：`toDevice` 带出 `sortOrder`；`createDevice` 写 `sortOrder = max(sort_order)+1`；`getAllDevices` 改 `orderBy(asc(devices.sortOrder), desc(devices.createdAt))`；新增 `reorderDevices(orderedIds: string[])`（单事务按下标写 `sort_order` + 刷新 `updatedAt`）。
- `apps/gateway/src/api/index.ts`：在 `/api/devices/:id` 通配正则**之前**（约 `:166`）插入**精确匹配** `path === '/api/devices/order' && method === 'PUT'` → `handleReorderDevices(req)`，body `{ deviceIds: string[] }`（全量有序，避免增量空洞/重复），调 `reorderDevices`，返回新列表。

## Part B：Window/Pane 顺序 overlay（服务端）

- `apps/gateway/src/db/schema.ts`：新表
  ```ts
  export const deviceTreeOrder = sqliteTable('device_tree_order', {
    deviceId: text('device_id').primaryKey().references(() => devices.id, { onDelete: 'cascade' }),
    windows: text('windows', { mode: 'json' }).$type<string[]>().notNull().default([]),
    panes: text('panes', { mode: 'json' }).$type<Record<string, string[]>>().notNull().default({}),
    updatedAt: text('updated_at').notNull(),
  });
  ```
  （default 用合法 JSON 字面量；FK cascade 随设备删除清理）配套迁移。
- `apps/gateway/src/db/index.ts`（或 `db/device-tree-order.ts`）：`getDeviceTreeOrder(deviceId)`、`setWindowOrder(deviceId, windowIds)`、`setPaneOrder(deviceId, windowId, paneIds)`（upsert，last-write-wins）。
- **新文件** `apps/gateway/src/ws/overlay-utils.ts`：导出纯函数 `applyDeviceTreeOverlay(payload, order)`——按上述降级规则重排 `session.windows` 与每个 `window.panes`，无副作用、可单测。
- ws-borsh 协议：
  - `kind.ts`：加 `KIND_TMUX_REORDER_WINDOWS=0x020b`、`KIND_TMUX_REORDER_PANES=0x020c`，并登记进 `VALID_KINDS`（`:54`）与 `kindToString`（`:94`）。
  - `schema.ts`（`:119` 后）：`TmuxReorderWindowsSchema = b.struct({ deviceId: b.string(), windowIds: b.vec(b.string()) })`、`TmuxReorderPanesSchema = b.struct({ deviceId: b.string(), windowId: b.string(), paneIds: b.vec(b.string()) })`。
  - 导出到 `ws-borsh/index.ts`（kind + schema）。
  - `apps/fe/src/ws-borsh/message-builder.ts`（`:106` 后）：`buildTmuxReorderWindows` / `buildTmuxReorderPanes`（仿 `buildTmuxRenameWindow`）。
- `apps/gateway/src/ws/index.ts`：
  - switch（`:311-351`）加两个 case → `handleReorderWindows(deviceId, windowIds)` / `handleReorderPanes(deviceId, windowId, paneIds)`：写 DB（`setWindowOrder`/`setPaneOrder`）→ 取 `entry.lastSnapshot` 立即 `sendSnapshotToClients`。
  - `sendSnapshotToClients`（`:717`）链式：`encodeStateSnapshot(applyWindowCustomNames(applyDeviceTreeOverlay(payload, getDeviceTreeOrder(payload.deviceId))))`。
- 前端按收到的快照顺序渲染，无需再排序 window/pane。

## Part C：前端拖拽（@dnd-kit）

- 依赖：`cd apps/fe && bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`（dependencies）。
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`：
  - `DndContext` 放 `SidebarGroup` 内、`ScrollArea` **外**（确保内置 autoscroll 能探测 Viewport 祖先）。
  - **Device 层**（`:418` map）：`SortableContext` 竖直策略；`DeviceSection` 用 `useSortable`，新增 **GripVertical 独立手柄**（`handleRef`）。**整卡片不作拖拽源**，保留 `:680` 未连接态 `onClick=onConnectToggle`；手柄 `onPointerDown/onClick` `stopPropagation` 防误触连接。`onDragEnd` → React Query **乐观更新**：`onMutate` `cancelQueries` + `setQueryData(['devices'], 新序)` 存 previous，`onError` 回滚，`onSettled` 才 `invalidateQueries`（避免 in-flight 重取覆盖），mutation 调 `PUT /api/devices/order`。
  - `sortedDevices`（`:385`）：去掉 name 排序，按后端顺序（或 `sortOrder` 兜底）。
  - **Window 层**（`:740` map）/ **Pane 层**（`:921` map）：各自嵌套 `SortableContext`（`items` 用 id 列表，互不跨容器），行加独立手柄；`onDragEnd` 调 tmux store `reorderWindows(deviceId, orderedWindowIds)` / `reorderPanes(deviceId, windowId, orderedPaneIds)`。
  - **触摸**：`PointerSensor` `activationConstraint { delay: 250, tolerance: 8 }`；手柄触摸热区按现有 `[@media(any-pointer:coarse)]` 放大，移动端保持可见。
  - **动画**：`style.transform = CSS.Transform.toString(transform)`，`transition: isDragging ? 'none' : 'transform 150ms cubic-bezier(0.4,0,0.2,1)'`。
- `apps/fe/src/stores/tmux.ts`（`:586` 后）：`reorderWindows` / `reorderPanes`，用 build 函数发送（仿 `renameWindow:581`）；可选本地快照乐观重排（服务端重广播覆盖）。

## i18n

仅编辑源 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（**三语同步**），加排序相关文案（如 `device.reorder`/`window.reorder`/拖拽手柄 aria-label）；再 `bun run build:i18n` 重生成 `resources.ts`/`types.ts`。**绝不手改生成物、不对其 lint**。

## 测试

- **ws-borsh round-trip**：`packages/shared/src/ws-borsh/convert.test.ts` 加 `describe('TmuxReorder')`，encode→decode 还原 windowIds/paneIds。
- **overlay 纯函数**：新建 `apps/gateway/src/ws/overlay-utils.test.ts`，覆盖空列表 / 全 stale / 部分未知 / 混合 / panes 二维重排。
- **DB**：新建 `apps/gateway/src/db/device-order.test.ts`，`beforeAll` `migrate()`（内存库由 `test-preload.ts` 提供），验证 `reorderDevices` 反映在 `getAllDevices().sortOrder`、`device_tree_order` JSON 序列化。
- 全部 `*.test.ts`（`bun test` 自动发现），不用 `*.integration.ts`。
- `bun run build`（fe `tsc+vite`）+ gateway typecheck。

## 手测（仓库内临时实例）

显式覆盖 `GATEWAY_PORT`/`TMEX_BIND_HOST`/`TMEX_FE_DIST_DIR` 等（**严禁碰生产 9883 实例**）：桌面 + DevTools 移动模拟拖拽 device/window/pane，确认动画与不误触导航/连接；刷新与**重启 gateway**确认 device 顺序（列）与 window/pane 顺序（表）均保留；新建 window / 模拟 tmux 重启确认未知 id 回退 tmux index、stale id 被清理。

## 流程产物（AGENTS.md 规范）

- `prompt-archives/2026061401-device-tree-reorder/`：已存 `plan-prompt.md`；落 `plan-00.md`（本计划），完工写 `plan-00-result.md`。
- `docs/` 下建模块文档（device-tree 排序 / WS 协议补 `KIND_TMUX_REORDER_*`），简体中文 + 中文标点。

## 风险

- tmux id 跨重启不稳定 → 靠纯函数降级（live 保序 + 未知追加 + stale 忽略），tmux 重启后部分顺序丢失（可接受）。
- index 徽标来自 tmux，overlay 重排后可能与显示顺序不连续（已接受，UI 仍显示 tmux index）。
- 拖拽手柄与行点击/连接事件冲突 → 独立手柄 + activation constraint + stopPropagation，重点回归移动端。
- 每次下发同步读 DB → PK 查询开销可忽略，单一真源避免一致性问题。
