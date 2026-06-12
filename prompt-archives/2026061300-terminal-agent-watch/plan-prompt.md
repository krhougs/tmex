# Prompt 存档：终端 AI Agent + Watch 监控

## 原始需求（2026-06-13）

> 我想给终端加上Agent功能，Agent可以操作当前终端，我的想法是页面右边栏来当agent用，右边栏顶端切换agent session
> - LLM Provider需要支持OpenAI Completion/Response
> - 需要支持web search 和fetch
> - 需要支持添加多个LLM Provider并自动获取模型列表
> - Agent运行在服务端，页面关闭不影响Agent的工作
> - Agent的生命周期需要考虑终端页面被意外关闭、SSH连接断开等情况
> - Agent panel也和现在的sidebar一样支持自己调宽度、隐藏
> - Agent记录需要持久化
> - 需要有一个watch功能，即用户可以添加一个条件，当终端屏幕内容满足条件时发送通知提醒用户，这个功能和agent session无关
> - 还有什么情况我没想到的你可以帮我想一下

## 补充需求（同日对话中）

> 补充一下 watch需要支持多样本 一个use case 我需要判断下载上传是否卡住超过xx分钟

## 规划期间用户确认的决策

- Agent 循环框架：Vercel AI SDK
- Web search 后端：Tavily / Brave API + Provider 内置搜索（Responses web_search）透传
- 写终端安全策略：每 session 可配置，默认需确认
- Watch 条件：文本正则 + LLM；提供界面让 LLM 生成正则（运行时跑正则）

## 规划期间用户的纠正与补充

1. "SSH 断开不影响"表述有问题——**远程机器挂了连不上就应该失败**（终端工具立即报错、run 以 error 结束并通知，不静默挂起等恢复）。页面关闭不影响 agent 指的是浏览器侧。
2. **每个 watch 规则有独立的模型选择**，模型用途全选：llm 周期判断型规则、触发后 LLM 二次确认、LLM 生成通知摘要、assist-regex 记忆。**模型不可用时需要通知用户，但该告警只发一次**（恢复后重置）。
