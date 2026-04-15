# Plan 00 执行结果

## 背景

本次在 `ghostty-wasm-terminal` 分支继续推进 WebUI 终端底座迁移，目标是：

- 引入独立 workspace 包 `@tmex/ghostty-terminal`；
- 通过 Ghostty 官方仓库 submodule 固定 wasm 来源；
- 用 Ghostty wasm 取代当前 WebUI 里的 xterm 底座；
- 保持 `apps/fe` 页面层和现有 ws-borsh 终端交互 contract 基本不变。

## 本次完成项

### 1. Ghostty wasm 包与 FE 接入

- 新增 `packages/ghostty-terminal`，封装 Ghostty wasm loader、terminal controller、键盘编码、paste 编码与 xterm 兼容 API。
- 引入 `vendor/ghostty` submodule，并固定到 commit `43a05dc968eda9bfa2196d66ba1819daf510b62a`。
- 使用固定 Zig `0.15.2` 构建 `packages/ghostty-terminal/src/assets/ghostty-vt.wasm`。
- `apps/fe` 已切换为依赖 `@tmex/ghostty-terminal`，不再直接使用 xterm 运行时。

### 2. 终端探针与运行时修复

- 修复 `StrictMode` 下 E2E 全局探针被旧实例 cleanup 清掉的问题，收敛为单一探针来源。
- 修复 Ghostty wasm wrapper 中把 wasm32 `usize` 当成 64 位读写导致的 formatter 崩溃。
- 修复空 formatter 结果的边界处理，避免首帧 render 因非法 slice 抛异常。
- 删除重复的 `data-terminal-engine` 标记，避免 Playwright 严格模式匹配到两个元素。
- 调整 composition 处理：
  - `compositionend` 仅在事件本身携带最终文本时发送输入；
  - 取消组合输入时不再泄漏 fallback 字符。

### 3. 测试修复

- `apps/fe/tests/terminal-ui.spec.ts` 的 Ghostty 路径断言已从红转绿。
- `apps/fe/tests/ws-borsh-resize.spec.ts` 中两处依赖两次 `getPaneSize()` 的竞态断言已改为动态比较 terminal/pane 是否一致，避免 tmux pane 尺寸在断言构造期间变化导致假失败。

## 验证

### 构建

```bash
bun run --filter @tmex/fe build
```

结果：通过，产物中包含 `dist/assets/ghostty-vt-*.wasm`。

### 终端相关 E2E

```bash
TMEX_E2E_GATEWAY_PORT=9670 TMEX_E2E_FE_PORT=9892 \
  bun run test:e2e \
  tests/terminal-ui.spec.ts \
  tests/ws-borsh-history.spec.ts \
  tests/ws-borsh-resize.spec.ts \
  tests/mobile-terminal-interactions.spec.ts
```

结果：`13 passed`。

### 额外定向验证

```bash
TMEX_E2E_GATEWAY_PORT=9665 TMEX_E2E_FE_PORT=9887 bun run test:e2e tests/terminal-ui.spec.ts
TMEX_E2E_GATEWAY_PORT=9667 TMEX_E2E_FE_PORT=9889 bun run test:e2e tests/mobile-terminal-interactions.spec.ts tests/ws-borsh-resize.spec.ts
TMEX_E2E_GATEWAY_PORT=9668 TMEX_E2E_FE_PORT=9890 bun run test:e2e tests/mobile-terminal-interactions.spec.ts
```

结果：均通过。

## 注意事项

- 本机存在占用 `9883/9884` 的其他进程，定向 E2E 验证时显式指定了干净端口，避免误连到旧前端服务。
- `bun run --filter @tmex/fe build` 仍会提示大 chunk 警告，但构建成功；该问题与本次迁移目标无直接冲突。
