# Prompt Archive

时间：2026-02-11
目录：2026021107-mobile-topbar-terminal-label-shortcuts

## 用户需求（原始）

现在需要做如下改进:
1. 移动端顶栏应该固定在最上方，且只存在一行，其中只包括：侧边栏切换按钮、当前终端字符串、操作按钮
2. 标题栏、pc顶栏、手机顶栏的当前终端字符串格式改为：`${windowId}/${paneIdx}: ${paneTitle}@{deviceName}`，如'2/0: zsh@local'
3. 编辑器中加入一排常用快捷键 CTRL+C ESC CTRL+D SHIFT+ENTER

## 后续澄清

1. `windowId` 应该是 window index，请把变量改成 `windowIdx`。
2. 快捷键直接发送，不需要确认。
3. `paneTitle`：优先 pane 名，缺失回退 window.name。
4. 移动端顶栏右侧操作区使用两个无文字图标按钮（编辑器切换 + 跳转到最新）。
5. “标题栏”指浏览器标签标题 `document.title`。

## 执行指令

Implement the plan.
