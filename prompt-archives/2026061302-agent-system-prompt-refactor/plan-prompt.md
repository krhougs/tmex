# Prompt 存档：Agent System Prompt 重构

## 第一轮 prompt

> 当前项目的agent是如何管理系统提示词的？

（调查结论：`apps/gateway/src/agent/prompts.ts` 的 `buildAgentSystemPrompt()` 用数组 + join 硬拼四段。）

## 第二轮 prompt（重构需求）

> 做的太粗糙，我们需要：
> 0. system prompt文本应该有单独的文件管理
> 1. 使用正常的模板引擎方便后续inject更多有用的内容，我倾向于使用类JSX的方式。
> 2. 提示词中需要注入当前tmux环境的一些基础信息（操作系统、shell、时区、时间、网络IP）之类的，并且需要告诉agent要时刻知悉当前窗口大小避免理解错TUI（这个要实时拿，不要inject）
> 3. Agent大概率会运行在macOS和Linux的shell环境中，但是shell大概率会连接到远程的服务器，因此需要让LLM去倾向于查找当前shell相关的能力
> 4. 这个产品有很多客户会操作网络设备，提示词需要倾向于知晓/搜索计算机网络常识和常见网络设备的操作方式（mikrotik h3c 思科 华为 juniper 锐捷 fortinet paloalto），非常见网络设备的shell要么是类似思科风格的cli要么是非常原始的linux shell
> 5. 用户提供需求后应该配合环境和用户输入理解意图，如果你认为缺少关键信息，需要停下来找用户确认
> 6. 我们的大部分用户安全意识薄弱，需要提供必要的科普和警告

## 后续澄清

> 看看bun自身的能力能不能满足我们的需求 https://bun.com/docs/runtime/jsx

→ 核实 Bun 原生支持 classic JSX 工厂（`jsx`/`jsxFactory`/`jsxFragmentFactory` + per-file pragma），自研极简 `h`/`Fragment` 文本工厂即可，零依赖。

> 还有一个问题，就是屏幕上的内容可能会引导agent做坏事，得做一下必要injection防护

→ 增加 prompt-injection 防护：结构层（屏幕/网页内容标注为不可信数据）+ 指令层（绝不把数据当指令执行，可疑诱导上报用户）。

> 还有一个问题就是用户屏幕上会有credential，用户自己也会输入credential，得做好必要的消毒

→ 增加凭证消毒。经澄清确定**不对称策略**：
- 机器来源内容（屏幕/网页）消毒；用户输入不改写、仅 UI+推送告警「数据可能泄露」。
- 消毒边界拆开：**DB 存真实、仅出站 LLM 消毒**。

> "在「发给 LLM 前」和「落库前」统一在工具返回处拦截。" 这个表述有问题，我觉得你需要问一下怎么处理

→ 指出工具返回单点会让 DB 与 LLM 都变 masked。澄清后用户选「拆开：DB 存真实、仅出站 LLM 消毒」。技术落点：AI SDK `wrapLanguageModel` + `transformParams` 在 provider 出站边界消毒（覆盖 run 内回喂 + 跨轮回放，按 role 跳过 user/system），工具返真实、落库真实。已用 context7 核实 middleware API。

## 关键决策汇总（AskUserQuestion）

- 实时窗口尺寸：**两者都做**（read_screen/send_input 带 cols/rows + 新增 get_pane_info 工具）。
- 环境注入：**入口事实 + 探测引导**。
- 网络 IP：**不注入，引导探测**。
- 凭证消毒范围：**落库前 / 用户输入消息 / 发给 LLM 前**；用户输入不干预只告警。
- 消毒边界：**拆开，DB 存真实、仅出站 LLM 消毒**。

## 备注

完整设计见同目录 `plan-00.md`。
