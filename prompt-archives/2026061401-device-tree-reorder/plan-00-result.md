# 执行结果 — Device Tree 排序（Issue #5）

## 状态：已实现，自动化校验全绿；交互式拖拽待用户在实例上确认。

## 改动概览

### 共享（packages/shared）
- `src/index.ts`：`Device` 接口新增必填 `sortOrder: number`。
- `src/ws-borsh/kind.ts`：新增 `KIND_TMUX_REORDER_WINDOWS=0x020b`、`KIND_TMUX_REORDER_PANES=0x020c`，登记 `VALID_KINDS` / `kindToString`；`index.ts` 重导出。
- `src/ws-borsh/schema.ts`：`TmuxReorderWindowsSchema`、`TmuxReorderPanesSchema`（`b.vec(b.string())`）。
- i18n：`locales/{en_US,zh_CN,ja_JP}.json` 三语新增 `device.dragHandle`、`device.reorderFailed`、`window.dragHandle`、`window.dragHandlePane`，`bun run build:i18n` 重生成 `resources.ts`/`types.ts`。

### gateway
- `db/schema.ts`：`devices.sortOrder`；新表 `deviceTreeOrder`。
- `drizzle/0006_bitter_bushwacker.sql`：建表 + `ALTER devices ADD sort_order` + 按 `created_at` 回填。
- `db/index.ts`：`toDevice`/`createDevice`（递增 sortOrder）/`getAllDevices`（`asc(sortOrder)`）+ `reorderDevices`、`getDeviceTreeOrder`/`setWindowOrder`/`setPaneOrder`。
- `ws/overlay-utils.ts`（新）：纯函数 `applyDeviceTreeOverlay`（确定性降级）。
- `ws/index.ts`：两个 reorder switch case + `handleReorderWindows/Panes`（写 DB → `lastSnapshot` 重广播）；`encodeSnapshotWithOverlays` 链式 overlay，下发与冷连接首帧统一走它。
- `api/index.ts`：`PUT /api/devices/order`（精确匹配置于 `:id` 通配前）→ `handleReorderDevices`。

### 前端（apps/fe）
- `bun add @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2`。
- `ws-borsh/message-builder.ts` + `index.ts`：`buildTmuxReorderWindows/Panes`。
- `stores/tmux.ts`：`reorderWindows`/`reorderPanes` action（含本地乐观重排）。
- `sidebar-device-list.tsx`：三层嵌套 `DndContext`+`SortableContext`（device/window/pane，不跨容器）；独立 `GripVertical` 手柄 + `PointerSensor`(delay 200/tol 8)；device 走 React Query 乐观更新（onMutate/onError/onSettled）；`sortedDevices` 改按 `sortOrder`；pane 行抽出独立 `PaneRow` 组件。

### 测试 fixture
- 14 个测试文件、17 处手写 `Device` 字面量补 `sortOrder: 0`（subagent 完成）。

## 校验结果（均未触碰生产实例，DB 强制 `:memory:`）

> 本机 shell 继承了安装版 app.env（`NODE_ENV=production`、`TMEX_MIGRATIONS_DIR=~/Library/.../gateway-drizzle` 6 条迁移）。`runMigrations()` 走 `resolveMigrationsFolder` 会优先读 `TMEX_MIGRATIONS_DIR`，因此本机跑 gateway 测试须显式覆盖：`NODE_ENV=test TMEX_MIGRATIONS_DIR=<repo>/apps/gateway/drizzle bun test`（CI/干净环境无此变量，按 cwd 取仓库 drizzle，无需覆盖）。

- 触及面（正确 env）：`db` + `ws` + `api/index` + `ws-borsh` 共 94 pass / 0 fail；device fixture 面 `push`+`watch`+`api/agent`+`api/watch`+`test-connection` 113 pass / 0 fail。
- 新增单测：shared ws-borsh reorder（含在 29 pass 内）、overlay-utils + device-order 9 pass。
- FE `tsc --noEmit`：clean；FE `vite build`：exit 0；gateway `bun build`：打包成功。
- 全量 `bun test`（687 用例）：657 pass / 30「fail」。triage：其中 **29 个是既有 Playwright e2e `*.spec.ts`**（`bun test` 误扫到，需 playwright runner，与本次无关）+ **1 个既有 flaky `PaneEmulator`**（ghostty 时序）。`vercel.ai.error` / `connection closed` 等为通过用例的日志输出。**本次改动导致的失败数为 0**。
- 既有与本次无关的 tsc 报错（LanguageModelV3、queuedMessages、runtime Server 泛型、telegram offset、ssh AuthenticationType）未触碰。
- 改进：`apps/gateway/src/ws/index.test.ts` 增加文件级 `beforeAll(runMigrations)`，使新表对所有 describe 可用（顺序无关）。

## 待用户验证（需仓库内临时实例，显式覆盖端口/路径，勿碰 9883 生产）

- 桌面 + 移动模拟：拖动 device / window / pane 的动画与"轻点导航不误触拖拽/连接"。
- 刷新与**重启 gateway**：device 顺序（列）与 window/pane 顺序（表）持久。
- tmux 重启 / 新建 window：未知 id 退回 tmux index、stale id 被清理。

## 后续修复：PC 鼠标无法拖拽（手机正常）

用户反馈手机拖拽正常但 PC 鼠标拖不动。经工作流对抗性诊断（含 @dnd-kit/core@6.3.1 逐行源码核实）定位根因：三层 sensors 用了单个 `PointerSensor{delay:200,tolerance:8}`，`delay` 模式下 tolerance 是「计时期间位移超过即 `handleCancel`」的取消阈值——鼠标按下即移动必然在 200ms 内 >8px 被取消，PC 永远进不了拖拽态；手机长按手指相对静止 <8px 才能熬过 delay。旧版 core 的 PointerSensor 无法按 `pointerType` 分别配约束。

修复（`sidebar-device-list.tsx`）：抽共享 hook `useDeviceTreeSensors()`，拆为 `MouseSensor{distance:8}`（PC 按下即拖）+ `TouchSensor{delay:250,tolerance:5}`（手机长按、让位滚动）+ `KeyboardSensor{sortableKeyboardCoordinates}`，三层统一调用。已排除 opacity-0 手柄、手柄宽度、嵌套冒泡、stopPropagation、父按钮 onClick、ScrollArea 等其他候选（均非成因）。FE `tsc` clean、`vite build` 成功。手机长按仍正常、与滚动/点击导航不冲突（verdict 确认）。

## 设计要点回顾

- 顺序单一真源 = DB；下发时同步读，省内存 Map 双写，天然解决 hydrate。
- reorder 走 `lastSnapshot` 主动重广播，不依赖 snapshot poll、不打 tmux。
- window/pane overlay 为纯显示层，不改 tmux 真实布局；index 徽标仍为 tmux 原生值。
