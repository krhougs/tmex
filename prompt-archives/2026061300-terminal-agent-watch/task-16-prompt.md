# Task 16 — Responses 协议多轮工具调用报 "Item not found / store=false"

## 背景

接 Task 15。用真实 agent 跑 `gpt-5.5`（openai-responses）多轮工具调用时报错：

```
AI_APICallError: Item with id 'rs_0fa1...' not found. Items are not persisted when `store` is set to false.
url: https://xxx.0v0.ooo/v1/responses  statusCode: 404
```

## 根因（已核对 @ai-sdk/openai@3.0.71 源码）

`gpt-5.5` 是 reasoning 模型，输出含 `reasoning` item（id `rs_...`）。AI SDK 的 `convertToOpenAIResponsesInput` 里 `store` 默认 `true`：对任何带 id 的 item（reasoning / 工具调用）发 `{ type: "item_reference", id }` 而非内联内容；但请求体 `store` 字段取 `openaiOptions?.store`（未设 → undefined），该聚合端点默认不持久化 → 下一轮引用 `rs_...` 报 Item not found。

tmex 是**无状态回放**架构（自己持久化消息、每轮从库重建 input），与「靠服务端存储 + item_reference」根本冲突。

SDK 关键分支（dist/index.mjs:5042）：`store === false && isReasoningModel` 时 `include: reasoning.encrypted_content`，且 input 转换跳过 item_reference、改内联发送——正是无状态模式。

provider options namespace 已核对：responses 读 `openai`，openai-compatible chat 读自身 name，故 `{ openai: { store:false } }` 只作用于 responses、对 chat 无副作用。

## 方案

agent `streamText` 调用加 `providerOptions: { openai: { store: false } }`：Responses 协议转为无状态内联（reasoning 走 encrypted_content），与 tmex 回放一致；对 openai-chat 无影响。

## 验收

- 真实 endpoint 多轮工具调用（gpt-5.5 / responses）不再报 Item not found。
- agent run 既有单测全绿；新增 live 多轮工具调用实测。
