# plan-00 执行结果

## 背景

- 执行计划：`prompt-archives/2026041601-ghostty-canvas-terminal/plan-00.md`
- 执行分支：`ghostty-wasm-terminal`
- 目标：将 Ghostty wasm 终端主渲染切到 Canvas，并补齐选区、复制、自动滚动、兼容层与清理能力

## 完成情况

### Task 1：测试基线

- 已补齐 Canvas 渲染探针与回归测试：
  - `apps/fe/tests/terminal-ui.spec.ts`
  - `apps/fe/tests/terminal-viewport-render.spec.ts`
  - `apps/fe/tests/terminal-selection-canvas.spec.ts`
  - `packages/ghostty-terminal/src/terminal.canvas.test.ts`
- 覆盖了 Canvas renderer probe、拖拽选区、双击按词、三击整行、拖出 viewport 自动滚动扩选、复制、pane 切换/重连/resize 清理，以及 dispose 后基础清理行为

### Task 2：Ghostty render-state 绑定

- 已在 `packages/ghostty-terminal/src/ghostty-wasm.ts` 补齐 render-state / row iterator / row cells 所需 wasm 绑定
- 已新增 `packages/ghostty-terminal/src/render-state.ts`，提供 JS 侧安全包装：
  - `createRenderState`
  - `updateRenderState`
  - `readRenderSnapshotMeta`
  - `iterateRows`
  - `disposeRenderStateResources`
- 同时补了 Bun 环境下 wasm 字节加载兼容，避免只依赖 `fetch(...)`

### Task 3：Canvas 主渲染器

- 已新增 `packages/ghostty-terminal/src/canvas-renderer.ts`
- 主渲染路径已经从 formatter 切换为：
  - `Ghostty render-state -> rows/cells -> CanvasRenderer`
- 已支持：
  - 主画布文本与背景绘制
  - 选区 overlay
  - 光标层
  - dirty row 增量绘制
  - theme 切换
  - renderer probe：`terminal.getRendererKind() === 'canvas'`

### Task 4：选区引擎与命中测试

- 已新增：
  - `packages/ghostty-terminal/src/selection-model.ts`
  - `packages/ghostty-terminal/src/selection-clipboard.ts`
- `packages/ghostty-terminal/src/terminal.ts` 已完成接线：
  - 字符级拖拽选区
  - 双击按词选择
  - 三击整行选择
  - 基于绝对行号的 `lineCache`
  - 选区矩形投影到 Canvas overlay
  - 选区文本 probe：`__tmexE2eTerminalSelectionText`
  - 复制快捷键与 `copy` 事件写入剪贴板
  - 拖拽越界自动滚动扩选

### Task 5：输入、滚动、resize 与兼容层

- 现有输入链路保持可用，复制快捷键与普通按键编码已正确分流
- `buffer.active` 兼容层仍然可供现有 E2E 读取
- `scrollToBottom()`、viewport 渲染和 direct input 行为回归通过
- `resize()`、`reset()` 时会清理选区状态，避免遗留脏状态

### Task 6：清理、内存与生命周期

- `dispose()` 现在会清理：
  - RAF
  - Canvas renderer
  - auto-scroll timer
  - 全局拖拽事件监听
  - render-state 资源
  - E2E selection probe
- `apps/fe/src/components/terminal/Terminal.tsx` 在清理 probe 时会同步清空 selection probe，避免 SPA 路由切换残留旧值

### Task 7：全量回归与归档

- 已完成本次 prompt 与结果归档
- 未执行计划中的 git commit 步骤；当前代码仍处于未提交状态，方便继续 review 或再改

## 验证结果

### 单测

```bash
bun test packages/ghostty-terminal/src/terminal.canvas.test.ts
```

- 结果：`5 pass / 0 fail`

### 前端 E2E

```bash
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 \
  bun run --filter @tmex/fe test:e2e \
  tests/terminal-ui.spec.ts \
  tests/terminal-viewport-render.spec.ts \
  tests/terminal-selection-canvas.spec.ts
```

- 结果：`6 passed`
- 通过项：
  - `terminal-ui.spec.ts`
  - `terminal-viewport-render.spec.ts`
  - `terminal-selection-canvas.spec.ts`

## 关键调整与偏差

- `terminal-selection-canvas.spec.ts` 的 auto-scroll fixture 做了两次收紧：
  - 批量输出改为 `seq 1 140 | sed 's/^/AS_/'`，避免 tmux 长命令转义噪声
  - 在断言 `AS_140` 可见前显式 `scrollToBottom()`，与 viewport 兼容层行为保持一致
- auto-scroll 用例的锚点列改为 `endCol`，因为字符级跨行选区在底部锚点行只会保留“从行首到锚点列”的片段；使用末列能稳定覆盖整段 `AS_140`

## 当前状态

- Canvas 主渲染已是可工作的主路径
- Canvas 选区、复制、自动滚动与清理行为已到可评审状态
- 工作树仍有未提交改动，下一步可以直接进入代码评审、整理提交或继续做性能打磨
