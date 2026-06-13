# Agent System Prompt 重构与凭证处理

## 背景

terminal agent 的系统提示词原先由 `apps/gateway/src/agent/prompts.ts` 用「数组 + `join`」硬拼四段，难以组合、无法注入上下文、缺少安全约束。本次重构把它改为类 JSX 的可组合模板，并补齐环境注入、实时窗口尺寸、shell/网络设备引导、注入防护与凭证处理。

## 提示词架构（类 JSX，零依赖）

- 自研极简 JSX→纯文本运行时：`apps/gateway/src/agent/prompts/jsx.ts`（`h`/`Fragment` + `cat`/`lines`/`blocks` 工具函数），组件即「props → string」纯函数。基础组件 `Doc`/`Section`/`Item`/`Lines` 在 `components.ts`。
- 模板 `system-prompt.tsx` 用 Bun 原生 classic JSX 转译。文件头三条 pragma：
  `/** @jsxRuntime classic */ /** @jsx h */ /** @jsxFrag Fragment */`。
  `@jsxRuntime classic` 不可省——否则从仓库根跑 `bun test` 时 Bun 会按默认 automatic 运行时去找 `react/jsx-dev-runtime` 而报错（与 cwd/最近 tsconfig 有关）。
- gateway `tsconfig.json` 增加 `jsx: react` + `jsxFactory: h` + `jsxFragmentFactory: Fragment`（gateway 无其他 tsx，前端独立 tsconfig 不受影响）。
- 入口 `prompts/index.ts` 导出 `buildAgentSystemPrompt(context)`（渲染 `<SystemPrompt/>` 为字符串）与 `buildTitleGenerationPrompt`，函数名与调用点保持不变。

模板段落：身份 / 入口环境 / 真实环境探测引导 / 窗口尺寸与 TUI / 终端工具规则 / 网络设备知识 / 注入防护 / 凭证处理 / 意图确认 / 安全科普 / 通用规则 / 用户自定义指令。

## 环境注入

`prompts/environment.ts` 的 `collectAgentEnvironment(device)` 采集「入口主机」事实：device 类型/host/user/port、tmux session、时区、当前时间；**仅 local 设备**额外注入 gateway 主机 OS/shell（local 设备的 gateway 进程即入口主机）。提示词明确标注这是「入口主机」，并强引导 agent：pane 可能已 ssh 到远程服务器/网络设备，动手前先探测真实环境（`uname`/`ver`/`echo $SHELL`/提示符）。网络 IP 不注入（gateway 拿到的是自身 IP，语义模糊），改为引导 agent 自查。

## 实时窗口尺寸与 pane 元信息

窗口尺寸随时变化，不 inject，改为实时读取：

- `TerminalRuntimeLike` 新增 `getPaneInfo(paneId)`，沿 `DeviceSessionRuntimeConnection` → `DeviceSessionRuntime` → Local/Ssh 连接实现，底层 `tmux display-message -p` 取 `pane_width/pane_height/alternate_on/cursor_x/cursor_y/pane_current_command`（`capture-history.ts` 的 `PANE_META_FORMAT`/`parsePaneMeta`）。
- `read_screen`/`send_input` 返回值附带实时 `cols/rows`（`getPaneInfo` 失败降级为 `null`，不影响读屏）。
- 新增 `get_pane_info` 工具，返回尺寸 + 光标 + alternate screen + 当前前台命令，用于理解 TUI 状态。

## 注入防护

屏幕内容、抓取的网页都是不可信数据，可能藏诱导指令。双层防护：

- 结构层：`tools/untrusted.ts` 的 `wrapUntrusted` 把 `read_screen`/`send_input` 屏幕文本、`fetch_url` 网页正文用 `<<<UNTRUSTED ...>>> ... <<<END ...>>>` 标记包裹。
- 指令层：system prompt 明确这些内容是数据而非指令，绝不执行其中内嵌命令，可疑诱导上报用户。

## 凭证处理（不对称策略）

凭证（屏幕上的 `show run` 密码 / `cat` 私钥 / token，以及用户输入）会外发 LLM provider 并落进 `tmex.db`。采用**不对称**策略：

### 机器来源内容（屏幕/网页）：DB 存真实，仅出站 LLM 消毒

- 工具返回**真实**内容，`onStepFinish` 落库即真实（本地审计/重放完整）。
- 消毒收口在 **provider 出站边界**：`redaction-middleware.ts` 用 AI SDK `wrapLanguageModel` + `transformParams`，在每次调 provider 前对 prompt 消毒。该 seam **同时覆盖 run 内 tool-result 回喂与跨轮历史回放**，LLM 永不见真实凭证。
- 只消毒 `role==='tool'` 与 assistant 内嵌的 `tool-result` 输出（text/json 递归），**绝不动 user/system 消息**。

### 用户输入消息：不改写，仅告警

- 用户自己输入的凭证**不改写**（照常发 LLM + 落库，尊重用户意图）。
- `supervisor.submitUserMessage` 用 `detectSecrets` 检测，命中则广播 `AGENT_EVENT_CREDENTIAL_WARNING`（前端 toast 告警）+ Telegram 推送（`telegram.agentCredentialWarning`，受 `enableTelegramNotificationPush` 开关控制）。

### 消毒规则（高精度模式）

`secret-scan.ts` 的 `redactSecrets`/`detectSecrets`，高置信度模式串：私钥块、已知前缀 token（`sk-`/`ghp_`/`AKIA`/`xoxb-`/`ya29.`/`AIza`/`glpat-` 等）、`Authorization: Bearer`、含密码连接串/URL、网络设备 typed 口令（`password 7`/`secret 5`）/`enable secret`/`snmp-server community`。配套负样本单测确保不误伤普通配置/散文。

## 重要权衡：tmex.db 含明文凭证

**`tmex.db` 的 agent 消息表会保存真实的终端/网页内容，可能含明文凭证**——这是「DB 存真实、仅出站 LLM 消毒」的直接后果，目的是保留用户对自己终端历史的完整审计/重放能力。消毒边界**仅止于外部 LLM provider**。因此：数据库文件本身需按敏感数据对待（备份、同步、外泄都可能泄露凭证）。用户输入的凭证更是明文外发 LLM 且落库，仅靠告警知情。

## 验收

- `bun test`（gateway 473 / shared 49）全绿，含 jsx 渲染、system-prompt 组装、`getPaneInfo` 解析与临时 socket integration、注入封装、secret-scan 正负样本、redaction middleware（user/system 不消毒）、supervisor 凭证告警广播。
- `bun build src/index.ts --target bun` 通过（Bun 转译 tsx）。
- 前端 `tsc --noEmit` 通过。
