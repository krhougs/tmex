# 执行结果：Agent System Prompt 重构

## 完成内容

### 1. 类 JSX 提示词模板（零依赖）
- `apps/gateway/src/agent/prompts/jsx.ts`：自研 `h`/`Fragment` + `cat`/`lines`/`blocks` 文本运行时。
- `prompts/components.ts`：`Doc`/`Section`/`Item`/`Lines` 基础组件。
- `prompts/system-prompt.tsx`：12 段提示词模板，Bun 原生 classic JSX 转译（pragma `@jsxRuntime classic` + `@jsx h` + `@jsxFrag Fragment`）。
- `prompts/index.ts`：`buildAgentSystemPrompt`/`buildTitleGenerationPrompt`（函数名不变）。
- `prompts/environment.ts`：`collectAgentEnvironment` 采集入口主机事实。
- gateway `tsconfig.json` 加 jsx 字段；删除旧 `prompts.ts`；`run.ts` 改为传 `environment`。

### 2. 实时 pane 元信息
- `TerminalRuntimeLike.getPaneInfo` + 沿 connection 链路实现（Local/Ssh，`tmux display-message`）。
- `capture-history.ts` 加 `PANE_META_FORMAT`/`parsePaneMeta`/`PaneInfo`。
- `read_screen`/`send_input` 返回带 `cols/rows`；新增 `get_pane_info` 工具。

### 3. 注入防护
- `tools/untrusted.ts` 的 `wrapUntrusted` 包裹屏幕/网页内容为不可信块；system prompt 指令层禁止当指令执行。

### 4. 凭证消毒（DB 存真实 / 仅出站 LLM 消毒）
- `secret-scan.ts`：高精度 `redactSecrets`/`detectSecrets`。
- `redaction-middleware.ts`：`wrapLanguageModel` + `transformParams` 出站消毒（只动 tool/assistant 工具结果，跳过 user/system）；`run.ts` 包裹模型。

### 5. 用户输入凭证告警
- `supervisor.submitUserMessage`：`detectSecrets` 命中 → 广播 `AGENT_EVENT_CREDENTIAL_WARNING` + Telegram 推送（不改写内容）。
- ws-borsh 加事件常量/payload/map；shared 主入口与 index 再导出。
- i18n（en/zh/ja）加 `telegram.agentCredentialWarning` 与 `agent.toast.credentialWarning*`，`build:i18n` 重建。
- 前端 `stores/agent.ts` 加 `handleCredentialWarning` → `toast.warning`。

## 验收结果
- gateway `bun test`：**473 pass / 0 fail**（45 文件），含新增 jsx/system-prompt/secret-scan/redaction-middleware/get_pane_info(含临时 socket integration, 实测 cols=100)/supervisor 凭证告警测试。
- shared `bun test`：**49 pass / 0 fail**。
- 前端 `tsc --noEmit`：通过。
- gateway `bun build --target bun`：通过（400 modules）。

## 关键决策回溯
- JSX：Bun 原生 classic 工厂，自研运行时，零第三方依赖。
- 窗口尺寸：read_screen 带尺寸 + get_pane_info 工具，两者都做。
- 环境注入：入口事实 + 探测引导；网络 IP 不注入。
- 凭证：机器来源内容消毒（DB 真实 / 出站 LLM 消毒，middleware 单点）；用户输入不改写仅告警。

## 遗留权衡（已写入文档）
`tmex.db` 会落库真实终端/网页内容，可能含明文凭证；消毒边界仅止于外部 LLM provider。详见 `docs/agent/2026061302-system-prompt-and-credential-handling.md`。

## 偏离计划处
- JSX 类型命名空间未用全局 `jsx.d.ts`，改为挂在工厂 `h.JSX` 上（避免污染前端 React JSX）；并加 `@jsxRuntime classic` pragma 解决从仓库根跑测试时退化到 automatic 运行时的问题。
- 注入防护未单列 task 的「结构层单测」独立文件，已并入 `terminal.test.ts`/`web.test.ts` 的断言。
