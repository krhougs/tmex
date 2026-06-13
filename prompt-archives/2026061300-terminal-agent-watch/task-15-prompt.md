# Task 15 — LLM 模型拉取失败补服务端日志 + 真实 HTTP 全链路实测

## 背景

接 Task 14。用户在本地 dev server（19883）`/settings` 加了个 LLM provider，报「无法获取模型列表」，且 dev 模式没打出错误日志。

## 排查结论

用户 provider `axon`：`openai-responses`，baseUrl=`http://10.110.89.177:8090`（内网 HTTP）。手动触发 refresh-models 返回 `Failed to fetch model list: Was there a typo in the url or port?`（HTTP 502）；直接 curl `http://10.110.89.177:8090/v1/models` → connection refused（curl exit 7）。

→ **不是代码 bug**：该内网 endpoint 此刻不可达。后端把错误正确返回进 toast，但 `refreshModelsCache` 的 catch 把错误吞进 `modelsError` 字段、**未在服务端打日志**——这是真实缺口（用户在 dev 控制台看不到原因）。

## 需求（用户原话）

> 在本地 dev server 加了个 llm provider，报错无法获取模型列表，dev 模式也没有把应该打出来的错误日志打出来。
> 帮我把实际程序中的 LLM 相关所有内容都测一下，之前只用 mock 测过。用 gpt-5.5。

## 方案

1. `api/llm.ts` `refreshModelsCache` catch 处补 `console.warn`（provider id/name + 错误详情），create/update/refresh 三条路径都覆盖。
2. 新增 `apps/gateway/src/api/llm-api-live.integration.ts`：走真实 `handleLlmApiRequest`（非 mock）打真实 endpoint 全链路：
   - POST 创建 provider（触发自动 refresh models，正是 UI 路径）→ 校验 models 非空
   - GET 列表 / POST refresh-models / PATCH settings 设默认 / DELETE
   - resolveLanguageModel(默认) + generateText 真实对话（gpt-5.5 / openai-responses）
   - resolveProviderWebSearchTool（responses 协议返回非空 tool）
   凭证走 test.env.local（已配 gpt-5.5 / openai-responses）。
3. 实跑验证。

## 验收

- 模型拉取失败时 dev 控制台有 warn 日志。
- llm-api-live 全链路实测通过（gpt-5.5）。
- 既有单测全绿。
