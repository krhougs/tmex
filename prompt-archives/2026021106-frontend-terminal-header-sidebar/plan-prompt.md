# Prompt Archive

时间：2026-02-11
目录：2026021106-frontend-terminal-header-sidebar

## 用户原始需求

我们现在需要对前端做一些大的改动：
1. 无论是移动端顶栏、PC顶栏、PC sidebar顶栏，高度均缩小并调整到同一高度
2. 浏览器标题在进入了终端的情况下，应展示`[tmex]${paneIdx}/${windowNameWithIdx}@${deviceName}`，如 '[tmex]Pane 0/2: node@local'
3. 删除"同步尺寸"按钮，增加"跳转到最新"按钮
4. 手机端顶栏直接显示`${paneIdx}/${windowNameWithIdx}@${deviceName}`，如 'Pane 0/2: node@local'
5. 编辑器切换在PC上也应该能用
6. PC右侧顶栏展示和手机端顶栏相同的内容
7. sidebar高亮逻辑调整：当device中的某个pane被选择时，（第一层）整个device tree会有一个15%透明度高亮色的背景，（第二层）整个被选中的window tree再叠加15%透明度高亮色的背景，（第三层）被选中的pane拥有90%透明度高亮色的背景

## 需求澄清结论

1. 顶栏统一高度：`44px`
2. “跳转到最新”行为：仅滚动到终端底部，不触发额外同步请求
3. `windowNameWithIdx`：`{windowIdx}: {windowName}`
4. 手机端保留汉堡菜单按钮
5. sidebar 折叠态只保留设备层 15% 高亮
6. 标题中的 `deviceName` 使用设备 `name`，缺失时回退 `id`

## 执行指令

Implement the plan.
