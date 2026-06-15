# 终端自定义快捷键列表

## Context（背景与目标）

终端底部那条快捷按钮栏（方向键、CTRL-C、ESC、Tab 等）目前是**硬编码**在 `apps/fe/src/pages/DevicePage.tsx` 的 `EDITOR_SHORTCUTS` 数组里，用户无法增删改、无法排序、无法加入「粘贴/新建 Agent 会话」这类动作。

本次要把这条栏做成**用户可自定义、持久化在服务器、多端共享**的快捷键列表，并配套一个带实时预览的管理界面。

与现有终端设置（字号/行高/字体/键盘行为）的关键区别：那些**存浏览器、即改即生效**；快捷键列表**存服务器、需点保存生效**——UI 文案必须把这两类清晰区分（需求 1）。

已确认的决策：
- 「使用图标展示快捷键」开关 → **跟列表一起存服务器**。
- 用户录入自定义快捷键 → **按键捕获 + 高级手填，两者都要**。
- 作用域：**全局单例**（与 `siteSettings`/`agentSettings` 一致；tmex 为单用户自托管）。
- 跨端「实时生效」指当前浏览器保存后立即刷新；其它端靠下次加载/refetch，不引入 WS 推送（YAGNI）。

## 关键现状（调研结论 + 文件锚点）

- 快捷键栏渲染：`DevicePage.tsx:50-124`（`EDITOR_SHORTCUTS` 数组 + `ShortcutsBar` memo 组件），仅在 `inputMode === 'direct'` 时挂载（`kb-floating-shortcuts` 容器）。
- 发送链路：按钮 onClick → `handleSendShortcut(payload)` → `useTmuxStore.getState().sendInput(deviceId, paneId, payload, false)` → `buildTermInput` → Borsh WS。
- 服务端持久化范式：SQLite + Drizzle ORM。单例配置表参考 `agentSettings`（`apps/gateway/src/db/schema.ts:134`，`id=1` + `check` 约束）；JSON 列存有序数组参考 `deviceTreeOrder`（`schema.ts:305`，`text(..., {mode:'json'}).$type<...>().notNull().default(...)`）。
- 现有读写链路（模板）：`GET/PATCH /api/settings/site` → `api/index.ts` 的 `handleGetSiteSettings` / `handleUpdateSiteSettings` / `normalizeSiteSettingsInput` → `db/index.ts` 的 `getSiteSettings` / `updateSiteSettings` / `ensureSiteSettingsInitialized`（`onConflictDoNothing` 写默认单例行）。共享类型在 `packages/shared/src/index.ts`（`SiteSettings` / `UpdateSiteSettingsRequest`）。
- Migration：`apps/gateway/drizzle/`，drizzle-kit 生成 + `db/migrate.ts` 的 `runMigrations()` 启动时执行。
- 特殊动作的现成能力：
  - 粘贴 → `navigator.clipboard.readText()` + `useTmuxStore.getState().paste(deviceId, paneId, text)`（store 已有 `paste`，走 `buildTermPaste`）。
  - 切换文本框键盘 → `useUIStore.setInputMode('direct' ↔ 'editor')`。
  - 新建 Agent Session → `useAgentStore.getState().startDraft(deviceId, paneId, paneTitle)` + `setSidebarTab('agent')`（参考 `sidebar-device-list.tsx` 的 `handleCreateSessionForPane`）。
  - 回到最下方 → `terminalRef.current?.scrollToBottom()`（`Terminal.tsx` 经 `useImperativeHandle` 暴露）。
- UI 资源：图标库 lucide-react；等宽字体 CSS 变量 `--font-mono`（Tailwind `font-mono`），符号兜底字体 `NotoSansSymbols2Tmex` 已挂在字体栈，含苹果风格符号字形；拖拽排序已有 `@dnd-kit/core|sortable|utilities`，用法参考 `sidebar-device-list.tsx`（`DndContext`/`SortableContext`/`useSortable`/`arrayMove`/`MouseSensor`+`TouchSensor`）。
- 设置面板双入口：共享组件 `components/settings/terminal-settings-panel.tsx`，被 `terminal-tab.tsx`（设置页 Tab）与 `terminal-settings-sheet.tsx`（终端页右上角 Sheet）复用；现状面板末尾有 `settings.terminal.savedInBrowser` 文案。

## 设计

### 1. 数据模型（`packages/shared/src/index.ts`）

```ts
export type TerminalShortcutAction =
  | 'paste' | 'toggleKeyboard' | 'newAgentSession' | 'scrollToBottom';

export interface TerminalShortcutItem {
  id: string;                       // 稳定 id（crypto.randomUUID），拖拽 & React key
  type: 'send' | 'action';
  label: string;                    // 显示文字（可编辑）；action 为空时回退到内置 i18n 名
  payload?: string;                 // type==='send'：发送到终端的原始序列
  action?: TerminalShortcutAction;  // type==='action'
}

export interface TerminalShortcutSettings {
  items: TerminalShortcutItem[];
  useIcons: boolean;
  updatedAt: string;
}
export interface UpdateTerminalShortcutSettingsRequest {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

export const DEFAULT_TERMINAL_SHORTCUTS: TerminalShortcutItem[] = [ /* 见下 */ ];
```

默认列表（需求 2，迁移直接写入；payload 沿用现状 `EDITOR_SHORTCUTS` 取值，新增 SHIFT-TAB = reverse-tab `\x1b[Z`）：

| label | type | payload / action |
|---|---|---|
| 粘贴 | action | `paste` |
| Enter | send | `\r` |
| SHIFT-TAB | send | `\x1b[Z` |
| ESC | send | `\x1b` |
| CTRL-C | send | `\x03` |
| CTRL-D | send | `\x04` |
| ↑ | send | `\x1b[A` |
| ↓ | send | `\x1b[B` |
| ← | send | `\x1b[D` |
| → | send | `\x1b[C` |
| SHIFT-Enter | send | `\x1b[13;2u` |
| Backspace | send | `\x08`（沿用现状） |

### 2. 后端

**Schema**（`apps/gateway/src/db/schema.ts`，新增单例表，import `TerminalShortcutItem` from `@tmex/shared`）：
```ts
export const terminalShortcutSettings = sqliteTable('terminal_shortcut_settings', {
  id: integer('id').primaryKey(),
  items: text('items', { mode: 'json' }).$type<TerminalShortcutItem[]>()
    .notNull().default(DEFAULT_TERMINAL_SHORTCUTS),
  useIcons: integer('use_icons', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
}, (t) => [check('terminal_shortcut_settings_singleton_check', sql`${t.id} = 1`)]);
```

**Migration**：drizzle-kit 生成建表 SQL（DDL 自带 `DEFAULT` 默认 JSON）；在生成的 `.sql` 末尾**手动追加一行 INSERT**（满足需求 2「migration 直接写入」，且不必手写大 JSON——items/use_icons 走列默认）：
```sql
INSERT INTO terminal_shortcut_settings (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z');
```

**DB 函数**（`apps/gateway/src/db/index.ts`，仿 site 三件套）：`getTerminalShortcutSettings()`、`updateTerminalShortcutSettings({items, useIcons})`（`set` + 刷新 `updatedAt`，`where id=1`）、`ensureTerminalShortcutSettingsInitialized()`（`onConflictDoNothing` 兜底，防单例行缺失）。

**API**（`apps/gateway/src/api/index.ts`，仿 site 路由）：`GET /api/settings/terminal-shortcuts`、`PATCH /api/settings/terminal-shortcuts`，新增 `normalizeTerminalShortcutsInput(body)` 做服务端校验（每项 `id` 非空、`type∈{send,action}`、send 必须有 `payload`、action 必须是合法枚举、`label` 长度上限、items 数量上限如 50；非法 → 400）。在 site 路由注册处旁边挂载。

### 3. 前端工具函数（`apps/fe/src/utils/terminalKeySequence.ts` + 单测）

新写并配 `*.test.ts`（TDD）：
- `keyEventToTerminalSequence(e: KeyboardEvent): { label, payload } | null`——按键捕获核心。覆盖：Ctrl+字母→`\x01..\x1a`、Enter/Shift+Enter、Tab/Shift+Tab、Esc、Backspace、Delete(`\x1b[3~`)、方向键、Home/End/PgUp/PgDn、F1–F12、普通可打印字符；修饰键组合走 CSI/xterm 序列；自动生成 `CTRL-C` / `SHIFT-Enter` 风格 label。
- `parseEscapeSequence(input: string): string`——高级手填用，解析 `\xHH` `\uHHHH` `\r` `\n` `\t` `\e` 等转义为真实字节。
- `labelToSymbols(label: string): string`——图标模式用，把 `CTRL`→`⌃`、`SHIFT`→`⇧`、`ALT`→`⌥`、`CMD`→`⌘`、`ENTER/RETURN`→`⏎`、`ESC`→`⎋`、`TAB`→`⇥`、`BACKSPACE`→`⌫`、`DELETE`→`⌦`、`SPACE`→`␣`，方向键保持；按 `-`/`+` 分词逐 token 映射后拼接。

### 4. 前端数据层（`apps/fe/src/components/settings/terminal-shortcuts-api.ts`）

仿 `components/watch/api.ts`：导出 `terminalShortcutsQueryKey`、`fetchTerminalShortcuts()`、`updateTerminalShortcuts(payload)`。用 react-query：DevicePage `useQuery` 读，编辑器 `useMutation` 写，`onSuccess` → `invalidateQueries(terminalShortcutsQueryKey)` 实现保存后**实时生效**（需求 4）。

### 5. 前端展示组件改造

**抽共享展示组件** `apps/fe/src/components/settings/ShortcutButtonRow.tsx`（presentational，真实栏 + 预览复用）：
- props：`items`、`useIcons`、`onActivate?(item)`、`disabled`、`interactive`。
- 渲染规则：
  - `send` + `useIcons=false` → 文字 `label`（如 `CTRL-C`）。
  - `send` + `useIcons=true` → `labelToSymbols(label)`（如 `⌃C`），用 `NotoSansSymbols2Tmex` 兜底。
  - `action` → **始终用 lucide 图标**（文字太长，需求 5）：`paste`=ClipboardPaste、`toggleKeyboard`=Keyboard、`newAgentSession`=Radar、`scrollToBottom`=ArrowDownToLine；`title`/`aria-label` 给完整文案。
- 按钮加 `font-mono`（需求 6，等宽字体），沿用现有 `terminal-shortcut-btn` 配色与触屏尺寸 class。

**改造 `DevicePage.tsx`**：删除硬编码 `EDITOR_SHORTCUTS`；`ShortcutsBar` 改为从 `useQuery(terminalShortcutsQueryKey)` 读 `items`+`useIcons`，渲染 `ShortcutButtonRow`。新增 action 分发器（`send`→既有 `handleSendShortcut`；`paste`/`toggleKeyboard`/`newAgentSession`/`scrollToBottom` → 接前述现成能力，复用 `terminalRef`/`useUIStore`/`useAgentStore`/`useTmuxStore`）。

### 6. 设置面板编辑器（`apps/fe/src/components/settings/TerminalShortcutsEditor.tsx`）

接入 `TerminalSettingsPanel`，把面板分成两块、文案区分（需求 1）：
- 区 A「本机设置」= 现有字号/行高/字体/键盘行为，标注「仅当前浏览器，即改即生效」。
- 区 B「快捷键」= 新编辑器，标注「**保存在服务器，多端共享，需点保存生效**」。

编辑器内容：
- **实时预览条**（需求 8）：渲染当前**草稿** `items`+`useIcons` 的 `ShortcutButtonRow`（`interactive=false`），外观与真实栏一致，编辑/拖拽/切图标开关即时反映、保存前可见。
- **图标开关**（需求 7）：`Switch` 绑定草稿 `useIcons`。
- **管理列表**：dnd-kit 拖拽排序（参考 `sidebar-device-list.tsx`，`arrayMove` 写回草稿）；每行可编辑 `label`、删除；`send` 行可展开编辑 `payload`（高级）。
- **添加快捷键**三入口：① 按键捕获框（`onKeyDown` → `keyEventToTerminalSequence` → 入草稿）；② 特殊动作选择（paste/toggleKeyboard/newAgentSession/scrollToBottom，设置页给完整中文说明文字，需求 5）；③ 高级手填（label + payload，经 `parseEscapeSequence`）。
- **保存**（mutation + invalidate）/ **重置为默认**（`DEFAULT_TERMINAL_SHORTCUTS`）。草稿态用 `useState` 持有 `items`/`useIcons` 副本，编辑不立即提交；保存成功后草稿与服务端对齐。

### 7. i18n

在 i18n **源文件**（`packages/shared/src/i18n/` 下的源 locale，非生成的 `resources.ts`）新增 `settings.terminal.shortcuts.*` 等 key（标题、两区文案、四个动作的完整说明、按钮/提示文案），然后跑 `bun run build:i18n` 重建。**不要手改/lint 生成的 `resources.ts`/`types.ts`**。

## 关键文件清单

- 新增：`apps/fe/src/utils/terminalKeySequence.ts`(+test)、`apps/fe/src/components/settings/terminal-shortcuts-api.ts`、`ShortcutButtonRow.tsx`、`TerminalShortcutsEditor.tsx`；gateway 新 migration `.sql`。
- 修改：`packages/shared/src/index.ts`（类型+默认列表）、`apps/gateway/src/db/schema.ts`、`apps/gateway/src/db/index.ts`、`apps/gateway/src/api/index.ts`、`apps/fe/src/pages/DevicePage.tsx`、`apps/fe/src/components/settings/terminal-settings-panel.tsx`、i18n 源 + `build:i18n` 产物。

## 验收 / 验证

- **后端测试**（`bun test`，走 `test.env`）：`normalizeTerminalShortcutsInput` 校验分支、`get/update/ensure` 读写、migration 建表 + 默认单例行存在且 items=12 项。
- **前端单测**：`terminalKeySequence.test.ts`——捕获→payload（Ctrl+C/方向键/Shift+Tab/F5…）、`parseEscapeSequence`、`labelToSymbols`。
- **临时实例 + 无头浏览器自验收**（视觉改动自己截图，遵循个人记忆）：仓库内起临时实例，**显式覆盖** app.env 继承变量（`NODE_ENV=development`、`TMEX_FE_DIST_DIR`、`GATEWAY_PORT`/端口用 9885/9665 避开常驻 9883、`DATABASE_URL` 指向临时 db），用临时 db 验证迁移默认数据；截图设置面板预览条（文字模式 + 图标模式各一张，验证苹果符号 `⌃⇧⏎⌫⎋` 正常显示、等宽字体生效、action 图标），并验证拖拽排序、保存后终端栏即时刷新。

## 风险 / 注意事项

- **严禁触碰本机生产 tmex**（9883 常驻服务及其安装目录）；所有验证在仓库内临时实例、显式覆盖被 shell 继承的 app.env 变量。
- **生成文件不 lint/format**：i18n `resources.ts`/`types.ts` 只能由 `build:i18n` 重建。
- 苹果风格符号依赖 `NotoSansSymbols2Tmex` 字形覆盖——必须截图确认不出豆腐块；个别符号缺字形则在 `labelToSymbols` 改用已确认可用的码点或 lucide 兜底。
- `Backspace` payload 沿用现状 `\x08`（与现有 `EDITOR_SHORTCUTS` 一致，避免引入行为变化）；如实测退格异常再评估改 `\x7f`。
- action 类型在终端栏始终以图标呈现（文字太长），`useIcons` 开关只切换 `send` 类型的文字/符号显示。

## 任务清单

1. **先存档**：`prompt-archives/2026061600-terminal-custom-shortcuts/` 建 `plan-prompt.md`（原始 prompt）+ `plan-00.md`（本计划）。
2. 共享类型 + `DEFAULT_TERMINAL_SHORTCUTS`（`packages/shared`）。
3. 后端：schema 单例表 → drizzle-kit 生成 migration + 追加默认行 INSERT → `get/update/ensure` 函数 → API 路由 + `normalize` 校验 → 后端测试。
4. 前端工具 `terminalKeySequence.ts`（捕获/转义/符号）+ 单测（TDD 先行）。
5. 前端数据层 `terminal-shortcuts-api.ts`（fetch/update/queryKey）。
6. 共享展示组件 `ShortcutButtonRow`（等宽 + 图标规则）；改造 `DevicePage` 的 `ShortcutsBar` 从 query 渲染 + action 分发。
7. 编辑器 `TerminalShortcutsEditor`（拖拽/三入口录入/图标开关/实时预览/保存）接入 `TerminalSettingsPanel` + 两区文案区分。
8. i18n 源加 key + `build:i18n`。
9. 验收：后端测试、前端单测、临时实例无头截图（文字/图标/等宽/拖拽/保存即时刷新）。
10. **结果存档**：`plan-00-result.md` 写执行总结。
