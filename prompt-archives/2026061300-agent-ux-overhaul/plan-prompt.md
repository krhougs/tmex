# Agent / 前端体验优化 — Prompt 存档

## 初始 prompt

开一个独立的 worktree 干活。进行一些 Agent/前端的使用体验优化：

1. 调用中转后的 gpt 模型时，image_generation 这种 tool 会出现调用错误，检查当前 agent 是否支持 hosted tool 调用。
2. 复现 1 时，tool 调用失败后 agent 卡住，但前端依然显示等待模型输出。预期：tool 调用失败 → 失败信息被模型读取 → LLM 根据实际情况继续干活。
3. 扩展左边 Sidebar，在最上方新增一个切换 Tab，浏览器本地存储 tab 切换状态。
4. 现有左边栏的设备/pane 切换为一个 Tab "Panes"。
5. 删除右边的 Agent Sidebar 并将其中内容合并为左 Sidebar 的 Tab "Agent"。
6. 左 Sidebar 新增 Tab "Files"，内容显示 Coming Soon。

Agent Tab 优化：
1. 提供快速新建会话按钮。
2. 合并"选择或创建一个会话"界面与已创建空 agent session 状态，都显示为"开启新的会话"和正常 agent 输入框，且无内容的新 session 不会被持久化。
3. agent chat 界面支持为 session 单独选择模型，且可在 agent 工作完成后切换模型。
4. agent 支持 steer message 和 message queuing，queue 中的 message 可撤回编辑。

设置页面优化：
1. LLM provider 看起来太乱，应展示为列表。
2. 添加/编辑 llm provider 应为单独的 modal；现有输入框样式有问题，下拉选择框位置和其他 input 不一致，统一排查。
3. 列表中支持快速开启/关闭、刷新模型。
4. 每个 provider 支持手动添加模型和禁用读取到的模型。

## 后续澄清与修正（对话）

- hosted tool：当前需求 image_gen + 内联渲染，但希望无缝兼容任意模型的 hosted tools（可扩展注册表）。
- steer/队列：默认 step 边界注入，也允许用户手动 steer；队列支持编辑撤回。
- 会话仍需绑定 pane。
- 左 Sidebar 宽度已支持拖拽调节（复用）。
- 修正：会话选择器并入现 Pane 选择界面 —— session 作为其绑定 pane 的子分支列在 pane 下，选 session 自动切到对应 tmux pane；Agent 界面"切换 session"则切回 pane tab。
- 新增：需有地方展示 orphan agent session history；history 记录启动 session 时的终端标题 + 进程名 + 时间（旧记录无则前端不显示）；前后端都要屏蔽 orphan agent 的继续输入。
- 要求：main 多次更新 → 每次重新核实 base / run 实现 / AI SDK hosted tool API 等必要内容（已逐项核实，base = 8a168a7，功能基线 143891c）。

最终 plan 见 `plan-00.md`。
