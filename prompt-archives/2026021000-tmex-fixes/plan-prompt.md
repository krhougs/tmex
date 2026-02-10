# Tmex 修复计划 Prompt

修复 4 个问题：
1. 本地 tmux 报错 `tcgetattr failed: Inappropriate ioctl for device`
2. 前端连接失败的错误提示用户体验太差
3. 设备管理缺少 session 字段
4. 前端 UI 改进（使用 `@base-ui/react` 和 `shadcn/ui`）

执行顺序建议：
1. 先修复问题 1（tmux 错误）- 影响基础功能
2. 然后修复问题 3（session 字段）- 涉及数据库 schema 变更
3. 接着修复问题 2（错误提示 UX）- 依赖问题 3 的结构
4. 最后修复问题 4（UI 改进）- 主要是样式层面

详见 plan-00.md
