# Task 15 结果 — 模型拉取失败补日志 + LLM 真实 HTTP 全链路实测

## 用户报错的真相

dev provider `axon`（`openai-responses`，baseUrl=`http://10.110.89.177:8090`）报「无法获取模型列表」。手动触发 refresh-models 返回 `Failed to fetch model list: Was there a typo in the url or port?`（HTTP 502）；直接 curl `http://10.110.89.177:8090/v1/models` → connection refused（curl exit 7）。

**不是代码 bug**：该内网 endpoint 此刻不可达。后端把错误正确回传 toast，但 `refreshModelsCache` 的 catch 未在服务端打日志——dev 控制台看不到原因，这是真实缺口。

## 改动

### 服务端日志（`api/llm.ts`）
`refreshModelsCache` catch 处补 `console.warn`，含 provider 名/id/baseUrl + 错误详情。create / update / refresh 三条路径共用此函数，全覆盖。已验证：既有 mock 失败用例现会打出 `[llm] 拉取模型列表失败 …`。

### 真实 HTTP 全链路实测（`api/llm-api-live.integration.ts` + `test:live:llm-api`）
走真实 `handleLlmApiRequest`（非 mock）打真实 endpoint，覆盖 UI 实际触发路径：
1. POST 创建 provider → 自动拉模型，校验非空且含 `TEST_LLM_MODEL`、`hasApiKey`
2. GET 列表含新建项
3. POST refresh-models 重新拉取
4. PATCH settings 设默认 provider/model
5. `resolveLanguageModel(默认)` + `generateText` 真实对话
6. `resolveProviderWebSearchTool` 对 responses 协议返回内置搜索工具
7. DELETE 删除并确认列表移除

`test:live` 聚合脚本纳入此文件。

## 验收（gpt-5.5 / openai-responses 实跑）

- `test:live:llm-api`：7 pass / 0 fail。
- gateway 全量 `bun test`：433 pass / 0 fail，失败路径正确打出 `[llm]` warn。

## 给用户的结论

`axon`（`http://10.110.89.177:8090`）拉模型失败的根因是 **macOS 本地网络（Local Network）TCC 权限**：本机就在 `10.110.89.x` 网段、ping 通、`nc` 能连，但 curl 与 Bun fetch 均报 `No route to host`（EHOSTUNREACH，1ms 立即失败）——这是 macOS 14+/15+ 对未授权进程访问局域网地址的拒绝形态。用户终端 app 已被授予本地网络权限故 curl 有返回；gateway 进程（Bun，launchd/dev-supervisor 拉起）未授权故连不上。

**非 tmex 代码问题**。修复在系统侧：系统设置 → 隐私与安全性 → 本地网络，给运行 gateway 的 app 开启（dev 为终端 app；生产为常驻 daemon，需触发授权）。本次补的服务端日志正好让这类「网络/权限」失败在 dev 控制台可见（`No route to host`）。真实程序 LLM HTTP 全链路已用 gpt-5.5 实跑 7/7 通过。
