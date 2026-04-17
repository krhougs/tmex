# Prompts — OSC 9/777 通知支持与全 pane 捕获

按时间顺序存档本任务的全部 prompt。后续对话的 prompt 应追加到本文件末尾。

---

## Prompt 1 — 调研问题（起源）

> 对于主流的Coding Agent(Claude Code, Codex, Opencode), 他们是怎么通过终端原生的方式向终端发通知的？iTerm2等终端软件是以收到什么才确定要给用户展示通知的

主要是研究性问题，摸清三大 Coding Agent 的通知机制以及 iTerm2 响应哪些序列（BEL、OSC 9、OSC 777、OSC 1337 等）。对比到 tmex 自身目前只捕获裸 BEL、不解析 OSC，且 `pipe-pane` 只跟随 active pane 的问题。

## Prompt 2 — 需求清单

调研结束后用户选择"扩展 tmex 解析 OSC 9/777"，然后给出九条具体需求：

> 需求：
> 1. 支持OSC9/777
> 2. tmux侧需要处理好passthrough和extended keys
> 3. 检查BEL支持
> 4. BEL和OSC消息分别设置开关
> 5. 保持现在Telegram和网页内分别设置的开关
> 6. 网页内使用sonner这个组件来展示内容，同时console.log打一份作为debug备份
> 7. 只在gateway处理消息，gateway parse到内容再根据设置发给对应接收方式
> 8. 注意处理OSC内的BEL不要当作普通的BEL处理
> 9. 需要保证所有窗口和pane内的消息都能同时被收到

这是实施方案必须完整满足的主需求清单。

## Prompt 3 — Plan 修订

> 不用兼容老前端，然后先存档一下

两点调整：
- 不做 Borsh 老前端兼容（前后端同仓库同版本发布，breaking change 可直接走）
- 实施前先按 AGENTS.md 规则完成归档，然后再动代码

---

（后续新的 prompt 从这里继续追加。）

## Prompt 4 — 执行 Plan（ULTRAWORK）

> prompt-archives/2026041703-osc-notification-support/plan-00.md 执行这个plan

附带运行上下文：本轮通过 `/ulw-loop` 进入 ULTRAWORK 模式，要求直接按既有 `plan-00.md` 执行，并在完成前经过严格验证后再给出完成承诺。

## Prompt 5 — ULTRAWORK 继续执行

> prompt-archives/2026041703-osc-notification-support/plan-00.md 执行这个plan

ULTRAWORK loop 第二轮继续执行，要求在未真正完成前不要停止，并在全部完成后才输出完成承诺。

## Prompt 6 — Oracle 最终完成校验

> prompt-archives/2026041703-osc-notification-support/plan-00.md 执行这个plan

ULTRAWORK verification 阶段要求显式调用 Oracle，对原始任务是否真正完成进行怀疑式审查，并根据 Oracle 结论继续修补缺口后再决定是否可视为完成。
