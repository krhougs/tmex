# Task 12 结果 — LLM Provider Base URL 后缀约定

## 根因

后端从未对用户输入的 Base URL 做路径后处理:`normalizeBaseUrl` 只 trim 尾部斜杠。而 `fetchProviderModels`(`${base}/models`)、`createOpenAICompatible`(`${base}/chat/completions`)、`createOpenAI().responses()`(`${base}/responses`)都要求 base **已含 `/v1`**。用户保存的 Base URL 漏了 `/v1` → 全部读不到模型。用真实端点 `https://xxx.0v0.ooo` 验证:裸 host 的 `/models`、`/chat/completions` 均 404,带 `/v1` 正常。

## 改动

### 后端
`apps/gateway/src/llm/provider-registry.ts`:`normalizeBaseUrl` → `resolveBaseUrl`,实现 NextChat/OneAPI 式后缀约定:
- **默认**:自动补 `/v1`(已以 `/vN` 结尾不重复)。
- **`/` 结尾**:忽略 v1,仅去尾斜杠,路径原样。
- **`#`**:暂不作为特殊标记,按 URL fragment 丢弃(不产生坏 URL)。

三处调用点(`resolveLanguageModel`、`resolveProviderWebSearchTool`、`fetchProviderModels`)统一改用 `resolveBaseUrl`。存储原样保留用户输入,使用时解析——**现有未带 `/v1` 的 provider 无需重新录入**,刷新一次模型列表即可。

> 未实现完整 `#`「强制原样」:已验证 `@ai-sdk/openai-compatible` 把请求 URL 写死为 `new URL(\`${baseURL}${path}\`)`(path 固定 `/chat/completions`),只暴露 `baseURL`、不让接管完整 path;Responses 协议同理固定 `/responses`。真正「一个字符都不拼」需注入自定义 `fetch` 重写 URL,且对「拉模型列表」第二端点语义不明。按用户决定先不做。

### 测试
`provider-registry.test.ts`:`normalizeBaseUrl` describe → `resolveBaseUrl`,新增默认补 v1 / 不重复 vN / `/` 结尾 / fragment 四类用例。

### 前端 + i18n
- `llm-providers-tab.tsx`:新建 provider 表单 Base URL 输入框下增加提示文案。
- 三语 locale 新增 `settings.llm.baseUrlHint`,`baseUrlPlaceholder` 改为裸 host `https://api.openai.com`;`bun run build:i18n` 重新生成 `resources.ts`/`types.ts`。

## 验收

- `NODE_ENV=test bun test provider-registry.test.ts api/llm.test.ts` → 29 pass / 0 fail。
- 真实端点端到端:`resolveBaseUrl('https://xxx.0v0.ooo')` → `…/v1`,`/models` HTTP 200 返回 18 个模型;`/v1`、`/v1/` 均 200;`/`(忽略 v1)对该端点 404,符合预期。
- FE tsc 无报错;新 i18n key 类型可用。
- gateway 既有 tsc 报错(`ssh-connect-config.ts`、`ssh-auth.ts`)为存量问题,与本次改动无关。
