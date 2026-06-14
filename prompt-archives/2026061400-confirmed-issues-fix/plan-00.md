# 修复 4 个 confirmed issue（#10 / #11 / #15 / #16）

## Context（背景与目标）

GitHub 仓库 `krhougs/tmex` 的 issue 区有 4 个标记为 `confirmed`（"Ready for agents to work with"）的需求，全部属于前端/设计范畴。本任务要求：**分析依赖、排好顺序、一次性全部修复，每个修复用独立 commit 并通过 `Closes #N` 关闭对应 issue**。

四个 issue（原文要点）：
- **#10 终端打开链接**：终端内 URL 可点击，兼容常见 OS 键位（Mac Cmd+Click / Win·Linux Ctrl+Click）；评论补充：Agent 对话与文件预览的 Markdown 链接也应识别为超链接。
- **#11 theme 开关歧义**：短期不做多主题，仅把"theme 开关"文案改为"Dark Mode"开关。
- **#15 设置界面优化**：把现有 8 个 tab 重排为 4 个大 tab，仅前端/设计、不改后端、零功能退化。
- **#16 体验优化**：Sidebar 选中设备块背景对齐 agent-chat-input；设备管理页卡片边框淡化 + 顺序与侧边栏一致 + "连接"按钮减弱；添加/修改设备 Modal（SSH）强校验 + 默认值 + 认证默认 SSH Agent + 针对性现代化。

### 已确认的关键事实（勘探结论）

- **终端栈是自研 `packages/ghostty-terminal`**（`TERMINAL_ENGINE='ghostty-official'`，WASM 控制层 + 自定义 Canvas 渲染），**非 xterm**，且**当前零链接支持**。#10 的终端部分是真正的新功能，需在该包内自实现 LinkProvider。
- **Markdown 链接已工作**：`MarkdownPreview`（文件预览）与 `StreamingMarkdown`（Agent 消息）都已用 `remark-gfm` + 自定义 `<a>`（`target=_blank` + `rel=noopener noreferrer` + 超链接样式），`[text](url)` 与裸 URL（GFM autolink literals）应已渲染为可点击链接。#10 markdown 部分以**实测验证**为主，确认工作则不改。
- **#11 本质是纯文案**：`settings.theme` 控件已是二元明暗开关（`SettingsPage.tsx:99/128-132/462`），只需改 i18n 文案值。
- **i18n 是跨 issue 唯一热点**：源 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` → 生成物 `resources.ts`/`types.ts`（**禁止手改**，靠 `cd packages/shared && bun run build:i18n` 重建）。#11、#16、#15 都改它。

### 依赖关系与修复顺序

```
#11 (仅 i18n 文案)  ──┐
#10 (ghostty-terminal + Terminal.tsx，几乎不碰 i18n) ── 独立
#16 (sidebar-device-list + DevicesPage + i18n validation 键)
#15 (SettingsPage 大重构 + 新组件 + i18n tab 键；引用 settings.theme 但不改其逻辑)
```

- 代码层面四者文件**互不冲突**（#10 在 terminal 包；#16 在 device 文件；#15 在 settings 文件；#11 不碰 .tsx）。
- 唯一交叉是 **i18n 生成物**：在**单一分支顺序提交**，每个 commit 各自编辑 JSON 并跑 `build:i18n`，生成物累积无冲突。
- **执行顺序：#11 → #10 → #16 → #15**（先快速文案 → 独立终端 → 设备 → 最大的设置重构压轴）。

### 交付方式（已确认）

- 新建**单个 git worktree**（分支名建议 `feat/confirmed-issues-10-11-15-16`）。
- **4 个 commit**，每个对应一个 issue，commit message 末尾含 `Closes #N`。
- 全部完成后开**1 个 PR**（PR body 列出 `Closes #10`、`Closes #11`、`Closes #15`、`Closes #16`），合并后自动关闭全部。
- commit message 用简体中文 + conventional 前缀 + 脚注 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## 执行前置（先存档，再干活）

按 AGENTS.md：在 `prompt-archives/2026061400-confirmed-issues-fix/` 下创建 `plan-prompt.md`（存档本轮 prompt）与 `plan-00.md`（本计划副本）；完成后写 `plan-00-result.md`。

---

## 实施细节（按 commit 顺序）

### Commit 1 — `#11` Dark Mode 文案（`fix(fe): theme 开关文案改为 Dark Mode`）

纯 i18n，零逻辑改动。三个 locale 源 JSON 改 `settings.theme` 的**值**（**不动** `settings.themeLight`/`themeDark`，它们是侧边栏快捷切换的动作文案）：
- `en_US.json:164` `"theme": "Theme"` → `"Dark Mode"`
- `zh_CN.json:164` `"theme": "主题"` → `"深色模式"`
- `ja_JP.json:164` `"theme": "テーマ"` → `"ダークモード"`

然后 `cd packages/shared && bun run build:i18n` 重生成 `resources.ts`/`types.ts`，一并提交。

### Commit 2 — `#10` 终端链接 + markdown 验证（`feat(terminal): 终端 URL 可点击打开`）

**终端侧（核心，新功能，方案 A：在 ghostty-terminal 自实现 LinkProvider，零新增依赖）**

- 新增 `packages/ghostty-terminal/src/link-detector.ts`：纯函数 `detectLinksInLine(model)`，在 `SelectionLineModel.colChars` 拼出的可见文本上用 URL 正则（http/https，裁尾随标点 `.,;:)]}`）匹配，把字符索引映射回屏幕列区间；处理软换行（`wrappedToNext` 拼接相邻行）。**配单测**（参考 `selection-model.test.ts` 用 `lineModelFromText` 构造 model，覆盖 http/https、尾随标点、软换行、宽字符、无链接）。
- `packages/ghostty-terminal/src/terminal.ts`（`GhosttyTerminalController`）：
  - 新增 `onLinkActivated(cb)` 监听集合，镜像现有 `dataListeners`/`selectionListeners` 的 Set + `TerminalDisposable` 模式（~`:214`）。
  - `mousemove`（window 级，~`:845`）：未拖拽 + 带正确修饰键（`isMacPlatform()` 选 `metaKey`/`ctrlKey`，复用 `selection-clipboard.ts:1`）+ `hitTest`(`:1563`)→`getLineModel`(`:1587`)→`detectLinks` 命中 → `screenElement.style.cursor='pointer'` 并记录 hovered 区间；否则恢复 cursor。
  - `mousedown`（`:780`）：在 `button!==0` 判断前、**置于 mouseReporting 分支之后**插入：带修饰键且命中链接 → `emit onLinkActivated(url)` + `preventDefault()` + `return`（绝不进入 `beginPointerSelection`，不与文本选择/鼠标上报冲突）。
- `packages/ghostty-terminal/src/types.ts`：`CompatibleTerminalLike`(`:158`) 加**可选** `onLinkActivated?(cb): TerminalDisposable`（向后兼容，不破坏既有实现与 `terminal.canvas.test.ts` 快照）。
- `packages/ghostty-terminal/src/index.ts`：导出新增 link 相关类型。
- `apps/fe/src/components/terminal/Terminal.tsx`：在挂载 instance 的 useEffect（~`:495-529`）订阅 `instance.onLinkActivated?.((url)=>window.open(url,'_blank','noopener,noreferrer'))`，cleanup dispose。
- 悬停下划线高亮（CanvasRenderer）列为可选二期；MVP 仅 `cursor:pointer`。`file://` 列为可选，MVP 仅 http/https。

**Markdown 侧（验证为主）**：实测 Agent 对话与 `.md` 文件预览中 `[text](url)` 与裸 URL 是否已渲染为可点击 `<a>`。若已工作（预期如此）则不改；若实测发现裸 URL 未识别，再做最小修复。**本 commit 尽量不碰 `locales/*.json`**，避免与其它 i18n commit 交叉。

### Commit 3 — `#16` 体验优化（`feat(fe): 设备体验优化与 Modal 强校验`）

1. **Sidebar 背景对齐**：`components/page-layouts/components/sidebar-device-list.tsx:796` 选中态 `isSelected ? 'bg-card'` → `'bg-chat-surface'`（`bg-chat-surface` token 见 `index.css:90/144/179`，与 `agent-tab.tsx:80` 输入区一致，明暗自适应）。仅改选中态，连接/未连接态、边框、左侧高亮条不动。
2. **设备卡片边框淡化**：`pages/DevicesPage.tsx:354` `<Card className="overflow-hidden">` 追加 `border-border/50`（沿用侧边栏 `border-border/60` 淡化手法），只影响 DeviceCard。
3. **卡片顺序与侧边栏一致**：`DevicesPage.tsx` 顶部 `import { toBCP47 } from '@tmex/shared'`、`import { useSiteStore } from '@/stores/site'`；组件内 `const language = useSiteStore((s)=>s.settings?.language ?? 'en_US')`；把 `:232` `const devices = data?.devices ?? []` 改为 `useMemo` 排序，逻辑与 `sidebar-device-list.tsx:456-464` 完全一致（`a.sortOrder-b.sortOrder || a.name.localeCompare(b.name, toBCP47(language), {numeric:true, sensitivity:'base'})`）。
4. **"连接"按钮减弱**：`DevicesPage.tsx:435` `buttonVariants({variant:'default',size:'sm'})` → `variant:'outline'`，保持 size/位置/testid。
5. **Modal 强校验 + 预填默认值 + 认证默认 SSH Agent + 针对性现代化**（`DevicesPage.tsx` 的 `createDefaultFormValues`、`buildCreatePayload`、`buildUpdatePayload`、`DeviceDialog`）：
   - **认证默认 SSH Agent**：`createDefaultFormValues(无 device)` 仍 `type='local'`/`authMode='auto'`；改 type 切换分支（`:602-607`）把 `d.authMode==='auto' ? 'password'` → `'agent'`，使新建 SSH 设备默认 SSH Agent。
   - **预填默认值**（按用户决策：创建也强校验，但把 placeholder 内容预填好）：`createDefaultFormValues` 把 `username` 预填 `'root'`（=`usernamePlaceholder`）、`sshConfigRef` 预填 `'~/.ssh/config'`（=现硬编码 placeholder）、`port` 维持 `22`。**host 不预填**（`example.com` 仅作占位提示），保持空 + 必填。
   - **强校验（创建 + 编辑都生效）**：新增 `validate(values, mode)` 返回 `null | i18nKey`：name 必填；`type==='ssh'` 时 host / port(>0) / username / sshConfigRef 必填。`handleSubmit`(`:512`) 在 `e.preventDefault()` 后先 `const err=validate(formData,mode); if(err){toast.error(t(err)); return;}` 再 mutate（复用现有 toast 链 + WatchRuleForm 的 validate 模式）。
   - **字段标记**：host/username/sshConfigRef 的 `fieldLabel(...true)` 加红星；Input 加 `aria-invalid`（`ui/input.tsx` 已内置 `aria-invalid:ring-destructive`）。
   - **显式传默认值给后端**：因字段已校验非空，`buildCreatePayload`/`buildUpdatePayload` 的 SSH 分支直接 `host: values.host.trim()`、`port: values.port`、`username: values.username.trim()`、`sshConfigRef: values.sshConfigRef.trim()`（不再 `normalizeText`→undefined），让后端拿到具体值。
   - **针对性现代化（保留分区结构）**：保留 基础/连接/认证 三 section；落实上面校验/红星/默认；移动端把滚动容器（`:575`）`max-h-[min(70vh,720px)]` → `max-h-[min(70dvh,720px)]` 适配虚拟键盘动态视口；硬编码 `'SSH Config'`（`:548`、`:687/725`）改为 `t('device.authConfigRef')`。不大改布局。
   - **i18n 新增键**：三语 `device.validation.usernameRequired`、`device.validation.sshConfigRequired`、（可选 `portRequired`）；`hostRequired` 已存在。改后 `build:i18n`。

### Commit 4 — `#15` 设置界面重排（`refactor(fe): 设置界面重排为 4 大 Tab`）

**仅前端 + 设计，不改任何 API/数据流/query key/mutation，零功能退化（硬约束）。**

把 `pages/SettingsPage.tsx` 现有 8 个分支（site/notifications/telegram/webhooks/llm/search/files/version）重排为 4 个大 tab，并把 tab 控件从 `Button` 改为 `Tabs/TabsList/TabsTrigger`（复用 sidebar 样式）：

- **通用设置 general**：站点信息卡片（siteName/siteUrl/language + theme 开关，含 refreshToApply 提示）+ `VersionTab`。
- **设备与文件 devicesAndFiles**：新增"设备管理入口卡片"（`Link` 到 `/devices`，复用 `buttonVariants`）+ `FilesSettingsTab`。
- **通知设置 notifications**：通知开关与数值"无标题卡片"（去 CardHeader）+ Telegram Bot（**重构为列表 View + 独立 Modal**，对标 LLM Provider）+ Webhook。
- **AI 设置 ai**：`LlmProvidersTab`（含默认模型 Defaults）+ `SearchTab`，并在 Search 加一句提示（兼容 OpenAI Responses API hosted 搜索 tool）。

具体步骤（**先纯搬迁、再现代化、分步验证**）：
1. **安全搬迁**（无功能变化）：把 webhook 分支抽到新 `components/settings/webhooks-tab.tsx`（连同 `WEBHOOK_EVENT_OPTIONS`）；把 telegram 分支（含 `BotCard`/`ChatRow`）抽到 telegram 四件套。保持渲染与所有 `data-testid` 不变。
2. **Telegram 现代化**（对标 `llm-providers-tab.tsx`/`llm-provider-row.tsx`/`llm-provider-form-modal.tsx`）：新建 `telegram-bots-tab.tsx`（列表 + Add 按钮 + Modal 控制 + `botsQuery`/`createBotMutation`）、`telegram-bot-row.tsx`（行：名称/统计 + enabled Switch + 展开 chats + Edit/Delete）、`telegram-bot-form-modal.tsx`（Add/Edit 合一，字段 name/token/enabled/allowAuthRequests，token 在 Add 必填 Edit 可选）、`telegram-bot-chats.tsx`（pending/authorized + approve/reject/test/delete）。所有 fetch URL、query key、mutation 逐一搬迁不改；行级 `telegram-bot-*` testid 保持原值。
3. **tab 重排**：`activeTab` 联合类型改为 4 值（默认 `'general'`）；按上面装配各 tab；底部 Save 显示条件 `(site||notifications)` → `(general||notifications)`。**站点 + 通知的 useState 仍统一留在 SettingsPage 作用域**（`saveSiteMutation` 整包提交，state 不可下沉到子组件，否则跨 tab 提交丢值）。
4. **tab 样式**：`export` `app-sidebar.tsx:16-17` 的 `tabTriggerClassName`（或抽到共享文件），`TabsList` 复用 `w-full p-1 rounded-xl border border-border/60`；4 个 tab 各配 lucide 图标；新增 `settings-tab-general/devicesAndFiles/notifications/ai` testid。
5. **通知无标题卡片**：去 notifications 分支的 CardHeader/CardTitle，仅留 4 个 Switch 行 + 4 个数值 Input grid。
6. **AI 提示 + 设备入口卡片**：`search-tab.tsx` 加 `settings.search.responsesApiHint` 文案；新建设备管理入口卡片。
7. **i18n**：三语新增 `settings.tabGroup.{general,devicesAndFiles,notifications,ai}`、`settings.deviceManagement.{title,description,openButton}`、`settings.search.responsesApiHint`，`build:i18n`。
8. **零退化核对**：逐项对照 8 大块功能清单确认全部可达。

**关键风险**：旧 `settings-tab-{site,notifications,telegram,webhooks,llm,search,files,version}` testid 会消失——全仓 `grep settings-tab-` 同步更新测试引用；`telegram-bot-*`/`webhook-*` 行级 testid 在搬迁后必须保持原值。

---

## 复用清单（避免新写）

- `bg-chat-surface`（`index.css`，`agent-tab.tsx:80` 已用）；`tabTriggerClassName` + `TabsList` 容器类（`app-sidebar.tsx`）。
- 设备排序：`sidebar-device-list.tsx:456-464`；`toBCP47`(@tmex/shared)、`useSiteStore`。
- 列表+Modal 三件套范本：`llm-providers-tab.tsx`/`llm-provider-row.tsx`/`llm-provider-form-modal.tsx`。
- 校验模式：`watch-rule-form.tsx` 的 `validate()`、`DevicesPage` 现有 `handleSubmit`/toast；`ui/input.tsx` 内置 `aria-invalid` 样式。
- 终端：`hitTest`/`getLineModel`/`SelectionLineModel.colChars`/`isMacPlatform()`/`dataListeners` Set 模式/`FitAddon` addon 形态（全在 ghostty-terminal）。
- i18n 流水线：改 `locales/*.json` 后 `cd packages/shared && bun run build:i18n`，**禁止手改 resources.ts/types.ts**，三语 key 同构。

---

## 验收标准（Verification）

**通用**：每个 i18n 改动后 `cd packages/shared && bun run build:i18n` 无报错；`apps/fe` 跑既有 typecheck/lint（注意 **不要对生成文件 lint**）；`packages/ghostty-terminal` 跑 `bun test`（含新 link-detector 单测）。

- **#11**：Settings → 通用设置，主题开关英文显示 "Dark Mode"、中文"深色模式"、日文"ダークモード"；拨动仍正常明暗切换 + 刷新保持；侧边栏快捷切换文案未受影响；`settings-theme-toggle` testid 不变。
- **#10**：终端输出含 https URL → Mac Cmd 悬停光标变 pointer、Cmd+Click 新标签打开；无修饰键点击仍能选择文本；Cmd/Ctrl+C 复制不回归；鼠标上报应用（vim/htop 鼠标）下不误触发；非 Mac 用 Ctrl。Agent 对话与 `.md` 预览的链接实测可点击。
- **#16**：明暗下选中设备块背景与 Agent Tab 输入区一致；设备页卡片边框更淡、顺序与侧边栏 Panes Tab 一致、连接按钮权重降低；新建 SSH 设备默认认证为 SSH Agent、username 预填 root、sshConfig 预填 ~/.ssh/config；host 留空提交报错并标红星；编辑/创建 username/sshConfig 清空提交报错；移动端 Modal + 软键盘可滚动不溢出；local 设备不被 SSH 校验误伤。
- **#15**：四个 tab 触发器观感与 sidebar 一致；逐项核对零退化（站点/语言/主题 + 版本更新；设备入口跳转 + 文件白名单；4 通知开关 + 4 数值 + Save + Telegram 全流程 + Webhook；LLM Provider 全操作 + 默认模型 + Search + 新提示）；全仓 `grep settings-tab-` 测试引用已同步。

**环境约束（重要）**：严禁触碰本机生产 tmex（9883/launchd/安装目录）。需起服务验证时在仓库内起临时实例并显式覆盖 `GATEWAY_PORT`/`TMEX_FE_DIST_DIR`/`TMEX_BIND_HOST` 等（e2e 用 9885/9665）。FE 手测走 vite dev。可用 `webapp-testing` 跑设置/设备/终端关键路径。

---

## 风险

- **#10 终端**改动在 mousedown 链条插入要严格排在 mouseReporting 分支之后、且仅修饰键命中时拦截，否则破坏选择/鼠标上报；`onLinkActivated` 设为可选属性以不破坏既有实现与 canvas 快照。
- **#15 零退化**是最大风险：先纯搬迁再现代化、分步验证；保持 site+notification state 在 SettingsPage 同作用域；testid 迁移需同步测试。
- **i18n 生成物**：单分支顺序提交、每 commit 各自 rebuild，避免 resources.ts 冲突；新 key 必须先进 en_US 基准且三语同构。
- **#16 后端语义**：现 `CreateDeviceRequest` host/port/username/sshConfigRef 均 optional，本次仅改前端发送具体值，不动后端契约；若后端对空值有特殊处理，实测时确认。
