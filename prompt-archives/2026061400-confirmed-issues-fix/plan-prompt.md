# Prompt 存档 — 修复 4 个 confirmed issue（#10/#11/#15/#16）

## 背景

用户要求批量处理 GitHub 仓库 `krhougs/tmex` issue 区中所有标记为 `confirmed` 的需求。任务在 ultracode 模式（xhigh + 动态 workflow 编排）下执行：通过多 agent workflow 勘探代码、产出实现设计，再分依赖顺序逐 issue 修复。

## 原始 prompt 序列

1. 「检查当前项目的issue区，确认所有标记为confirmed的需求，先不要干活。」
   - 结果：找到 4 个 confirmed issue —— #16 体验优化、#15 设置界面优化、#11 theme 开关意义不明确、#10 应该支持从终端打开链接。

2. （切换到 `/effort` = ultracode）「分析dependency安排全部修复，修好的commit直接关对应issue」
   - 进入 Plan Mode，跑勘探 + 设计 workflow，产出计划。

3. Plan Mode 中的澄清问答（AskUserQuestion）与用户决策：
   - **交付方式**：新建单个 git worktree + 4 个 commit（各含 `Closes #N`）+ 1 个 PR。
   - **#16 创建默认值**：创建时也强校验必填，但把当前 placeholder 里的内容自动预填好（username→root、ssh config→~/.ssh/config、port→22；host 不预填仅作占位提示）。
   - **#16 Modal 重构力度**：针对性现代化，保留现有分区结构。
   - **#10 Markdown 部分**：以终端链接为主；Markdown 链接（assistant 消息 + 文件预览）经核查 remark-gfm 已渲染超链接，以实测验证为主，确认工作则不改。

## 执行约束（来自 AGENTS.md / 记忆）

- 严禁触碰本机生产 tmex（9883/launchd/安装目录），验证只在仓库内起临时实例并显式覆盖端口/env。
- 简体中文交流；i18n 生成物（resources.ts/types.ts）禁止手改/lint，靠 `bun run build:i18n` 重建。
- 先存档，再干活。
- commit message：conventional 前缀 + 简体中文 + 脚注 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

## 修复顺序

#11（纯 i18n 文案）→ #10（ghostty-terminal 终端链接）→ #16（设备体验 + Modal）→ #15（设置界面重排，最大）。
