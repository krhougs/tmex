# 终端自定义快捷键列表 — 执行结果

## 工作环境（重要）

全程在**独立 git worktree** 内完成，未触碰主工作区，也未触碰本机生产 tmex（9883 常驻服务及安装目录）：

- worktree：`/Users/krhougs/LocalCodes/tmex-terminal-custom-shortcuts-worktree`
- 分支：`terminal-custom-shortcuts`（基于 `main` @ 7bb9ac4）
- 所有存档、代码、迁移、测试、临时实例、自验收、结果存档均在该 worktree 内进行。
- 验证用仓库内临时实例：`NODE_ENV=test` 的 gateway（端口 9665）+ vite dev（端口 9885）+ 临时 SQLite（`/tmp/tmex-e2e-*.db`），显式避开生产 9883。
- 改动目前**未提交**（按约定，未经用户指示不 commit）；如需保留请在该 worktree 分支上提交。

## 已实现功能（对应需求 1–8）

1. **自定义快捷键列表 + 服务器持久化**：新增单例表 `terminal_shortcut_settings`（SQLite + drizzle migration `0009`），REST `GET/PATCH /api/settings/terminal-shortcuts`。设置面板里与「本机设置（存浏览器）」用分隔线 + 文案明确区分「保存在服务器、多端共享、需点保存生效」。
2. **默认列表（migration 直接写入）**：迁移 SQL 末尾 `INSERT OR IGNORE` 写入默认单例行，12 项：粘贴(action)/Enter/SHIFT-TAB(`\x1b[Z`)/ESC/CTRL-C/CTRL-D/↑↓←→/SHIFT-Enter/Backspace。
3. **管理表：排序 + 录入**：@dnd-kit 拖拽排序；三种录入入口——按键捕获（自动识别控制序列 + 生成标签）、特殊动作按钮、高级手填（转义解析）。
4. **保存后实时生效**：保存 mutation 成功后 `setQueryData` + 失效 query，DevicePage 终端栏经同一 react-query key 立即重渲染。
5. **特殊动作**：粘贴 / 切换文本框键盘 / 新建 Agent 会话 / 终端回到最下方——终端栏固定用 lucide 图标（文字太长），设置页给完整中文说明文字。
6. **等宽字体**：快捷按钮统一 `font-mono`。
7. **图标开关**：「使用图标展示快捷键」Switch，开启后 send 类按键名渲染为苹果风格符号（⌃⇧⏎⌫⎋⇥ 等，依赖 NotoSansSymbols2 兜底字体）。
8. **实时预览**：编辑器顶部预览条复用 `ShortcutButtonRow`，编辑/拖拽/切图标即时反映、保存前可见。

## 关键设计

- **数据模型**（`packages/shared/src/index.ts`）：`TerminalShortcutItem { id, type:'send'|'action', label, payload?, action? }`，`DEFAULT_TERMINAL_SHORTCUTS`、`TERMINAL_SHORTCUT_ACTIONS`。
- **后端**：仿 `siteSettings`/`agentSettings` 单例范式；schema JSON 列默认值参考 `deviceTreeOrder`；校验逻辑抽到独立可测模块 `apps/gateway/src/api/terminal-shortcuts.ts`。
- **前端**：新增 `terminalKeySequence.ts`（按键捕获 / 转义解析 / 苹果符号映射）、`terminal-shortcuts-api.ts`（react-query 数据层）、`ShortcutButtonRow.tsx`（终端栏+预览共享）、`TerminalShortcutsEditor.tsx`（编辑器），接入既有 `TerminalSettingsPanel`（双入口复用）。
- **i18n**：`settings.terminal.shortcuts.*` 与 `apiError.terminalShortcut*` 三语（en/zh/ja）齐全，经 `build:i18n` 重建生成文件。

## 对抗式审查 + 修复

用多 agent workflow 从 4 维度（后端/终端栏/编辑器/i18n）只读审查，得 11 条 findings（1 high + 2 medium + 8 low），**全部已修复**：

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| 1 | high | `parseEscapeSequence` 非法转义（`\xGG`/`\u003`）被静默注入 NUL | hex 分支加长度校验，非法转义当字面量；加单测 |
| 2 | medium | paste 在非安全上下文（HTTP 局域网）静默无反馈 | 对齐 Terminal.tsx，`Promise.reject` 兜底 + `catch` 弹错误 toast |
| 3 | medium | 草稿一次性初始化 → 他端更新后陈旧 + 假 dirty + 盲覆盖（lost update） | 改用 baseline 快照：未编辑时跟随服务器最新值，消除假 dirty 与盲覆盖 |
| 4 | low | `toggleKeyboard`/`scrollToBottom` 被 `canInteractWithPane` 守卫误拦 | 纯前端 UI 动作移到守卫前处理 |
| 5 | low | 终端栏与预览 testid 语义错位/潜在重复 | 加 `idPrefix` prop，终端栏用 `terminal-shortcut*` |
| 6 | low | `escapeForDisplay` 漏 C1 控制符（0x80–0x9F） | 覆盖 `0x7f–0x9f`；加单测 |
| 7 | low | dirty 用 `JSON.stringify` 对键顺序敏感 → reset 后假 dirty | `sameItems` 按固定字段顺序归一化比较 |
| 8 | low | query 失败静默空白、无重试 | 加错误态 + 重试按钮（`loadFailed`/`retry` i18n） |
| 9 | low | Ctrl+无控制码字符（Ctrl+1）标签 CTRL-1 但只发裸字符 | 拒绝捕获返回 null；加单测 |
| 10 | low | action 按钮 aria/title 忽略用户自定义 label | 优先用 `item.label`，回退内置动作名 |
| 11 | low | send 空 label 渲染无可访问名 | 回退 `escapeForDisplay(payload)` |

> 残留（已注释、非本次范围）：用户**正在编辑**时发生的并发更新仍可能在保存时覆盖他端，完整解决需乐观并发锁（PATCH 带版本号 / If-Match → 409）；本次已做 baseline 跟随大幅缓解。

## 验证结果

- **类型检查**：`apps/fe` tsc `--noEmit` **0 错误**；gateway 改动文件 tsc 无新增错误（仓库本就存在的第三方类型 pre-existing 报错与本次无关）。
- **单元测试**：`bun test` **52 通过 / 0 失败**——前端 `terminalKeySequence`（按键捕获/转义/符号/边界）+ 后端 `normalizeTerminalShortcutsInput` 校验 + migration 默认数据/单例约束/JSON 往返。
- **e2e**：`tests/terminal-shortcuts.spec.ts` 通过——默认 12 项、文字/图标预览、苹果符号 DOM 断言、添加动作、保存持久化（13 项 + useIcons）。
- **视觉自验收**：无头 Chromium 截图复核两种模式——等宽字体、payload 转义显示、action 图标、拖拽手柄、图标模式苹果符号（⌃⇧⏎⌫⎋⇥）真实渲染无豆腐块（NotoSansSymbols2 兜底生效）。
- **lint**：手写文件 `biome check` 干净；唯一剩余 `DevicePage:387 useExhaustiveDependencies` 为 **pre-existing**（主分支已存在的 `lastDispatchedSelectRef` useEffect，与本次无关，未改动）。

## 主要文件

- 新增：`packages/shared/src/index.ts`(类型)、`apps/gateway/src/api/terminal-shortcuts.ts`(+test)、`apps/gateway/src/db/terminal-shortcuts.test.ts`、`apps/gateway/drizzle/0009_lying_lethal_legion.sql`、`apps/fe/src/utils/terminalKeySequence.ts`(+test)、`apps/fe/src/components/settings/{terminal-shortcuts-api.ts,ShortcutButtonRow.tsx,TerminalShortcutsEditor.tsx}`、`apps/fe/tests/terminal-shortcuts.spec.ts`。
- 修改：`apps/gateway/src/db/{schema.ts,index.ts}`、`apps/gateway/src/api/index.ts`、`apps/fe/src/pages/DevicePage.tsx`、`apps/fe/src/components/settings/terminal-settings-panel.tsx`、i18n 三语 locale + 生成文件。

## 后续

- 如需上生产：走正式发版 + `npx tmex-cli@<version> upgrade`（用户执行）；migration `0009` 会在启动时自动应用并写入默认快捷键。
- 可选增强：乐观并发锁解决编辑中并发覆盖；按键捕获支持更多组合键。
