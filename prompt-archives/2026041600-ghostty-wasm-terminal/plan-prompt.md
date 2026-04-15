# Prompt Archive — Ghostty Wasm Terminal Replacement

## 背景

当前在分支 `ghostty-wasm-terminal` 上继续实现。前端终端位于 `apps/fe`，现有实现基于 `react-xtermjs`、`@xterm/xterm`、`xterm-addon-fit`，并在 `apps/fe/src/components/terminal/Terminal.tsx` 中承接了：

- 选择状态机回放（history/live output）
- IME 输入兜底
- resize / sync / post-select resize
- E2E 调试钩子
- 主题切换

用户要求参考 Ghostty 官方 `example/wasm-key-encode/index.html`，新开一个分支，引入 Ghostty wasm，并将当前 WebUI 终端实现替换为单独维护的 npm 包。

## 用户原始 Prompt（2026-04-16）

> 参考 https://github.com/ghostty-org/ghostty/blob/main/example/wasm-key-encode/index.html
> 开一个新分支，维护一个单独的npm包并引入ghostty wasm，替换当前webui中的终端实现

## 外部调研结论

### Ghostty 官方仓库

- 参考页面 `example/wasm-key-encode/index.html` 是 **WebAssembly 装载 + 键盘编码示例**，并不是完整浏览器终端组件。
- 同目录 `README.md` 明确示例需要先本地构建 `ghostty-vt.wasm`，再通过 HTTP 服务访问。
- `include/ghostty/vt/wasm.h` 展示的是 wasm 分配辅助 API，说明官方当前公开稳定的是 `libghostty-vt` 的底层 wasm 接口。

### 官方 API 能力面

- `terminal.h` 明确 `libghostty-vt` 提供完整终端状态机与 effect callback。
- `render.h` 提供 render state、dirty tracking、row/cell 迭代接口，可用于浏览器侧增量渲染。
- `key/encoder.h` 提供按当前 terminal state 同步选项的 key encoder。
- `mouse.h` 提供 mouse encoder。
- Ghostty 官方还提供了 `example/wasm-vt`，证明 `libghostty-vt` 已具备“终端状态 + 格式化输出”的浏览器侧示例能力。
- 最新主干头文件路径已收敛到 `include/ghostty/vt/key/*.h`、`include/ghostty/vt/mouse*.h`，不能继续沿用旧路径假设。
- 当前环境虽然存在 `zig 0.16.0`，但实际构建已验证失败；Ghostty 当前源码要求 `zig v0.15.2`。

## 用户补充 Prompt（2026-04-16）

> 当前分支

## 当前状态补充（2026-04-16）

- 当前仓库已经存在 `prompt-archives/2026041600-ghostty-wasm-terminal/`，并已有初始计划草稿。
- `apps/fe/tests/terminal-ui.spec.ts` 已先写入 Ghostty 路径断言，并已验证失败，失败点为 `window.__tmexE2eTerminalEngine === null`。
- 因为上游构建链锁定 `zig v0.15.2`，仓库内必须补一条“固定 Ghostty submodule + 固定 Zig 0.15.2”的自包含 wasm 构建路径，不能依赖开发者全局环境碰巧匹配。

## 用户纠偏 Prompt（2026-04-16）

> 不要用 ghostty-web，这个库已经没人维护了，问题很多

## 纠偏结论

- `ghostty-web` **不进入依赖树，也不作为实现基础库**。
- 本次实现改为：
  - 直接基于 Ghostty 官方仓库构建 `ghostty-vt.wasm`；
  - 在仓库内新增自维护的 workspace npm 包；
  - 由该包实现浏览器侧 wasm wrapper、render adapter、输入/resize 兼容层；
  - `apps/fe` 只依赖这个本地包，不感知底层 wasm 细节。

## 核心诉求

1. 新开一个实现分支；
2. 新增一个独立维护的 workspace npm 包，隔离 Ghostty wasm 接入细节；
3. 将 `apps/fe` 从 xterm 直连切换到该包；
4. 尽量不改动上层页面与状态机行为，保持当前 WebUI 终端功能可用；
5. 使用 TDD 方式推进，并在完成后补充 `plan-00-result.md`。

## 注意事项

- 必须遵守“先存档，再干活”；
- 本次替换目标是 **前端终端渲染/输入实现**，不涉及 gateway / ws 协议改造；
- 官方 `wasm-key-encode` 不能直接替代整个终端，不能误判为“官方已有现成浏览器终端组件”；
- `apps/fe` 现有代码大量依赖 xterm 风格接口，迁移策略应以兼容层为主，避免重写上层选择状态机；
- 明确禁止使用 `ghostty-web` 作为运行时依赖；
- Bun 是本仓库唯一受支持的 JS 运行时；
- 最终需要验证至少包含：定向 E2E、前端构建、workspace 测试。
