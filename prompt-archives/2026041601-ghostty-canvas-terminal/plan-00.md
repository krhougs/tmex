# Ghostty Canvas Terminal + SOTA Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> 分支：`ghostty-wasm-terminal`
> 归档目录：`prompt-archives/2026041601-ghostty-canvas-terminal/`

**Goal:** 将当前 Ghostty wasm 终端从 HTML/DOM formatter 渲染彻底升级为基于 Ghostty render-state 的 Canvas 终端，同时一次性补齐高质量选区、复制、自动滚动、资源释放和性能治理能力。

**Architecture:** 终端语义仍由 Ghostty wasm 负责，前端放弃 HTML formatter 主渲染路径，改用 `render_state -> row iterator -> row cells` 读取 viewport 状态，构建一套 Canvas 主渲染器和选区引擎。React 页面层继续依赖稳定的 `TerminalRef` / store / ws-borsh contract，渲染器、选区、内存生命周期都封装在 `packages/ghostty-terminal` 内部。

**Tech Stack:** Bun、React、TypeScript、Ghostty wasm、Canvas 2D、ResizeObserver、Clipboard API、Playwright E2E。

---

## Context

当前实现已经完成 Ghostty wasm 底座迁移，但渲染仍位于 DOM 时代的兼容层：

- `packages/ghostty-terminal/src/terminal.ts` 每次渲染调用 `formatViewport(... HTML)` 和 `formatViewport(... PLAIN)`；
- 终端可交互，但平滑度、分配成本、选区能力和资源回收上限都被 DOM formatter 路径限制；
- `vendor/ghostty` 已锁定 submodule，可继续在该版本上扩展 wasm 绑定；
- `apps/fe` 已通过 `@tmex/ghostty-terminal` 接入，页面层迁移面可控。

本计划默认采用“全量升级”策略，不再保留 DOM formatter 作为长期主路径。若需要保留灰度回退，仅作为临时调试开关存在，不能影响最终架构。

## 方案比较

### 方案 A：继续保留 HTML formatter，做 DOM 微优化

优点：

- 改动最小；
- 回归风险较低。

缺点：

- 仍然无法摆脱字符串分配和 DOM 更新瓶颈；
- 选区高质量能力很难做；
- 清理和内存治理仍然受限。

结论：不采用。

### 方案 B：仍用 formatter，但把 HTML 或 plain 输出翻译为 Canvas draw calls

优点：

- 能得到 Canvas 外观；
- 可以减少部分 DOM 更新。

缺点：

- 仍然依赖 formatter 大字符串分配；
- dirty row / cursor / cell style 读取不自然；
- 等于把错误抽象层继续往下拖。

结论：不采用。

### 方案 C：基于 Ghostty render-state 实现原生 Canvas 渲染器

优点：

- 官方能力面完整，支持 dirty row 增量重绘；
- 可直接读取 cell / style / cursor / palette；
- 更适合做高质量选区、复制和生命周期管理；
- 渲染层与终端语义分层清晰。

缺点：

- 初始开发量更大；
- 需要新增一套 render-state wasm 绑定与 Canvas renderer。

结论：采用此方案。

## 非目标

- 不改 gateway / ws-borsh 协议；
- 不引入第三方终端渲染库；
- 不在本轮实现 WebGL renderer；
- 不做“先接一版简单 Canvas、再重做”的两次迁移。

## 设计原则

1. 以 Ghostty render-state 作为唯一渲染数据源。
2. 选区、复制、自动滚动、命中测试与渲染层同步设计，不拆成事后补丁。
3. 生命周期必须显式管理：wasm 句柄、Canvas 资源、事件监听、RAF、ResizeObserver、selection overlay 都要可追踪释放。
4. 先用 TDD 锁定行为，再改实现。
5. 页面层 API 尽量稳定，复杂度收敛在 `packages/ghostty-terminal`。

## 实施任务

### Task 1：先锁定当前行为与目标行为的测试基线

**Files:**
- Modify: `apps/fe/tests/terminal-ui.spec.ts`
- Modify: `apps/fe/tests/terminal-viewport-render.spec.ts`
- Create: `apps/fe/tests/terminal-selection-canvas.spec.ts`
- Create: `packages/ghostty-terminal/src/terminal.canvas.test.ts`

**Step 1: 写失败测试，覆盖 Canvas 渲染切换信号**

新增断言：

- 终端实例暴露新的渲染器标识，例如 `__tmexE2eTerminalRenderer === 'canvas'`
- 屏幕主体为 `<canvas>` 而不是 `.xterm-screen.innerHTML`

**Step 2: 写失败测试，覆盖选区能力**

新增至少以下 E2E：

- 拖拽选择可见文本
- 双击按词选择
- 三击按整行选择
- 向上拖出 viewport 触发自动滚动扩选
- 复制得到与可见选择一致的文本
- 切 pane / 重连 / resize 后选区正确清空或重建

**Step 3: 写失败测试，覆盖清理和回收**

新增包级或浏览器级断言：

- terminal dispose 后不再触发 RAF
- event listener / observer / hidden textarea 不残留
- 切 pane 多次不会重复累积 renderer 资源

**Step 4: 运行定向测试并确认失败原因正确**

Run:

```bash
bun run test:e2e tests/terminal-selection-canvas.spec.ts
bun test packages/ghostty-terminal/src/terminal.canvas.test.ts
```

Expected：失败点明确指向“当前仍为 DOM formatter 路径”或“选区/清理能力未实现”。

**Step 5: Commit**

```bash
git add apps/fe/tests/terminal-ui.spec.ts apps/fe/tests/terminal-viewport-render.spec.ts apps/fe/tests/terminal-selection-canvas.spec.ts packages/ghostty-terminal/src/terminal.canvas.test.ts
git commit -m "test: lock canvas terminal and selection behavior"
```

### Task 2：扩展 Ghostty wasm 绑定到 render-state API

**Files:**
- Modify: `packages/ghostty-terminal/src/ghostty-wasm.ts`
- Modify: `packages/ghostty-terminal/src/types.ts`
- Create: `packages/ghostty-terminal/src/render-state.ts`

**Step 1: 写失败测试，覆盖 render-state 基础绑定**

测试内容：

- 能创建 / 更新 / 释放 render state
- 能读取 dirty state、rows、cols、palette、cursor 数据
- 能复用 row iterator 和 row cells 句柄
- dispose 后重复 free 不崩

**Step 2: 实现最小绑定**

补齐官方导出：

- `ghostty_render_state_new/free/update/get/get_multi/set/colors_get`
- `ghostty_render_state_row_iterator_new/free/next/get/set`
- `ghostty_render_state_row_cells_new/free/next/select/get/get_multi`

**Step 3: 增加 JS 侧安全包装**

提供高层 API：

- `createRenderState()`
- `updateRenderState()`
- `readRenderSnapshotMeta()`
- `iterateRows()`
- `iterateCells()`
- `disposeRenderStateResources()`

要求：

- 严格管理 iterator / cells 生命周期
- 不把裸指针暴露到 React 层
- 每次 update 后禁止复用旧 snapshot 引用

**Step 4: 运行测试并确认通过**

Run:

```bash
bun test packages/ghostty-terminal/src/terminal.canvas.test.ts
```

**Step 5: Commit**

```bash
git add packages/ghostty-terminal/src/ghostty-wasm.ts packages/ghostty-terminal/src/types.ts packages/ghostty-terminal/src/render-state.ts packages/ghostty-terminal/src/terminal.canvas.test.ts
git commit -m "feat: add ghostty render-state wasm bindings"
```

### Task 3：实现 Canvas 主渲染器与帧调度

**Files:**
- Create: `packages/ghostty-terminal/src/canvas-renderer.ts`
- Modify: `packages/ghostty-terminal/src/terminal.ts`
- Modify: `packages/ghostty-terminal/src/types.ts`

**Step 1: 写失败测试，覆盖基础渲染能力**

测试内容：

- 初次输出后 Canvas 可见
- dirty=false 时不会重复重绘
- dirty=partial 时只重绘脏行
- cursor 可见且位置正确
- 主题切换后前景/背景/光标颜色更新

**Step 2: 实现渲染器层**

渲染器最小模块拆分：

- 主 Canvas：文本与背景
- 选区 Overlay Canvas：高亮与选区句柄
- 可选 Cursor Layer：独立绘制光标，便于闪烁和局部更新

关键设计：

- 以 `devicePixelRatio` 做 HiDPI 缩放
- 使用单一 RAF 调度器合并写入、滚动、resize、主题更新
- 维护行级 dirty bitmap，避免整屏重绘
- 字体度量、字符宽度、颜色解析走缓存

**Step 3: 完成文本绘制**

实现：

- 单格背景绘制
- grapheme 文本绘制
- 宽字符 / combining grapheme 处理
- style 到 Canvas font / fillStyle 映射
- 反色、粗体、斜体、下划线等常见样式映射

**Step 4: 完成 cursor 绘制**

支持：

- block / hollow block / bar / underline
- 光标显隐、闪烁、密码输入状态分支
- 最小局部重绘

**Step 5: 运行测试并确认通过**

Run:

```bash
bun test packages/ghostty-terminal/src/terminal.canvas.test.ts
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 bun run test:e2e tests/terminal-viewport-render.spec.ts
```

**Step 6: Commit**

```bash
git add packages/ghostty-terminal/src/canvas-renderer.ts packages/ghostty-terminal/src/terminal.ts packages/ghostty-terminal/src/types.ts
git commit -m "feat: render ghostty terminal via canvas"
```

### Task 4：重做选区引擎与命中测试

**Files:**
- Create: `packages/ghostty-terminal/src/selection-model.ts`
- Create: `packages/ghostty-terminal/src/selection-clipboard.ts`
- Modify: `packages/ghostty-terminal/src/terminal.ts`
- Modify: `packages/ghostty-terminal/src/render-state.ts`
- Modify: `apps/fe/tests/terminal-selection-canvas.spec.ts`

**Step 1: 写失败测试，覆盖选区模型**

至少覆盖：

- 单击定位光标不生成选区
- 拖拽生成普通线性选区
- 双击按词扩展
- 三击按行扩展
- Shift + 拖拽扩展已有选区
- 鼠标拖到顶部 / 底部时自动滚动扩选
- viewport 改变后选区依然绑定正确 grid 区间
- alt/option 矩形选区策略如决定支持，则单独加测试

**Step 2: 实现数据模型**

选区必须同时存储：

- terminal/grid 层范围
- viewport 投影范围
- 选择模式：character / word / line / block
- anchor / focus / direction
- 可复制的规范化文本

**Step 3: 实现命中测试**

基于 cell metrics + render snapshot：

- pointer -> viewport cell
- grapheme cluster 边界对齐
- 宽字符命中归一
- 超出 viewport 时边界钳制

**Step 4: 实现选区绘制与复制**

支持：

- overlay 高亮绘制
- `selectionBackground` 主题映射
- `copy` / `Ctrl+C` / 右键复制语义
- 空选区时不劫持终端输入
- 复制文本按终端行/换行规则序列化

**Step 5: 实现自动滚动扩选**

要求：

- 拖拽超出顶部 / 底部时触发节流滚动
- 与 Ghostty viewport scroll API 协同
- 不产生 runaway RAF / timer

**Step 6: 运行测试并确认通过**

Run:

```bash
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 bun run test:e2e tests/terminal-selection-canvas.spec.ts tests/terminal-ui.spec.ts
```

**Step 7: Commit**

```bash
git add packages/ghostty-terminal/src/selection-model.ts packages/ghostty-terminal/src/selection-clipboard.ts packages/ghostty-terminal/src/terminal.ts packages/ghostty-terminal/src/render-state.ts apps/fe/tests/terminal-selection-canvas.spec.ts
git commit -m "feat: add canvas selection engine"
```

### Task 5：整合输入、滚动、resize 与无障碍/兼容层

**Files:**
- Modify: `packages/ghostty-terminal/src/terminal.ts`
- Modify: `apps/fe/src/components/terminal/Terminal.tsx`
- Modify: `apps/fe/src/components/terminal/types.ts`
- Modify: `apps/fe/src/components/terminal/useTerminalResize.ts`

**Step 1: 写失败测试，覆盖交互回归**

覆盖：

- direct input / IME / paste
- wheel scroll / touch scroll
- resize 后渲染稳定
- pane 切换后 terminal focus 与 selection 状态正确

**Step 2: 实现输入兼容**

保留隐藏 `textarea`，但更新职责：

- 只负责输入焦点、IME、clipboard 事件
- 不再参与文本渲染
- 与选区 copy / clear 逻辑协调

**Step 3: 实现滚动条与 viewport 同步**

至少保证：

- wheel / touchpad / mobile touch 行为正常
- scrollToTop / scrollToBottom / scrollLines 与 Ghostty viewport 同步
- selection auto-scroll 不打断普通滚动

**Step 4: 保持页面层 contract**

继续兼容：

- `TerminalRef`
- `FitAddon`
- `_core._renderService.dimensions.css.cell`
- E2E 探针

**Step 5: 运行相关测试**

Run:

```bash
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 bun run test:e2e tests/terminal-ui.spec.ts tests/mobile-terminal-interactions.spec.ts tests/ws-borsh-resize.spec.ts
```

**Step 6: Commit**

```bash
git add packages/ghostty-terminal/src/terminal.ts apps/fe/src/components/terminal/Terminal.tsx apps/fe/src/components/terminal/types.ts apps/fe/src/components/terminal/useTerminalResize.ts
git commit -m "feat: integrate canvas terminal with app runtime"
```

### Task 6：做彻底的清理、内存和生命周期治理

**Files:**
- Modify: `packages/ghostty-terminal/src/terminal.ts`
- Modify: `packages/ghostty-terminal/src/canvas-renderer.ts`
- Modify: `packages/ghostty-terminal/src/render-state.ts`
- Create: `packages/ghostty-terminal/src/terminal.lifecycle.test.ts`

**Step 1: 写失败测试，覆盖资源释放**

覆盖：

- `dispose()` 后 render state / iterator / cells / terminal / key encoder 全释放
- RAF、setTimeout、selection auto-scroll loop、ResizeObserver、AbortController 全停止
- DOM 节点移除后不再残留闭包引用
- 重复创建 / 销毁不增长未释放资源计数

**Step 2: 实现生命周期框架**

要求：

- 所有监听统一由 `AbortController` 或集中 disposable registry 管理
- renderer 资源统一挂入 `disposeStack`
- wasms handle free 顺序固定并幂等
- 主题切换 / resize / pane 切换不泄漏离屏缓存

**Step 3: 做性能兜底**

包括：

- glyph / font / color cache 的上限与清空策略
- selection overlay 脏区更新
- 高 DPI 变化时重建 canvas backing store
- 背压控制，避免写入高频时堆积多个 render job

**Step 4: 运行测试**

Run:

```bash
bun test packages/ghostty-terminal/src/terminal.lifecycle.test.ts packages/ghostty-terminal/src/terminal.canvas.test.ts
```

**Step 5: Commit**

```bash
git add packages/ghostty-terminal/src/terminal.ts packages/ghostty-terminal/src/canvas-renderer.ts packages/ghostty-terminal/src/render-state.ts packages/ghostty-terminal/src/terminal.lifecycle.test.ts
git commit -m "fix: harden canvas terminal lifecycle and memory cleanup"
```

### Task 7：全量回归、文档与结果归档

**Files:**
- Modify: `docs/terminal/2026041600-ghostty-wasm-runtime.md`
- Create: `docs/terminal/2026041601-ghostty-canvas-terminal.md`
- Create: `prompt-archives/2026041601-ghostty-canvas-terminal/plan-00-result.md`

**Step 1: 更新文档**

补充：

- Canvas 渲染链路
- render-state 数据流
- 选区模型
- 生命周期与资源释放
- 已知限制与调试入口

**Step 2: 运行完整验证**

Run:

```bash
bun test apps/gateway/src/tmux-client/*.test.ts apps/gateway/src/tmux-client/*.integration.test.ts
bun run --filter @tmex/gateway build
bun run --filter @tmex/fe build
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 bun run test:e2e tests/terminal-ui.spec.ts tests/terminal-viewport-render.spec.ts tests/terminal-selection-canvas.spec.ts tests/ws-borsh-history.spec.ts tests/ws-borsh-resize.spec.ts tests/mobile-terminal-interactions.spec.ts
```

**Step 3: 记录结果归档**

`plan-00-result.md` 必须包含：

- 通过的命令
- 失败/跳过项
- 剩余风险
- 后续建议

**Step 4: Commit**

```bash
git add docs/terminal/2026041600-ghostty-wasm-runtime.md docs/terminal/2026041601-ghostty-canvas-terminal.md prompt-archives/2026041601-ghostty-canvas-terminal/plan-00-result.md
git commit -m "docs: record canvas terminal architecture and verification"
```

## 风险与处置

1. `render_state` API 的 JS 绑定复杂度明显高于 formatter。
   处置：先用最小高层包装收敛裸指针，再在包内隐藏所有 handle。

2. Canvas 文本渲染在不同平台字体度量可能存在波动。
   处置：严格依赖现有 font metrics 逻辑，E2E 中用更稳健的 viewport/selection 断言。

3. 选区命中在宽字符、combining grapheme、scrolling viewport 下容易出错。
   处置：命中测试一律建立在 Ghostty cell/grapheme 数据上，不自己猜测文本边界。

4. 自动滚动扩选和普通滚动可能互相打架。
   处置：单独抽一个 selection auto-scroll scheduler，明确优先级和停止条件。

5. 资源释放做不彻底会在切 pane 高频场景下泄漏。
   处置：生命周期测试必须在第一轮实现后持续回归，不允许后置。

6. “SOTA” 很容易被理解成无限扩 scope。
   处置：本计划中的 SOTA 定义为“当前 tmex 业务内最优、可验证、可维护”，不追求一次性覆盖所有桌面终端花式特性。

## 验收标准

- 终端主渲染路径已切换为 Canvas；
- Ghostty HTML formatter 不再承担主渲染职责；
- 终端支持高质量选区：
  - 拖拽选择
  - 双击选词
  - 三击选行
  - 自动滚动扩选
  - 正确复制文本
- direct input / IME / paste / scroll / resize / pane switch 全部可用；
- `dispose()` 能显式释放 wasm 句柄、渲染资源、监听器和调度器；
- `@tmex/fe` build 和终端相关 E2E 通过；
- `plan-00-result.md` 已归档验证结果。

## 执行顺序建议

严格按以下顺序推进，不要交叉大改：

1. 测试基线
2. render-state wasm 绑定
3. Canvas 主渲染器
4. 选区引擎
5. 页面层整合
6. 生命周期治理
7. 文档与回归

这样做的原因是：一旦先写 Canvas 而没有 render-state 测试和选区基线，后续问题会非常难定位。

## 下一步

计划已生成。后续实现时，应继续沿用“先写失败测试，再写最小实现，再回归验证，再提交”的节奏。
