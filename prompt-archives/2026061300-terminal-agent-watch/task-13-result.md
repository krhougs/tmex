# Task 13 结果 — LLM / 搜索实测（local env 凭证 + 缺失即报错退出）

## 交付

### 守卫
`apps/gateway/src/test-support/live-env.ts`：
- `requireLiveEnv(keys, hint)`：缺任一键 → `console.error` 清晰指引 + `process.exit(1)`，在任何 test 跑之前退出（报错退出，非断言失败）。用于 LLM（三键缺一不可）。
- `requireAnyLiveEnv(keys, hint)`：一个都没配才退出；返回已配置子集。用于搜索（Tavily / Brave 任选其一）。

### 实测文件（`*.integration.ts`，默认 bun test 不发现）
- `apps/gateway/src/llm/provider-live.integration.ts`：`fetchProviderModels` 拉非空列表且含 `TEST_LLM_MODEL`；`resolveLanguageModel` + `generateText` 真实对话（protocol 由 `TEST_LLM_PROTOCOL` 决定，默认 openai-chat）。
- `apps/gateway/src/agent/tools/web-search-live.integration.ts`：`requireAnyLiveEnv` 要求 Tavily/Brave 至少一个；用 `test.if(...)` 按已配置 provider 注册，配哪个测哪个。断言落在字符串内容（`"url"` + `http`），因为 web_search 输出会截断到 8KB、不保证完整 JSON。

### 脚本（`apps/gateway/package.json`）
`test:live:llm` / `test:live:search` / `test:live`（前两者合跑）。

### env 模板与文档
- `test.env`：新增注释块列出实测键，真实值只进 `test.env.local`（gitignore）。搜索键标注「任选其一」。
- `docs/testing/2026061302-live-integration-tests.md`：设计、用法、覆盖、注意。
- `AGENTS.md`：新增实测条目指针。

## 验收（用真实凭证跑通）

- `test:live`：3 pass / 1 skip / 0 fail —— LLM 模型列表 + LLM responses chat（gpt-5.5）+ Tavily 搜索；Brave 未配 key 自动 skip。
- 缺凭证报错退出：
  - 搜索无任何 key → exit 1，提示「需至少提供其中一个 TEST_TAVILY_API_KEY / TEST_BRAVE_API_KEY」。
  - 单 key 在场 → 该 provider 测试运行，另一 provider `test.if` skip（非 fail）。
- 默认 `bun test`（gateway）432 pass / 0 fail，`*.integration.ts` 未被发现，CI 不受影响。
- 新增文件 tsc 无报错（gateway 既有 `ssh-connect-config.ts`/`ssh-auth.ts` tsc 报错为存量，无关）。

## 用户本地环境

已按用户提供凭证写入 `test.env.local`（gitignore，不提交）：LLM = 给定 endpoint + gpt-5.5 + openai-responses；搜索 = Tavily key。Brave 未提供。
