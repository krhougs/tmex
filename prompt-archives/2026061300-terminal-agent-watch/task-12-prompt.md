# Task 12 — LLM Provider Base URL 后缀约定（自动补 /v1）

## 背景

接 2026061300-terminal-agent-watch 任务。用户反馈现有 LLM Provider「均不能读到模型列表」，怀疑后端没有正确处理 endpoint 的后处理。

排查结论（已用真实端点 `https://xxx.0v0.ooo` 验证）：

- 该端点把 `/models`、`/chat/completions` 都挂在 `/v1` 下；裸 host 两者都 404，带 `/v1` 正常。
- 后端代码本身自洽：`fetchProviderModels` 用 `${normalizeBaseUrl(baseUrl)}/models`，`createOpenAICompatible({ baseURL })` 推理时拼 `${baseUrl}/chat/completions`，二者都要求存储的 Base URL **已含 `/v1`**。
- 真正缺失的是「endpoint 后处理」：`normalizeBaseUrl` 只 trim 尾部斜杠，不做路径补全。用户保存的 URL 漏了 `/v1` → 全部读不到模型。

## 需求（用户原话）

> 现在 LLM 应用的通行方法是，只需要用户提供 baseurl，然后程序自己处理各种需要的具体 URL。
> 然后可以通过一些方式来锁定 URL，一个其他 app 中的文案例子："/ 结尾忽略 v1 版本，# 结尾强制使用输入地址"

即 NextChat / OneAPI 式的「魔法后缀」约定。

## 约束（已验证 AI SDK 源码）

`@ai-sdk/openai-compatible` 的请求 URL 写死为 `new URL(`${baseURL}${path}`)`，path 固定 `/chat/completions`；只暴露 `baseURL`，不让接管完整 path。Responses 协议同理固定追加 `/responses`。因此 `#`（强制原样、一个字符都不拼）无法干净支持。

## 决策

- **默认**：自动补 `/v1`（已以 `/vN` 结尾则不重复）。
- **`/` 结尾**：忽略 v1，路径原样追加资源名。
- **`#` 结尾**：暂不实现（作为 URL fragment 丢弃，不产生坏 URL）。用户选「先不做 #，只上默认 + /」。
- 存储原样保留用户输入，使用时解析；现有未带 `/v1` 的 provider 改完后无需重新录入即可拉到模型（刷新一次模型列表即可）。

## 验收

- `resolveBaseUrl` 单测覆盖三类输入（裸 host / 已含 vN / `/` 结尾 / 含 fragment）。
- 现有 provider-registry / api/llm 测试全绿。
- FE Base URL 输入框补充后缀约定提示文案（i18n 三语）。
