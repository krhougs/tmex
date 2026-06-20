# Prompt 存档

## 背景
GitHub issue #33：弱网下前端加载慢/白屏。用户明确否定「开压缩」这条路，要求优化包体积本身。

## 用户 prompt（按时间）

1. （triage 后）针对 #33：
   > 检查一下vite和第三方库 开压缩是一个无所谓的事情 但是包大小是应该优化的

2. 批准计划、下达执行方式：
   > 开新的worktree干活

## 交付约束
- 在 git worktree 内实施（分支 `worktree-fe-bundle-size`，基于 main 66afc25 = 含 #32 修复）。
- 先存档，再干活。
- 三套环境规范、严禁触碰生产 tmex（9883 常驻服务、安装目录）；验证用仓内临时实例。
- 不碰生成文件（resources.ts 等）的 lint/手改。
- 不做压缩；聚焦真实体积削减，优先首屏。
- 所有「预计收益」以 bundle visualizer 实测为准，不照搬探查 agent 的估算。

## 计划要点（详见 plan-00.md）
0. 加 rollup-plugin-visualizer 测基线（index.js 基线 1.245MB）。
1. i18n 只加载当前语言（复用 locales/*.json + 动态 backend，gateway 聚合不动）。
2. sidebar AgentTab/FilesTab React.lazy。
3. highlight.js 限定语言（markdown-preview 懒 chunk）。
4. 生产构建关 sourcemap（削 fe-dist 18MB .map）。
- 明确不做：lucide 替换（已摇树）、react-query dedupe（首屏无收益）、manualChunks（利缓存非体积）。
