# Prompt 存档（2026021003-browser-tmux-e2e）

## 背景

用户反馈浏览器端仍然无法正常使用本地 tmux，并出现前端运行时异常：

```
Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')
    at get dimensions (xterm.js?v=02ee3f11:1776:41)
    at t2.Viewport._innerRefresh (xterm.js?v=02ee3f11:821:60)
    at xterm.js?v=02ee3f11:817:150
```

## 用户诉求

请创建 e2e 测试，以确保 **在浏览器中** 可以：

1. 正常连上本地的 tmux。
2. 创建窗口。
3. 删除窗口。
4. 切换窗口。
5. split（创建分屏）。

## 后续对话补充

- 用户：继续。
- 提示：出现多次工具使用警告（`apply_patch` 不应通过 `exec_command` 请求），后续操作需遵循仓库工具规范。
