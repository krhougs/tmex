# Task 6 Prompt：Watch 屏幕监控服务

你在 /Users/krhougs/LocalCodes/tmex 仓库的 feature/terminal-agent-watch 分支上实现 Task 6（共 11 个任务的第 6 个）：Watch 屏幕监控服务。用简体中文沟通。一次性完成，禁止留 TODO。

## 项目背景与已就绪设施（先读）

tmex 加"Watch 监控"：用户对某 tmux pane 加规则，服务端周期采样屏幕判断条件，触发后走通知。与 agent session 无关的独立功能。

可用设施：
- **DB**：`apps/gateway/src/db/watch.ts`（rule CRUD、getEnabledWatchRules、listWatchRulesByDevice、state 读/upsertWatchRuleState）；schema：watch_rules（triggerType 'match'|'unchanged'|'llm'、pattern/patternFlags/extractGroup、conditionPrompt、providerId/modelId（per-rule 模型，空=全局默认）、confirmWithLlm、summarizeWithLlm、intervalSeconds、unchangedMinutes、noMatchBehavior 'reset'|'ignore'、fireMode 'once'|'repeat'、cooldownSeconds）+ watch_rule_state（lastValue/lastValueChangedAt/triggeredSinceChange/lastTriggeredAt/consecutiveErrors/lastError/modelUnavailableNotified）
- **tmux**：`DeviceSessionRuntime.capturePaneText(paneId)`；连接走 `tmuxRuntimeRegistry.acquire/release(deviceId)`（引用计数）
- **LLM**：`resolveLanguageModel(providerId|null, modelId|null)`（apps/gateway/src/llm/provider-registry.ts）；AI SDK v6 的 `generateObject`（zod schema）可用
- **通知**：`eventNotifier.notify(eventType, event)`——EventType 已有 watch_triggered/watch_model_unavailable；event 形状看现有调用（含 device/tmux 上下文；参考 bell 通知与 agent 通知怎么构造 paneUrl）
- **WS**：`agentWsHub.broadcastWatchEvent(...)` 泛型签名（WATCH_EVENT_TRIGGERED/MODEL_UNAVAILABLE/RULE_ERROR 常量与 payload 类型在 @tmex/shared 的 WatchEventPayloadMap）
- **REST 惯例**：api/llm.ts、api/agent.ts（readJsonObjectBody、i18n 错误 key、接线 api/index.ts）
- **后台服务范式**：push/supervisor.ts；启动接线 runtime.ts

**前置债务（必须先做）**：`capturePaneText` 走 runTmux 的 allowTargetMissing=false 路径，pane 不存在时 local 连接会触发 connectionAlertNotifier（console.error + 前端 error 广播 + runtime status 写错误态）、ssh 连接会把 tmuxAvailable 置 false——watch 周期采样一个已关闭的 pane 会每周期制造一次告警噪声。给 runTmux 加"target missing 时抛错但不告警不污染状态"的形态（local-external-connection.ts 已有 isRecoverableTargetMissingError 类判断可复用——读代码确认实际函数名），让 capturePaneText 走这个形态。Agent 的 read_screen 同样受益。补测试。

**红线**：严禁触碰生产 tmex；测试 `bun run test`；LLM 一律 mock（generateObject 对 mock server 的用法参考 ai-sdk.spike.test.ts 与 provider-registry.test.ts）；tmux 用注入 stub。

## 任务内容

### 1. evaluator.ts（apps/gateway/src/watch/evaluator.ts，纯函数，先写单测）

```ts
interface EvalInput { screen: string; rule: WatchRuleRecord; state: WatchRuleStateRecord | null; now: Date }
interface EvalOutput { stateUpdates: Partial<...>; hit: boolean; matchedText?: string; value?: string }
```
- 正则取屏幕上**最后一个**命中（进度行常在底部）；`new RegExp(pattern, flags+'g')` 注意 flags 去重；pattern 编译失败 → 规则错误（不是 hit）
- `match` 型：命中即 hit
- `unchanged` 型：value=match[extractGroup]；无命中按 noMatchBehavior——reset 清空 lastValue/lastValueChangedAt（任务结束停止计时）/ ignore 保持不动；value 变化 → 更新 lastValue/lastValueChangedAt、triggeredSinceChange=false；value 不变且 now-lastValueChangedAt ≥ unchangedMinutes 分钟 → hit
- hit 后的触发闸门（两型通用）：fireMode 'once' → triggeredSinceChange（unchanged）或触发后置 enabled=false（match，由 service 做）；'repeat' → now-lastTriggeredAt ≥ cooldownSeconds
- `llm` 型不在 evaluator（service 编排）
- 单测覆盖：match 基本/multi-match 取最后/flags 处理/无效 pattern；unchanged 全分支（值变化重置、不变达阈值 hit、reset/ignore、once 防重、repeat cooldown）；时间用注入 now

### 2. service.ts（WatchService 单例）

- start()/stop() 接入 runtime.ts（pushSupervisor 旁）；启动加载 enabled 规则
- 按 deviceId 分组 acquire 连接（引用计数；**该设备最后一条规则停用/删除时 release**）；每规则独立 interval timer（max(5, intervalSeconds)，llm 型 max(30, …)）
- 每 tick：capturePaneText → 按 triggerType 处理：
  - match/unchanged：evaluator 判定 → hit 且过闸门 → 可选 confirmWithLlm（generateObject {confirmed:boolean, reason}，**模型不可用 fail-open：直接触发并在通知文案标注未经确认**）→ 可选 summarizeWithLlm（generateObject {summary}，失败降级原始匹配文本）→ 触发
  - llm 型：generateObject({matched:boolean, reason}) 以 conditionPrompt+屏幕做输入 → matched 且过闸门 → 触发。模型调用失败计 consecutiveErrors
  - 触发动作：notify('watch_triggered', {…ruleName/value/matchedText/stuckMinutes/summary}) + broadcastWatchEvent(TRIGGERED) + 更新 state（lastTriggeredAt/triggeredSinceChange）+ match+once 置 enabled=false
- **模型不可用告警只发一次**（用户明确要求）：任何 LLM 调用失败且 state.modelUnavailableNotified=false → notify('watch_model_unavailable') + broadcastWatchEvent(MODEL_UNAVAILABLE) + 置 true；任一次成功 → 重置 false。注意 fail-open/降级路径同样适用此告警
- capture 失败（pane 没了/设备断）：consecutiveErrors+1 + lastError；达阈值 10 → 规则自动停用（enabled=false）+ broadcastWatchEvent(RULE_ERROR) + notify 一次（复用 rule_error 语义……EventType 没有 watch_rule_error，就用 watch_model_unavailable 之外的方式——评估：加一个 EventType 'watch_rule_error' + emojiMap + 三语 i18n 更干净，照做）；capture 成功重置 consecutiveErrors
- 规则 CRUD 后热更新：`refreshRule(ruleId)`（重建 timer/连接分组）、`removeRule(ruleId)`
- 每 tick 后 upsert state 一行；内存 ring buffer（Map<ruleId, Array<{at, value, hit}>> 上限 120）供 REST state 接口返回近期样本
- 单测：注入 stub runtime（capturePaneText 可控返回序列）+ mock LLM server + 假 timer 或可注入 tick 驱动（参考 push/supervisor 测试怎么处理定时；不行就把 tick 逻辑暴露成可直接调用的方法测）覆盖：unchanged 卡住触发全链路、fail-open、摘要降级、告警只发一次+恢复重置、连续错误自动停用、once/repeat/cooldown、热更新

### 3. REST（api/watch.ts + 接线）

```
GET    /api/watch/rules?deviceId=&paneId=
POST   /api/watch/rules            校验：triggerType 枚举；match/unchanged 必须有合法 pattern（试编译）；unchanged 必须有 unchangedMinutes>0 与 extractGroup>=0；llm 必须有 conditionPrompt；intervalSeconds 下限；providerId 存在性
GET    /api/watch/rules/:id        含 state
PATCH  /api/watch/rules/:id        含 enabled 启停 → service.refreshRule
DELETE /api/watch/rules/:id        → service.removeRule
GET    /api/watch/rules/:id/state  state + ring buffer 样本
POST   /api/watch/assist-regex     {description, deviceId?, paneId?} → 用全局默认模型（或 body 可带 providerId/modelId）generateObject({pattern, flags, extractGroup, explanation})；带 pane 时先 capturePaneText 取屏幕做上下文；返回前服务端 new RegExp 试编译 + 在屏幕样本上试跑给 preview（命中数组）；模型不可用 → 502 + 明确错误
```
DTO 进 shared、i18n 三语 + build:i18n、REST 测试。

### 4. 收尾
全量 bun run test、tsc 无新增、独立 commit（建议拆：runTmux 静默形态、evaluator、service、REST）。

## 开始前
有疑问先问；设施与描述不符以代码为准并汇报。

## 自查后汇报
实现内容、测试结果、变更文件、与描述不符处、遗留问题。
