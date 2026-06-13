# Task 13 — LLM / 搜索 真实 endpoint 实测（local env 凭证 + 缺失即报错退出）

## 背景

接 Task 12。LLM Provider 与 Web 搜索（Tavily / Brave）此前只有打桩单测，没有打真实 endpoint 的集成测试。需要补上「实测」，但实测依赖真实 endpoint 与付费凭证，不能进仓库。

## 需求（用户原话）

> 对于 LLM 访问和搜索的访问，我们需要在实际 endpoint 中进行测试。
> 但是测试相关的 endpoint 和 credential 我们需要放在 local env 中让用户自己填写，
> 如果测试环境没有读取到 local env 中的相关信息应该报错退出而不是测试 fail。
> 这个也需要加入相关文档中。

## 关键事实（已核对）

- `test.env.local`（已 gitignore）在 `NODE_ENV=test` 下由 `apps/gateway/test-preload.ts` 的 `loadEnv()` 自动加载进 `process.env`，是放实测凭证的地方。
- 默认 `bun test` 只发现 `*.test/*.spec`，`*.integration.ts` 需独立 `test:*` 脚本显式跑（先例 `ssh-agent-local.integration.ts` + `test:ssh-agent-local`）。
- 该先例在 test 体内 throw → 变成「测试 fail」，正是要避免的。本任务改为**模块顶层守卫**：缺凭证抛清晰指引、在任何 test 跑之前中止（报错退出，非断言失败）。
- 可测面：`fetchProviderModels`（模型列表）、`resolveLanguageModel`+`generateText`（真实 chat）；`createWebSearchTool` 注入真实 key 后执行 Tavily / Brave。

## 决策

- 范围：LLM provider（模型列表 + chat）、Tavily、Brave 三项全做（用户确认）。
- 搜索按 provider 拆独立文件 + 独立守卫，只缺哪个挡哪个。
- env 变量名：`TEST_LLM_BASE_URL` / `TEST_LLM_API_KEY` / `TEST_LLM_MODEL` / `TEST_LLM_PROTOCOL`(可选,默认 openai-chat) / `TEST_TAVILY_API_KEY` / `TEST_BRAVE_API_KEY`。
- 缺失机制：共享守卫 `requireLiveEnv(keys, hint)` 在模块顶层抛错（报错退出），消息明确「缺配置，非产品缺陷，去 test.env.local 填」。

## 交付

- `apps/gateway/src/test-support/live-env.ts`：`requireLiveEnv` 守卫。
- `apps/gateway/src/llm/provider-live.integration.ts`：模型列表 + chat。
- `apps/gateway/src/agent/tools/web-search-tavily.integration.ts` / `web-search-brave.integration.ts`。
- `apps/gateway/package.json`：`test:live:llm` / `:tavily` / `:brave` / `test:live`。
- `test.env`：注释块列出实测键（真实值只进 test.env.local）。
- 文档：`docs/testing/` 新文档 + AGENTS.md 指针。
