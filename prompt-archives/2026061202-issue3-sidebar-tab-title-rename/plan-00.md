# Issue #3：sidebar tab 标题跟随终端、宽度可调、多行、重命名与菜单合并 — 实现计划

## 背景

GitHub issue #3 反馈窗口无法重命名。krhougs 在评论区给出修复方案（5 项需求，见 plan-prompt.md）。

关键现状（探索结论，没有上下文时可据此重新开始任务）：

- 终端页顶栏标题由 `apps/fe/src/utils/terminalMeta.ts` 的 `buildTerminalLabel` 生成：`${windowIdx}/${paneIdx}: ${paneTitle ?? windowName}@${deviceName}`，其中 `paneTitle` 来自 OSC 0/1/2（gateway `pane-stream-parser.ts` 解析后进入 snapshot 的 `TmuxPane.title`）。
- sidebar 窗口 tab（`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx` 的 `WindowItem`）目前只显示 `window.name`（tmux 窗口名），单行 truncate，右侧绝对定位一个 × 按钮（AlertDialog 确认后关闭）。
- WS 协议（borsh）中 **rename 链路已预留**：`KIND_TMUX_RENAME_WINDOW = 0x0206`、`TmuxRenameWindowSchema { deviceId, windowId, name }`、前端 `buildTmuxRenameWindow`（无人调用）、gateway `handleRenameWindow` → `runtime.renameWindow` → `tmux rename-window`。但按需求 4，名字应存 **gateway 内存 overlay**，不走 tmux rename（走 tmux rename 会关闭 automatic-rename，违背需求 1 的"tab 跟随终端 set 的标题"）。
- snapshot 同步：runtime `onSnapshot` → `WebSocketServer.broadcastStateSnapshot`（`apps/gateway/src/ws/index.ts`）→ 全部 client；新 client 连接时直接发 `entry.lastSnapshot`。这是 customName 同步策略的天然载体。
- `WebSocketServer` 是 gateway 进程级单例；`DeviceConnectionEntry`/runtime 在无 client 时销毁重建，所以 overlay Map 必须挂在 WebSocketServer 实例上（跨重连存活，gateway 进程生命周期内"持久"）。
- sidebar 宽度：`apps/fe/src/components/ui/sidebar.tsx`（shadcn 风格 + Base UI），桌面 `--sidebar-width: 16rem` 固定，移动端用 Sheet（18rem）。
- 弹出菜单可复用 `apps/fe/src/components/ui/dropdown-menu.tsx`（Base UI Menu）；对话框有 `dialog.tsx` / `alert-dialog.tsx` / `input.tsx`。
- i18n：改 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 后跑 `bun run build:i18n` 重新生成 `resources.ts`/`types.ts`（生成文件严禁手改/lint）。
- e2e：Playwright（`apps/fe/tests/`），`sidebar-close-confirm.spec.ts`、`sidebar-delete.spec.ts` 依赖 `window-close-${id}` testid，菜单化后需同步更新。本机 e2e 注意端口（9883 被常驻 tmex 占用，需用 TMEX_E2E_* 覆盖）。

## 注意事项

- **严禁触碰本机生产 tmex**（launchd 常驻、9883 端口、`~/Library/Application Support/tmex/`）。验证起临时实例需显式覆盖 shell 继承的 app.env 变量。
- borsh schema 字段顺序即线序，前后端同仓同发版，`WindowWireSchema` 直接加 `customName: OptionStringSchema` 即可（无需兼容旧 wire）。
- 生成文件（`resources.ts`、`types.ts`、`fe-dist`）不 lint/format。

## 设计

### 需求 4：重命名 + gateway 内存持久化 + 同步

- `WebSocketServer` 上新增 `windowCustomNames: Map<deviceId, Map<windowId, string>>`。
- 复用 `KIND_TMUX_RENAME_WINDOW` 消息；`handleRenameWindow` 改为：trim、截断 64 字符；空字符串 → 删除条目（恢复自动标题）；否则写入；随后用 `entry.lastSnapshot` 立即向该设备所有 client 重新广播 snapshot（同步策略）。不再调用 `runtime.renameWindow`（保留 runtime/connection 接口不动）。
- snapshot 发送统一经过 `applyWindowCustomNames(deviceId, payload)`：把 overlay 注入每个 window 的 `customName`，同时清理 snapshot 中已不存在的 windowId 条目（session 为 null 时不清理）。`entry.lastSnapshot` 保存原始快照。
- 协议改动：`TmuxWindow` 加 `customName?: string`；`WindowWireSchema` 加 `customName: OptionStringSchema`；`convert.ts` encode/decode 透传。
- 前端 store（`stores/tmux.ts`）加 `renameWindow(deviceId, windowId, name)`，发 `buildTmuxRenameWindow`。

### 需求 1+3：tab 标题跟随终端 + 多行

- 窗口显示名统一为：`customName ?? 活跃pane.title ?? window.name`（与顶栏 title 部分一致）。
- `buildTerminalLabel` 增加 `windowCustomName` 入参，title 部分改为 `customName ?? paneTitle ?? windowName`；`DevicePage.tsx` 两处调用（terminalTopbarLabel、PageTitle）传入 `selectedWindow.customName`。
- sidebar tab 文本 `truncate` → `line-clamp-2 break-all`（窗口行与 pane 行一致处理）。

### 需求 5：⋮ 菜单合并重命名/关闭

- `WindowItem` 右侧 × 替换为 ⋮（EllipsisVertical）DropdownMenu，菜单项：重命名、关闭窗口（destructive）。testid：`window-menu-${id}`、`window-menu-rename-${id}`、`window-menu-close-${id}`。
- 关闭仍走现有 AlertDialog 确认；重命名打开 Dialog（Input，maxLength 64，空值禁用保存；已有 customName 时提供"恢复自动名称"按钮 → 发送空串清除）。
- pane 行无重命名概念，保留原 × 关闭按钮。

### 需求 2：sidebar 宽度可调

- `sidebar.tsx`：宽度状态进 `SidebarProvider`（px 数值，初始读 `localStorage['tmex_sidebar_width']`，clamp 192–480，默认 256），`--sidebar-width` 用动态值；新增右缘拖拽条（pointer capture，拖动时禁用 width transition，松手持久化）。
- 移动端 Sheet 宽度改为 `100vw`（强制占满）。

## 任务清单

1. shared：`index.ts`（TmuxWindow.customName、RenameWindowPayload、WsMessageType 补 `tmux/rename-window`）、`ws-borsh/schema.ts`、`ws-borsh/convert.ts`；相关单测更新。
2. gateway：`ws/index.ts` overlay Map、`applyWindowCustomNames`、`handleRenameWindow` 改写、两处 snapshot 发送点接入；`ws/index.test.ts` 增加单测。
3. i18n：三语新增 `window.rename`、`window.renamePlaceholder`、`window.renameReset`、`window.menu` 等 key，跑 `bun run build:i18n`。
4. fe store：`renameWindow` action。
5. fe 标题：`terminalMeta.ts` + `DevicePage.tsx` 两处。
6. fe sidebar 列表：显示名逻辑、多行、⋮ 菜单 + 重命名 Dialog。
7. fe sidebar 宽度：Provider 状态 + 拖拽条 + 移动端全宽。
8. e2e：更新 `sidebar-close-confirm.spec.ts`、`sidebar-delete.spec.ts`（关闭入口菜单化）；新增 `sidebar-rename.spec.ts`（重命名→显示→reload 后仍在→恢复自动名）。
9. 验证：typecheck、单测（shared/gateway/fe）、相关 e2e（临时端口）。

## 验收标准

- sidebar 窗口 tab 显示终端 set 的标题（OSC title），随终端变化；与顶栏 title 一致。
- tab 文本可换行（最多 2 行）。
- ⋮ 菜单含重命名/关闭；重命名后所有已连接客户端 tab 立即更新；刷新页面（gateway 不重启）名字仍在；空名不可保存；可恢复自动名称。
- 桌面 sidebar 可拖拽调宽且持久化；移动端 sidebar 占满全宽。
- 既有测试与新增测试通过。

## 风险

- borsh schema 变更需前后端一起发版（同仓同发，可接受）。
- gateway 重启后自定义名丢失——用户方案明确接受（内存持久化）。
- e2e 受本机环境影响（端口/flaky 清单见 memory），失败需区分既有 flaky。
