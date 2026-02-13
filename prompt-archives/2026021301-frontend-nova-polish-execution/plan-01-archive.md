# Plan 01: 移动端交互/布局/安全区修复 + PC 终端铺满（问题 1-9）

日期：2026-02-13
存档时间：2026-02-13

## 背景
- 当前分支前端已完成"shadcn/ui + Base UI"重构并合并到 `main`。
- 用户在真机（所有手机环境）反馈多个关键可用性问题，涵盖：触摸交互、键盘弹出后的点击、iOS PWA 安全区、以及 PC 终端区域铺满。

## 注意事项
- 运行时：Bun（产品代码避免引入 Node-only 逻辑；Playwright 脚本除外）。
- 禁止猜测：涉及 Base UI / xterm / 浏览器行为，以依赖源码与实测为准。
- iOS PWA：必须处理 safe-area、visualViewport、键盘弹出带来的布局与点击命中问题。
- 本计划仅改前端交互/布局/CSS，不新增后端 API。

## 目标（要修的 9 个问题）
1. 手机 sidebar 右侧出现无意义竖条。
2. 快捷键栏按钮触摸无法触发。
3. xterm 字体略大。
4. 手机键盘弹出后快捷键点按不了，且会触发键盘收起。
5. 设置界面在手机端不可用（点不了/遮挡/结构差三项同时存在）。
6. 编辑器发送按钮可点但无反应。
7. PC 端终端区域右侧留白，且 xterm 字符区域未铺满容器。
8. iOS 底部安全区颜色应与终端背景一致。
9. sidebar 应覆盖安全区空白（背景延伸到底部），而不是被挡住/留白。

## 实施顺序（决策完成）

### Phase 1：先把"点不到"从根上解决（影响 2/4/6/5）
#### 1) 收敛终端路由的 touchmove 拦截范围，避免吞 click
- 文件：`apps/fe/src/layouts/RootLayout.tsx`
- 现状：终端路由在移动端对下滑手势做全局 `preventDefault()`，会取消点击/造成按钮难点。
- 改法（默认选 A）：
  - A. 将这段 touch 拦截逻辑迁移到 `DevicePage`，只绑定在 xterm 输出区域（`terminalRef` 内部的 `.xterm-viewport`），不再对快捷键栏/编辑器/设置页等区域生效。
  - B. 保留在 `RootLayout`，但增加严格白名单：若事件目标位于 `.terminal-shortcuts-strip` 或 `.editor-mode-input` 或任意 `button/a/input/textarea/[role=button]/[data-slot=button]` 祖先节点内，直接 return 不拦截；仅对 xterm 输出区且 `deltaY` 超阈值时拦截。
- 验收：键盘弹出时，快捷键与发送按钮点击成功率接近 100%，且不会"像没点到"。

### Phase 2：Sidebar 竖条 + 安全区覆盖（解决 1/9）
#### 2) 移动端隐藏 Base UI ScrollArea 自绘 scrollbar（去掉右侧竖条）
- 文件：`apps/fe/src/components/ui/scroll-area.tsx`
- 改法：在 ScrollBar root class 增加 `[@media(any-pointer:coarse)]:hidden`，移动端完全不渲染轨道；桌面端保留现有 scrollbar。
- 验收：手机 sidebar 右边缘不再出现"像 padding 的竖条"。

#### 3) Sidebar 背景延伸覆盖底部安全区
- 文件：`apps/fe/src/index.css`、`apps/fe/src/components/Sidebar.tsx`
- 改法：
  1. 新增 CSS 变量：`--tmex-safe-area-bottom`：
     - `:root { --tmex-safe-area-bottom: 0px; }`
     - `html[data-tmex-standalone="1"] { --tmex-safe-area-bottom: env(safe-area-inset-bottom); }`
  2. 给 Sidebar 根 `<aside>` 增加类 `tmex-sidebar-safe-cover`：
     - `padding-bottom: var(--tmex-safe-area-bottom);`
     - `background: var(--sidebar);`
  3. 现有 `tmex-sidebar-bottom-safe-*` 继续保留，仅用于内容内边距，不负责背景覆盖。
- 验收：打开 sidebar sheet 后底部不留白，背景吃满 home indicator 区域。

### Phase 3：终端快捷键/编辑器按钮"键盘弹出也能点且不收键盘"（解决 2/4/6）
#### 4) 快捷键栏与编辑器按钮统一"保焦点 pointerdown 策略"
- 文件：`apps/fe/src/pages/DevicePage.tsx`、`apps/fe/src/index.css`
- 改法：
  1. 给 editor textarea 增加 `ref`（例如 `editorTextareaRef`）。
  2. 对以下按钮统一加 `onPointerDown(e => e.preventDefault())`：
     - 快捷键按钮
     - 发送/逐行发送/清空按钮
  3. 在 `onClick` 后（仅移动端 + editor 模式），主动恢复 focus 到 textarea：`editorTextareaRef.current?.focus({ preventScroll: true })`。
  4. `.terminal-shortcuts-strip` 继续支持横向滚动，但按钮优先 click：
     - 容器 `touch-action: pan-x; -webkit-overflow-scrolling: touch;`
     - 按钮 `touch-action: manipulation;` 且移动端按钮最小高度提升到 40px+。
- 验收：键盘弹出后点击快捷键会触发发送且键盘不收起；点击发送按钮不再"无反应"。

#### 5) 编辑器发送按钮失败不可静默
- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 改法：
  - 在 `handleEditorSend/handleEditorSendLineByLine` 开头：
    - 若 `!canInteractWithPane`：toast 明确提示（当前 Pane 不可交互/等待连接/重新选择）。
    - 若文本为空：不发送（保持现状）。
  - 点击发送后按钮短暂 loading（150-250ms）用于确认触发成功（不依赖后端 ACK）。
- 验收：不会再出现"点了但不确定有没有发"的状态。

#### 6) xterm 字体微调
- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 改法：`fontSize` 从 14 调整到 13。
- 验收：字体小一档且不影响 Fit/列宽。

### Phase 4：PC 端终端铺满（解决 7）
#### 7) 将 xterm `fit()` 与"是否可交互"解耦
- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 改法：
  1. 新增一个"始终启用"的 ResizeObserver 监听 `terminalRef`：仅做 `fitAddon.fit()`。
  2. 只有当 `canInteractWithPane` 为 true 时，才执行 `reportPaneSize(sync/resize)` 同步 cols/rows 到后端。
- 验收：PC 端连接前后、sidebar 折叠/展开都能铺满，终端右侧无留白。

### Phase 5：iOS 底部安全区颜色与终端背景一致（解决 8）
#### 8) 终端路由下增加"底部安全区终端底色填充层"
- 文件：`apps/fe/src/index.css`、`apps/fe/src/layouts/RootLayout.tsx`
- 改法：
  1. 定义 `.tmex-safe-area-bottom-fill-terminal`：
     - `position: fixed; left: 0; right: 0; bottom: 0; height: var(--tmex-safe-area-bottom);`
     - `background: var(--tmex-terminal-surface);`
     - `pointer-events: none;`
     - `z-index` 低于交互 UI、高于 shell 背景。
  2. `RootLayout` 中：当 `isMobile && isTerminalRoute` 时渲染该 div。
- 验收：iOS home indicator 区域颜色与终端背景一致，不再露出 shell 渐变或背景色。

### Phase 6：设置页移动端可用性重构（解决 5）
#### 9) 设置页改为 Tabs 分区 + 移动端触达标准
- 文件：`apps/fe/src/pages/SettingsPage.tsx`（必要时联动 `apps/fe/src/components/ui/select.tsx`）
- 改法（固定决策）：
  1. 使用 `Tabs` 拆为 4 个页签：站点 / 通知 / Telegram / Webhook。
  2. 每个页签内部：
     - 控件行高 >= 40px；
     - 行内 switch 与文字分离，整行可点或 switch 周围留足间距；
     - "保存/刷新"放在对应页签末尾并全宽（移动端）。
  3. Select 弹层移动端可用：
     - `SelectContent` max-height 绑定 `--tmex-viewport-height`，避免被键盘/顶部栏遮挡；
     - portal z-index 与 header/sheet 不冲突。
  4. 信息密度：移动端默认紧凑但可读，避免一屏堆满不可操作。
- 验收：手机上 settings 所有主要操作都能完成，不再出现"控件点不了/遮挡/找不到入口"。

## 测试计划
### Playwright E2E（新增/更新）
- 新增：`apps/fe/tests/mobile-terminal-interactions.spec.ts`
  - 移动视口下 editor focus 后，点击快捷键/发送按钮：验证触发且不 blur、不收键盘（`document.activeElement` + mock ws/assert 请求）。
- 新增：`apps/fe/tests/mobile-sidebar-safe-area.spec.ts`
  - sidebar 打开后：无 scrollbar 竖条；sidebar 背景覆盖到底部安全区。
- 新增/更新：`apps/fe/tests/mobile-settings.spec.ts`
  - 切 tab、点 switch、开 select、保存站点设置、webhook 增删（telegram 可 mock）。
- 更新现有 spec 以适配 settings 结构变化与终端按钮交互变化。

### 构建/回归
- `bun run --filter @tmex/fe build`
- `bun run --filter @tmex/fe test:e2e`

## 验收标准（最终）
- sidebar：竖条消失；背景覆盖安全区到底部。
- 终端（移动）：键盘弹出后快捷键可点可连点，不收键盘；编辑器发送不再"无反应"，失败有提示。
- 终端（PC）：无右侧留白，xterm 字符区铺满。
- iOS：终端页底部安全区颜色与终端背景一致。
- settings：手机端可点、可滚、无遮挡、结构清晰，能完成所有核心配置与管理操作。

## 默认取值/约束
- xterm `fontSize = 13`。
- 移动端（coarse pointer）隐藏 Base UI ScrollArea 自绘 scrollbar。
- 不新增后端 API；不依赖动态修改 `meta theme-color`，使用页面内安全区填充层实现一致色。
