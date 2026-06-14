# 执行结果 — 修复 4 个 confirmed issue（#10/#11/#15/#16）

## 交付

- 分支：`worktree-feat+confirmed-issues-10-11-15-16`（worktree）
- PR：https://github.com/krhougs/tmex/pull/19（body 含 `Closes #10/#11/#15/#16`，合并后自动关闭）
- commit 序列（每 issue 一个，末尾含 `Closes #N`）：
  1. `chore(prompt-archives)` 存档
  2. `fix(fe)` Closes #11 — Dark Mode 文案
  3. `feat(terminal)` Closes #10 — 终端 URL 可点击
  4. `feat(fe)` Closes #16 — 设备体验 + SSH Modal 强校验
  5. `refactor(fe)` Closes #15 — 设置界面重排 4 大 Tab

## 各 issue 落地

### #11 Dark Mode 文案
纯 i18n：三语 `settings.theme` 值改为 Dark Mode/深色模式/ダークモード；`build:i18n` 重建。未动控件/逻辑，保留 `themeLight`/`themeDark`（侧边栏动作文案）。

### #10 终端链接
`ghostty-terminal` 自实现 LinkProvider（零新增依赖）：
- 新增 `link-detector.ts`（`detectLinksInLine` / `detectLinksInWrappedLines`）：colChars→可见文本，识别 http/https，裁末尾句读，处理宽字符列与软换行跨行；配 8 项单测。
- `terminal.ts`：`onLinkActivated` 监听集合；mousedown 在 mouseReporting 分支后插入「修饰键+命中=emit+preventDefault」；selectSurface mousemove 做 hover→cursor:pointer。
- `selection-clipboard.ts` 抽 `hasPlatformModifier`（Mac Cmd / 其它 Ctrl）。
- `types.ts` 加可选 `onLinkActivated`；`index.ts` 导出类型；`Terminal.tsx` 订阅→`window.open(_blank, noopener)`。
- Markdown 侧：`StreamingMarkdown` / `MarkdownPreview` 经 remark-gfm + 自定义 `<a>` 已渲染超链接，实测确认，未改。

### #16 设备体验 + Modal
- `sidebar-device-list.tsx:796` 选中态 `bg-card`→`bg-chat-surface`。
- `DevicesPage.tsx`：卡片 `border-border/50`；`useMemo` 排序（sortOrder + `toBCP47(language)` localeCompare）；连接按钮 `outline`。
- DeviceDialog：`validateDeviceForm`（host/port/username/sshConfig 创建+编辑必填，i18n key 在 **`validation.*`** 顶层，非 device.validation）；创建预填 username=root / sshConfig=~/.ssh/config；type 切 SSH 默认 authMode='agent'；payload 显式发送具体值；红星 + aria-invalid；`max-h` 改 `dvh`；硬编码 'SSH Config'→`t('device.authConfigRef')`。
- 三语新增 `validation.{portRequired,usernameRequired,sshConfigRequired}`。

### #15 设置界面重排
- `SettingsPage.tsx` 8 tab→4 大 tab（general/devicesAndFiles/notifications/ai），tab 控件改 `Tabs/TabsList/TabsTrigger`，复用 `app-sidebar` 导出的 `tabTriggerClassName`。
- Telegram 重构为列表+独立 Modal：新增 `telegram-bots-tab` / `telegram-bot-row` / `telegram-bot-form-modal` / `telegram-bot-chats-modal`；Webhook 抽 `webhooks-tab`；新增 `device-entry-card`。
- `search-tab` 加 Responses API hosted 搜索提示。
- 站点+通知 state 仍统一在 SettingsPage 作用域（整包 saveSiteMutation）。
- 三语新增 `settings.tabGroup.*` / `settings.deviceManagement.*` / `settings.search.responsesApiHint` / `telegram.editBot`。
- e2e specs 迁移到新 tab testid 与 Telegram Modal 流程。

## 验证

- `apps/fe` `tsc --noEmit`：0 错误。
- `packages/ghostty-terminal` `bun test`：57 通过（含新 link-detector 8 项）。
- `packages/shared` `build:i18n`：成功，三语同构。
- biome：新文件全部 clean；改动文件未新增错误（既有格式债不动）。
- e2e（隔离端口 9885/9665，NODE_ENV=test 守卫）：`settings.spec.ts`、`mobile-settings.spec.ts`、`settings-llm.spec.ts` 全部通过。
- #16 设备 Modal：临时 e2e 实测 SSH Agent 默认 + 预填 + host 必填校验（toast + aria-invalid），通过后删除临时用例。
- gateway tsc 17 错误为既有（HEAD 基线相同，与本次无关）。

## 注意事项

- 设置页旧 tab testid（settings-tab-{site,telegram,webhooks,llm,search,...}）已被 4 个新 testid 取代，相关 e2e 已同步；后续若新增设置 e2e 用新结构。
- #16 校验文案 key 在顶层 `translation.validation.*`（不是 `device.validation`），易踩坑。
- 全程未触碰本机生产 tmex（9883/launchd/安装目录），验证只在 worktree 内起隔离 test 实例。
