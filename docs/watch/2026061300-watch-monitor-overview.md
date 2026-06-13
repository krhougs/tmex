# Watch 屏幕监控总览

## 背景与目标

Watch 是与 agent session 无关的独立功能：对某个 tmux pane 添加规则，gateway 周期采样屏幕纯文本（`capturePaneText`），按规则判定是否触发，触发走现有通知体系（Webhook/Telegram + WS 广播 → 浏览器 toast/Notification）。核心 use case：下载/上传卡住超过 N 分钟提醒。

服务端代码在 `apps/gateway/src/watch/`（`evaluator.ts` 纯函数 + `service.ts` 编排），REST 在 `api/watch.ts`，前端在 `apps/fe/src/components/watch/`。规则表 `watch_rules`，运行态分离在 `watch_rule_state`（单行 UPDATE，重启后计时延续）；近期样本只放内存 ring buffer（每规则 120 条），不进库。

## 三种 triggerType 语义

判定逻辑集中在 `evaluator.ts` 纯函数（输入 screen+rule+state，输出新 state+是否命中，时间由调用方注入便于测试）。正则取屏幕上**最后一个**命中（进度行通常在底部），flags 强制加 g 并去重，零宽匹配有死循环防护。

### match：正则命中即触发

- 命中即触发；`fireMode=once` 触发后置 `enabled=false` 并移出调度（可手动重新启用），`repeat` 受 `cooldownSeconds`（默认 600）限频。
- 用例：日志出现 `ERROR`/`panic` 时告警。

### unchanged：提取值连续 N 分钟不变 → 判定卡住

- `pattern` 第 `extractGroup` 捕获组提取值（如下载百分比），值变化则重置计时；`now - lastValueChangedAt ≥ unchangedMinutes` 触发。
- **无命中**按 `noMatchBehavior` 处理：`reset`（进度行消失视为任务结束，停止计时）或 `ignore`（保持计时，容忍进度行被滚出屏幕）。捕获组未参与匹配按无命中处理。
- `once` 用 `triggeredSinceChange` 防重，值变化后**自动重新武装**（区别于 match 的停用——"下载卡住"场景天然需要复用）；`repeat` 受 cooldown。
- 用例：`wget` 进度 73% 停了 30 分钟 → 提醒。

### llm：自然语言条件，模型周期看屏判断

- 每周期取屏后调 `generateObject({ matched, reason })` 判断 `conditionPrompt` 是否满足，matched 即触发（同样受 fireMode/cooldown）。
- **模型是判断主体**：调用失败计入 consecutiveErrors（见下文），不存在 fail-open。
- 采样下限 30s（match/unchanged 下限 5s），创建缺省 llm 60s / 其余 30s。
- llm 型不提供 confirmWithLlm/summarizeWithLlm（模型本身就在判断）；触发通知文案用模型返回的 reason。

## LLM 介入点与降级策略

每条规则可独立选 provider/model（`providerId`/`modelId`，空则用 `agent_settings` 全局默认），由 `llm/provider-registry.ts` 解析。四个介入点：

| 介入点 | 时机 | 模型不可用时 |
|---|---|---|
| llm 型周期判断 | 每个采样周期 | 计入 consecutiveErrors，发 `watch_model_unavailable` 告警 |
| confirmWithLlm（match/unchanged 可选） | 正则命中后二次确认，减少误报 | **fail-open**：直接触发通知并在文案注明"未经 LLM 确认"（宁误报不漏报） |
| summarizeWithLlm（match/unchanged 可选） | 触发后生成通知摘要（如"wget 在 73% 停滞 32 分钟"） | 降级为原始匹配文本 |
| assist-regex | 创建规则时按自然语言描述生成正则 | REST 返回 502 |

补充语义：

- **告警只发一次**：模型首次调用失败发 `watch_model_unavailable` 并置 `state.modelUnavailableNotified=true`，后续失败不再发；任一次模型调用成功后重置标记（恢复后再坏会再发一次）。fail-open/摘要降级路径同样适用此标记。
- confirmWithLlm 被模型否决时不写 `lastTriggeredAt`/`triggeredSinceChange`，下个采样周期会再次确认（每周期最多一次确认调用）。

## 采样调度与连接管理（service.ts）

- 启动时加载全部 enabled 规则；每规则独立 interval 定时器，tick 防重入（in-flight 跳过）。
- **设备连接按 deviceId 引用计数**（service 内部，底层复用 `tmux-client/runtime-registry`）：首个 tick 懒 acquire+connect+订阅 snapshot；onClose 自动释放并在下次 tick 重连；设备最后一条规则移除/禁用时 release，不长期持有无用连接。
- 取屏用 `runTmux` 的 `'silent'` 形态：pane 消失抛 `TmuxTargetMissingError`，不触发设备连接告警、不污染设备运行状态。
- **连续错误自动停用**：capture 失败、pattern 编译错、llm 调用失败统一计入 `consecutiveErrors`，达阈值（10）自动置 `enabled=false` + `watch_rule_error` 通知 + WS `RULE_ERROR` 广播。
- CRUD 后 `refreshRule()`/`removeRule()` 热更新调度，无需重启。
- 触发动作：`eventNotifier.notify('watch_triggered', ...)`（带 paneUrl/windowIndex 等完整 tmux 上下文，断连时降级仅 paneId）+ `WATCH_EVENT`(0x0701) WS 广播（eventType：1=TRIGGERED 2=MODEL_UNAVAILABLE 3=RULE_ERROR）。
- 前端 `watch-events-init.tsx`（挂 RootLayout）：TRIGGERED → sonner toast（带"打开终端"action）+ 浏览器 Notification（权限在首次创建规则的用户手势内申请；未授权降级 toast + 服务端 Telegram/Webhook）。

## assist-regex（LLM 辅助生成正则）

`POST /api/watch/assist-regex`：`{ description, deviceId?, paneId? }` → 用规则选定（或全局默认）模型一次性 `generateObject({ pattern, flags, extractGroup, explanation })`。

- 带 pane 时取当前屏幕做 few-shot 上下文，取屏失败降级为无上下文继续（不阻断）。
- 返回前服务端试编译校验 + 在样本屏幕试跑给 preview（上限 20 条命中）；产物非法/模型不可用 → 502。
- 前端表单回填 pattern/flags/extractGroup 并展示 explanation 与 preview，用户可改后保存。

## 已知限制与记债

1. llm 型判断只看当前屏幕，不带历史样本时序（ring buffer 已有数据，可后续注入 judge prompt）。
2. 规则列表"最近触发时间"每行独立请求 `:id/state`，规则数大时可考虑列表接口附带 state。
3. TRIGGERED toast 跳转沿用 bell 先例整页跳转（`window.location.href`），未走 SPA navigate。
4. 浏览器 Notification 在未注册 SW 的移动端可能构造抛错，已 try/catch 降级 toast（iOS 需 16.4+ PWA）。

## 验收标准对照（plan-00.md 验证节）

| 验证项 | 覆盖方式 | 位置 |
|---|---|---|
| evaluator 纯函数：match/unchanged/reset/ignore/once/repeat/cooldown 各分支 | 单测（24 例） | `watch/evaluator.test.ts` |
| unchanged 卡住 N 分钟触发（计时/值变重置/重启延续） | 单测 | `watch/evaluator.test.ts` + `watch/service.test.ts`（注入 now/tick 驱动时序） |
| llm 型周期判断 | 单测（mock LLM HTTP server） | `watch/service.test.ts` |
| confirmWithLlm fail-open / summarizeWithLlm 降级 / 告警只发一次+恢复重置 | 单测 | `watch/service.test.ts` |
| 连续错误自动停用 + 通知 | 单测 | `watch/service.test.ts` |
| 规则 REST 校验（枚举/试编译/下限/跨字段） | 单测（28 例） | `api/watch.test.ts` |
| assist-regex 生成/校验/preview/502 | 单测 + e2e（mock） | `api/watch.test.ts`；`apps/fe/tests/watch.spec.ts`（page.route mock 回填断言） |
| 规则 CRUD UI（创建/角标/启停/删除） | e2e | `watch.spec.ts` |
| 真实触发链路（采样命中 → WS → toast） | e2e（真后端，无 mock） | `watch.spec.ts` triggered 用例 |
| 移动端 WatchDialog 可用 | e2e | `mobile-agent-watch.spec.ts`（375x812） |
| Telegram/Webhook 通知出口 | 复用既有通知体系 | `events/index.test.ts`；watch 侧只断言 notify 调用（service.test） |
