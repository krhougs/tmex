# 实测（live integration）：LLM 与搜索打真实 endpoint

## 背景

LLM Provider 与 Web 搜索（Tavily / Brave）的单元测试用打桩 upstream，覆盖解析与分支逻辑，但不验证「真实 endpoint + 真实凭证」是否真能连通。需要补一组打真实服务的实测；这类测试依赖付费凭证，不能进仓库，也不应混进默认 `bun test`。

## 设计

### 凭证只放 test.env.local

实测凭证写仓库根 `test.env.local`（已 gitignore）。`NODE_ENV=test` 下由 `apps/gateway/test-preload.ts` 的 `loadEnv()` 自动加载进 `process.env`，覆盖 `test.env`。`test.env` 里有一段注释模板列出所有实测键，照抄到 `test.env.local` 填真实值即可。

| 键 | 用途 | 必需性 |
| --- | --- | --- |
| `TEST_LLM_BASE_URL` | LLM Base URL（裸 host 自动补 `/v1`） | LLM 实测必需 |
| `TEST_LLM_API_KEY` | LLM API Key | LLM 实测必需 |
| `TEST_LLM_MODEL` | 一个可用模型 id | LLM 实测必需 |
| `TEST_LLM_PROTOCOL` | `openai-chat`（默认）/ `openai-responses` | 可选 |
| `TEST_TAVILY_API_KEY` | Tavily API Key | 搜索实测：与 Brave 任选其一 |
| `TEST_BRAVE_API_KEY` | Brave Subscription Token | 搜索实测：与 Tavily 任选其一 |

### 缺凭证：报错退出，而非测试 fail

实测文件用 `*.integration.ts` 命名，默认 `bun test` 不会发现它们，只能由 `test:live:*` 脚本显式跑。

每个实测文件在**模块顶层**调用守卫（`apps/gateway/src/test-support/live-env.ts`）：

- `requireLiveEnv(keys, hint)`：缺任一键 → `console.error` 清晰指引 + `process.exit(1)`。在任何 `test()` 跑之前退出，避免退化成误导性的「断言失败」。用于 LLM（三键缺一不可）。
- `requireAnyLiveEnv(keys, hint)`：一个都没配才退出；返回已配置子集。用于搜索（Tavily / Brave 任选其一）。

搜索实测对「已配置的 provider」用 `test.if(...)` 注册：配了哪个测哪个，都配则都测，没配的 provider 不注册（不是 fail、不是产品缺陷）。

这样「没填凭证」（退出码 1、明确提示去 `test.env.local` 填）与「功能真的坏了」（正常断言失败）泾渭分明。

## 用法

```bash
# 先把 test.env 注释里的实测键复制到 test.env.local 填真实值
bun run --filter @tmex/gateway test:live:llm      # LLM：模型列表 + 真实 chat
bun run --filter @tmex/gateway test:live:search   # 搜索：Tavily / Brave 任选其一
bun run --filter @tmex/gateway test:live          # 全部
```

未填对应凭证时脚本以退出码 1 报错退出，并打印需要补哪个键。

## 覆盖

| 脚本 | 文件 | 内容 |
| --- | --- | --- |
| `test:live:llm` | `src/llm/provider-live.integration.ts` | `fetchProviderModels` 拉到非空列表且含 `TEST_LLM_MODEL`；`resolveLanguageModel` + `generateText` 真实对话 |
| `test:live:search` | `src/agent/tools/web-search-live.integration.ts` | `createWebSearchTool` 注入真实 key，Tavily / Brave 各跑一次真实搜索并校验返回 |

## 注意

- `test.env.local` 含真实密钥，**不提交、不外泄**。
- 默认 `bun test`、CI 不受影响（不发现 `*.integration.ts`）。
- 实测会真实消耗 LLM / 搜索配额，按需手动跑。
- `test:live:*` 脚本已强制 `NODE_ENV=test`：交互式 shell 常从安装版 `app.env` 继承
  `NODE_ENV=production`，那样 `loadEnv` 会走生产分支、不读 `test.env.local` 导致凭证缺失。
  脚本内置 `NODE_ENV=test` 后，新开终端直接 `bun run ... test:live` 即可，无需手动前缀。
