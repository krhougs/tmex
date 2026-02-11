# Plan 00：Terminal 尺寸时序、历史保真与闪烁回归修复

时间：2026-02-11

## 背景

近期 Terminal 链路出现复合回归：

1. pane 进入后历史加载时机早于尺寸同步，导致历史换行基于旧尺寸。
2. 历史抓取未保留 ANSI 属性，导致颜色丢失。
3. 前端容器布局与 fit 策略不稳定，导致 xterm 高度不满、宽度溢出。
4. 历史回放与实时输出交错时存在 reset 覆盖，造成 TUI 闪烁。

## 目标

1. 首次进入 pane 时，先完成 tmux client 尺寸同步，再触发历史抓取。
2. 新打开 pane 的历史记录保留颜色，并改善长行换行错乱。
3. TUI 不再因历史覆盖实时输出而闪烁。
4. xterm 在右侧区域稳定铺满，浏览器 resize 能触发 tmux 尺寸同步。

## 实施任务

### 任务 1：调整时序（先尺寸后历史）

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 内容：在 pane 激活时先 `fit + syncPaneSize`，再发送 `selectPane`，并保留后续 resize 兜底。

### 任务 2：历史抓取保留颜色与折行语义

- 文件：`apps/gateway/src/tmux/connection.ts`
- 内容：`capture-pane` 改为包含 `-e -J -p`，保留 ANSI 并合并 wrap 行。

### 任务 3：历史回放策略改为实时优先

- 文件：`apps/fe/src/pages/DevicePage.tsx`
- 内容：去除 history 应用阶段 `reset` 与强制换行，仅在未收到实时输出时应用历史。

### 任务 4：xterm 容器与自动同步修复

- 文件：
  - `apps/fe/src/pages/DevicePage.tsx`
  - `apps/fe/src/index.css`
- 内容：修复容器 `fit-content/overflow` 造成的撑满与溢出问题；统一 resize 触发并增加防抖与尺寸去重。

### 任务 5：验证与回归测试

- 运行构建、单测与定向 e2e，验证历史显示、尺寸同步、交互稳定性。

## 注意事项

- 保持“实时优先”历史策略，不引入额外协议类型。
- 不做无关模块重构，聚焦终端链路根因修复。
- 以最小改动达成可验证修复结果。
