# Task 10 Prompt — Watch 监控前端 UI

你在 /Users/krhougs/LocalCodes/tmex 仓库的 feature/terminal-agent-watch 分支上实现 Task 10（共 11 个任务的第 10 个）：Watch 监控前端 UI。用简体中文沟通。一次性完成。

## 项目背景与已就绪设施（先读）

- **后端 REST**（apps/gateway/src/api/watch.ts）：GET /api/watch/rules?deviceId=&paneId=、POST /api/watch/rules、GET/PATCH/DELETE /api/watch/rules/:id、GET :id/state（state+近期样本）、POST /api/watch/assist-regex {description, deviceId?, paneId?, providerId?, modelId?} → {pattern, flags, extractGroup, explanation, preview}。规则字段：triggerType 'match'|'unchanged'|'llm'、pattern/patternFlags/extractGroup、conditionPrompt、providerId/modelId（空=全局默认）、confirmWithLlm/summarizeWithLlm、intervalSeconds（下限 5/llm 30）、unchangedMinutes、noMatchBehavior、fireMode 'once'|'repeat'、cooldownSeconds、enabled。DTO 在 @tmex/shared（读确认实际名）
- **WS**：KIND_WATCH_EVENT 广播给所有客户端（shared 的 WATCH_EVENT_TRIGGERED/MODEL_UNAVAILABLE/RULE_ERROR + WatchTriggeredPayload 等 payload 类型）；前端 client.onMessage 注册（仿 stores/tmux.ts）
- **providers 列表**：GET /api/llm/providers（modelsCache 做模型选项）
- **入口位置**：apps/fe/src/pages/DevicePage.tsx 的 PageActions 区域（读组件找现有 icon 按钮组）；apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx pane 行 DropdownMenu
- **UI 组件**：components/ui/（dialog、tabs、switch、select、badge、alert-dialog 等都有）；react-query + parseApiError 惯例；sonner toast（bell toast 模式看 stores/tmux.ts 约 :358-368——带跳转 action）
- **通知权限**：浏览器 Notification API——权限申请必须在用户手势内
- i18n 三语 + build:i18n；e2e tests/（9885/9665）

**红线**：严禁触碰生产；e2e 显式 TMEX_E2E_*；dev 注意 NODE_ENV。

## 任务内容

### 1. WatchDialog（components/watch/watch-dialog.tsx + 子组件）

- 入口①：DevicePage PageActions 加 Radar（lucide）icon 按钮 → 打开 dialog，上下文 deviceId/paneId 取当前路由 useParams；**该 pane 有启用规则时按钮带 primary 色角标**（查规则列表）
- 入口②：sidebar pane 行 DropdownMenu 加"监控此终端"项 → 同 dialog 传对应 pane
- Dialog 内三段（tabs 或分段）：
  - **规则列表**：name/类型 Badge/启停 Switch（PATCH enabled）/编辑/删除（AlertDialog 确认）/最近触发时间（state.lastTriggeredAt）
  - **新建/编辑表单**（watch-rule-form.tsx）：name；triggerType 三选（match/unchanged/llm 带说明文案）；match/unchanged → pattern+flags 输入 + **NL 辅助**（描述输入 + Sparkles 按钮 → assist-regex → 回填 pattern/flags/extractGroup + 显示 explanation 和 preview 命中列表，用户可改）；unchanged 增 extractGroup+unchangedMinutes+noMatchBehavior；llm → conditionPrompt textarea；通用：模型 Select（provider+model 级联，默认"跟随全局默认"=null；llm 型或开启 confirm/summarize 时高亮提示需可用模型）；confirmWithLlm/summarizeWithLlm Switch（match/unchanged 才显示）；intervalSeconds（按类型 min 5/30）；fireMode once/repeat + repeat 时 cooldownSeconds
  - **状态/历史**：选中规则显示 state（lastValue/lastValueChangedAt/consecutiveErrors/lastError）+ 近期样本（GET :id/state 的样本数组简单列表即可，不用图表）
- 校验跟后端一致（前端先验：pattern 试编译 new RegExp、必填项），错误 toast

### 2. watch 事件通知（components/watch/watch-events-init.tsx，挂 RootLayout）

- client.onMessage 处理 KIND_WATCH_EVENT（initialized 防重，仿 stores/tmux.ts）：
  - TRIGGERED → sonner toast（标题=规则名，正文=summary||matchedText||value，action"打开终端"跳 pane 路由——payload 有 deviceId/paneId，路由构造看 tmux store bell 怎么跳）+ 浏览器 Notification（granted 时）
  - MODEL_UNAVAILABLE → warning toast（规则名+模型不可用+已降级提示）
  - RULE_ERROR → error toast（规则名+已自动停用提示）
- 同时 invalidate 相关 react-query（['watch-rules', ...]）
- **权限引导**：WatchDialog 内首次创建规则成功时（用户手势链内）若 Notification.permission==='default' 弹一个小 banner/按钮请求权限（不强制）

### 3. i18n 三语（watch.*）+ build:i18n

### 4. e2e（tests/watch.spec.ts）

- 真后端（e2e 基建起的 gateway）：开 dialog（DevicePage 需要 device——看现有 device 相关 e2e 怎么造测试设备/会话，沿用；造不了 device 的话用 sidebar 入口或 mock /api/watch 路由测 UI 交互，看现有 spec 的取舍惯例）：创建 match 规则（pattern 直填）→ 列表显示/启停/删除；assist-regex 用 page.route mock 响应（不依赖真 LLM）回填表单断言；WS 触发 toast 可用 mock 或跳过说明
- 回归相关现有 spec

### 5. tsc 零错误、biome 过检、独立 commit（可拆 UI/事件/e2e）
