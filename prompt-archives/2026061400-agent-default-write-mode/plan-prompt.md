# Prompt 存档

## 需求

> Confirm writes 开关应该永远显示，且这个需要在浏览器上记忆，用来当做新 session 的默认值
>
> 对，也就是说，在 session 创建之前，这个开关也应该工作，并影响新 session 的行为

## 解读

Agent 聊天输入区的 "Confirm writes"(writeMode auto/confirm)开关：

1. **常驻显示**：当前仅在 `activeSession` 存在时渲染，要改成永远显示（draft / 空会话也显示）。
2. **浏览器记忆**：开关状态持久化到 localStorage（zustand persist），作为「默认写入模式」。
3. **作为新 session 默认值**：在没有 session 时，开关控制这个持久化默认值；新建 session 时用它作为初始 `writeMode`，从而在「session 创建之前」就影响新 session 行为。
