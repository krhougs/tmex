# Task 10 结果 — Watch 监控前端 UI

## 实现内容

### 1. WatchDialog（apps/fe/src/components/watch/）

- `api.ts`：watch REST 封装（rules CRUD / state / assist-regex）+ query key 约定
  `['watch-rules', deviceId, paneId]`、`['watch-rule-state', ruleId]`。
- `watch-dialog.tsx`：单 dialog 内 list / form / state 三视图切换。
  - 规则列表：name + 类型 Badge + 启停 Switch（PATCH enabled）+ 状态/编辑/删除按钮 +
    最近触发时间（每行独立查 `:id/state`）；删除走 AlertDialog 确认。
  - 状态视图：state 全字段（lastValue/lastValueChangedAt/consecutiveErrors/lastError 等）+
    近期样本列表（倒序、hit Badge），5s 轮询。
  - 通知权限 banner：首次创建规则成功（用户手势链内）且 `Notification.permission === 'default'`
    时显示，可一键 `requestPermission()`。
- `watch-rule-form.tsx`：
  - triggerType 三选卡片（match/unchanged/llm 带说明文案），切换时按 min（5/30）自适应
    intervalSeconds；
  - match/unchanged：pattern + flags + NL 辅助（描述 + Sparkles → assist-regex 回填
    pattern/flags/extractGroup，显示 explanation 与 preview 命中列表，可改）；
  - unchanged 增 extractGroup/unchangedMinutes/noMatchBehavior；llm 为 conditionPrompt textarea；
  - 模型选择：provider Select（含"跟随全局默认"=null）+ model Input+datalist 级联
    （沿用 LlmDefaultsCard 先例）；llm 型或开 confirm/summarize 时显示高亮提示；
  - confirmWithLlm / summarizeWithLlm Switch 仅 match/unchanged 显示；
  - fireMode once/repeat + repeat 时 cooldownSeconds；
  - 前端校验与后端一致：name/pattern/conditionPrompt 必填、`new RegExp` 试编译
    （剔除 g flag，与服务端 compileWatchPattern 一致）、unchangedMinutes>0、interval min，
    错误 toast。

### 2. 入口

- DevicePage PageActions：Radar icon 按钮（`watch-open-button`），该 pane 存在启用规则时
  primary 色角标（`watch-active-indicator`）；deviceId/paneId 取自路由（paneId 经
  decodePaneIdFromUrlParam）。
- sidebar pane 行：新增 DropdownMenu（EllipsisVertical，`pane-menu-{id}`），含"监控此终端"
  （`pane-watch-{id}`）；保留原 close 按钮与其 testid 不变，pane 行 padding-right 相应加大。

### 3. watch 事件通知（watch-events-init.tsx，挂 RootLayout）

- 仿 stores/tmux.ts：模块级 initialized 防重 + `client.onMessage` 过滤
  `KIND_WATCH_EVENT`，borsh 解 WatchEventSchema + JSON payload。
- TRIGGERED：toast（标题=规则名：先查 react-query 缓存，miss 时 GET /api/watch/rules/:id，
  再 miss 回退通用标题；正文=summary||matchedText；action"打开终端"跳
  `/devices/:id/windows/:wid/panes/:pid`，windowId 缺失时从 tmux snapshot 反查）+
  浏览器 Notification（granted 时，onclick 跳转）。
- MODEL_UNAVAILABLE：warning toast（message 已含规则名 + 降级提示文案）。
- RULE_ERROR：error toast（message 已含规则名与停用说明）。
- 所有事件失效 `['watch-rules']` 与 `['watch-rule-state', ruleId]`。

### 4. i18n

- 三语 locale 源 json（en_US/zh_CN/ja_JP）新增 `watch.*` 全套键，`bun run build:i18n`
  重建 resources.ts/types.ts（未手改生成物）。

### 5. e2e（apps/fe/tests/watch.spec.ts）

真后端（仿 agent-session.spec.ts：tmux session + POST /api/devices 造 local device）：
1. dialog 打开 → 创建 match 规则（pattern 直填）→ 列表显示 → 角标出现 → 启停 Switch
   （aria-checked 断言 + 角标消失）→ 删除（AlertDialog 确认）→ 列表空；
2. assist-regex 用 page.route mock：断言 pattern/flags 回填 + explanation/preview 显示；
3. 真实触发链路：REST 创建 5s 采样 match 规则 → tmux send-keys echo token →
   断言带规则名的 sonner toast（无 mock）。

## 验证结果

- `apps/fe` tsc --noEmit：零错误。
- biome：新增/接线文件全部干净；`sidebar-device-list.tsx:462`（useKeyWithClickEvents）与
  `DevicePage.tsx:426`（useExhaustiveDependencies）为 HEAD 即有的基线问题，未触碰。
- gateway tsc 错误数改动前后一致（25 行，全在既有测试文件），与本任务无关。
- e2e：watch.spec.ts 3 用例 `--repeat-each=3` 9/9 通过；回归
  sidebar-close-confirm / sidebar-rename / sidebar-click-no-pty-injection / sidebar-resize /
  terminal-ui / devices / mobile-nav / mobile-sidebar-safe-area 全过；
  sidebar-delete 失败为记忆中已记录的既有基线失败（device-delete testid 在
  Sidebar.tsx 旧组件中，与本次改动无关）。

## 变更文件

- 新增：`apps/fe/src/components/watch/{api.ts,watch-dialog.tsx,watch-rule-form.tsx,watch-events-init.tsx}`、
  `apps/fe/tests/watch.spec.ts`
- 修改：`apps/fe/src/pages/DevicePage.tsx`、
  `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`、
  `apps/fe/src/main.tsx`、`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`、
  `packages/shared/src/i18n/{resources,types}.ts`（生成）

## Commits

- `0698d4c` feat(fe): watch rule dialog with list/form/state views and pane entries
- `628b739` feat(fe): watch event notifications via WATCH_EVENT websocket
- `165519d` test(e2e): watch rules dialog CRUD, mocked assist-regex and real trigger toast

## 遗留问题

- 列表行最近触发时间为每条规则各发一次 state 请求；规则数大时可考虑后端列表接口附带
  state（当前 pane 级规则数小，影响可忽略）。
- TRIGGERED toast 跳转沿用 bell 先例 `window.location.href`（整页跳转），未走 SPA navigate。
- 浏览器 Notification 在未注册 SW 的移动端构造可能抛错，已 try/catch 静默降级为 toast。
