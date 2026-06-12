# Task 6 执行结果：Watch 屏幕监控服务

完成于 2026-06-13，4 个 commit（7aa6764 / 2825bd9 / 1799b5b / 2be3d39）。

## 交付内容

### 前置债务：runTmux target-missing 静默形态（7aa6764）
- 新增 `apps/gateway/src/tmux-client/target-missing.ts`：`TmuxTargetMissingError` + `isTargetMissingMessage()`（原两个连接类的私有 `isRecoverableTargetMissingError` 提公共复用）
- local/ssh 两个连接的 `runTmux` 第二参扩为 `boolean | 'silent'`：`'silent'` 在 target missing 时抛 `TmuxTargetMissingError`，不触发 connectionAlertNotifier、不写设备运行状态；`capturePaneText` 改走 `'silent'`，Agent read_screen 同步受益
- 测试断言：抛错类型 + `deviceRuntimeStatus` 不被污染（connect 成功写入的 tmuxAvailable=true / lastError=null 保持不变）

### evaluator（2825bd9）
- `apps/gateway/src/watch/evaluator.ts` 纯函数：`compileWatchPattern`（flags 去重 + 强制 g）、`findLastMatch`（取最后命中 + 零宽防死循环）、`evaluateWatchRule`
- unchanged：extractGroup 提取值计时，noMatchBehavior reset/ignore，捕获组未参与匹配按无命中处理，lastValueChangedAt 缺失自愈
- 触发闸门：once（unchanged 用 triggeredSinceChange；match 由 service 触发后停用）/ repeat cooldown
- 24 个单测全分支覆盖（时间注入 now）

### WatchService（1799b5b）
- `apps/gateway/src/watch/service.ts`：deps 全量可注入（runtime/model/notify/broadcast/now/scheduleInterval/errorThreshold/llmMaxRetries）
- 设备分组：service 内部按 deviceId 引用计数，懒连接（首 tick acquire+connect+subscribe snapshot），onClose 自动释放并在下次 tick 重连；最后一条规则移除时 release
- 每规则独立 interval（match/unchanged 下限 5s、llm 下限 30s），tick 防重入
- LLM：`generateObject`（zod schema）实现 confirm/{confirmed,reason}、summary/{summary}、judge/{matched,reason}；confirm fail-open（触发 + unconfirmedSuffix 标注）、summary 失败降级原文
- 模型不可用告警只发一次（modelUnavailableNotified），任一次模型成功重置；fail-open/降级路径同样适用
- 连续错误（capture 失败、pattern 编译错、llm 调用失败）达阈值 10 → 自动停用 + `watch_rule_error` 通知 + WATCH_EVENT_RULE_ERROR 广播
- 触发：notify('watch_triggered') 带完整 tmux 上下文（经设备 snapshot + resolvePaneContext 构造 paneUrl/windowIndex）+ broadcastWatchEvent(TRIGGERED)
- 内存 ring buffer 120 条/规则；`refreshRule`/`removeRule` 热更新
- runtime.ts 接线（agentSupervisor 之后 start，stop 反序）
- 新增 EventType `'watch_rule_error'`（shared union + emojiMap + 三语 i18n）；shared 增补 Watch DTO 与 `notification.watch.*` 三语文案
- 15 个 service 测试（stub runtime + mock LLM HTTP server + 注入 now/tick 驱动）

### REST（2be3d39）
- `apps/gateway/src/api/watch.ts` + api/index.ts 接线：rules CRUD、:id/state（state+样本）、assist-regex
- 校验：triggerType/noMatchBehavior/fireMode 枚举、pattern 试编译（含 flags）、unchangedMinutes>0、extractGroup>=0、conditionPrompt、interval 下限（llm 30/其余 5；创建缺省 llm 60/其余 30）、providerId 存在性、cooldown>=0；PATCH 合成有效值后做跨字段语义校验
- assist-regex：generateObject({pattern,flags,extractGroup,explanation})，带 pane 时取屏做上下文（取屏失败降级继续），服务端试编译 + 屏幕试跑 preview（上限 20），模型不可用/产物非法 → 502
- 28 个 REST 测试（stub service + mock LLM server）

## 测试结果

- gateway 全量 `bun run test`：425 pass / 0 fail（含新增 evaluator 24 + service 15 + REST 28 + tmux-client 增强用例）
- shared/cli 测试通过；tsc 三包对照基线无新增错误（gateway 既有 15 个历史噪声错误未变）
- fe e2e：48 pass / 3 fail——sidebar-delete 为 MEMORY 记录的既有基线失败（单跑复现）；settings 与 mobile-settings webhook 两例单独重跑通过（全量串行时偶发 flaky），与本次改动无关

## 实现决策 / 与任务描述的差异

1. **unchanged + once 不停用规则**：用 triggeredSinceChange 防重，值变化后自动重新武装（符合"下载卡住"场景的复用预期）；match/llm + once 触发后置 enabled=false 并移出调度。
2. **pattern 编译错误也计入 consecutiveErrors** 并最终走同一自动停用路径（任务只规定 capture 失败，统一处理更一致）。
3. **llm 型触发的通知文案**用模型返回的 reason（`notification.watch.llmTriggered`）；llm 型未实现 confirmWithLlm/summarizeWithLlm（模型本身是判断主体，任务描述也未要求）。
4. **paneId 必填错误复用 `apiError.agentPaneRequired`**（文案通用），未另设 watch 专用 key。
5. confirmWithLlm 被模型否决时不写 lastTriggeredAt/triggeredSinceChange，下个采样周期会再次确认（每周期最多一次确认调用）。
6. assist-regex 的取屏失败降级为无屏幕上下文继续生成（不阻断），preview 返回空数组。
7. WatchService 通过设备 snapshot 订阅构造通知的 paneUrl/windowIndex（与 bell 通知同源的 resolvePaneContext），断连时降级为仅 paneId。

## 遗留

- watch 前端 UI（WatchDialog、watch-events-init toast）属后续任务（plan 第七节）。
- fe `WEBHOOK_EVENT_OPTIONS` 硬编码列表尚未包含 agent_*/watch_* 事件（前序任务同样未加，留给前端任务统一处理）。
- llm 型规则的 judge prompt 未带历史样本（仅当前屏幕），如需时序判断可在后续迭代加入 ring buffer 上下文。
