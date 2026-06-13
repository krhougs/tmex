# Task 16 结果 — Responses 协议多轮工具调用 store:false 修复

## 根因（已核对 @ai-sdk/openai@3.0.71 源码 + 真实复现）

`gpt-5.5`（reasoning 模型）多轮工具调用时，AI SDK 的 `convertToOpenAIResponsesInput` 中 `store` 默认 `true`：对任何带 id 的 item（reasoning `rs_...` / 工具调用 `fc_...`）发 `{ type: "item_reference", id }` 依赖服务端存储；但请求体 `store` 实际为 undefined，聚合端点默认不持久化 → 下一轮引用报 `Item with id '...' not found / store=false`（404）。

tmex 是无状态回放架构（自持久化消息、每轮从库重建 input），与 item_reference + 服务端存储冲突。

真实端点复现（gpt-5.5，2+3 工具调用）：
- 默认（不设 store）→ `Item with id 'fc_...' not found`
- `store:false` → OK，text="5"，2 steps

SDK 在 `store===false && isReasoningModel` 时改走无状态内联（`include: reasoning.encrypted_content`，input 不发 item_reference）。

## 改动

`apps/gateway/src/agent/run.ts` 的 `streamText` 加 `providerOptions: { openai: { store: false } }`。namespace `openai` 仅作用于 responses 模型，对 openai-chat（compatible，读自身 name namespace）无副作用——已核对两个 provider 的 `providerOptionsName`。

新增 live 回归测试 `provider-live.integration.ts`：Responses 协议下多轮工具调用（带 id 的 item 回放）在 store:false 下成功（steps > 1 且结果含 "5"）。

## 验收

- 真实端点 `test:live:llm`：3 pass（模型列表 / 真实对话 / 多轮工具调用），0 fail。
- gateway 全量 `bun test`：433 pass / 0 fail，agent run 无回归（chat 协议忽略该 namespace）。
