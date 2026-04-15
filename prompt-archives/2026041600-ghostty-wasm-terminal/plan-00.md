# Plan · WebUI 终端切换到 Ghostty Wasm

> 分支：`ghostty-wasm-terminal` ｜ 归档目录：`prompt-archives/2026041600-ghostty-wasm-terminal/`

## Context

`apps/fe/src/components/terminal/Terminal.tsx` 当前通过 `react-xtermjs` 创建 xterm 实例，并结合 `xterm-addon-fit`、`textarea` 事件、选择状态机回调与 resize hook 承接整个 WebUI 终端生命周期。页面层 `apps/fe/src/pages/DevicePage.tsx` 只依赖一个较薄的 `TerminalRef` 抽象，因此最佳迁移路径不是重写页面逻辑，而是把底层终端实现替换为 Ghostty wasm 驱动的兼容层。

Ghostty 官方示例 `example/wasm-key-encode/index.html` 只演示了 wasm 模块装载和 key encoding，不包含完整浏览器终端 UI；不过官方还提供了 `example/wasm-vt`，证明 `libghostty-vt` 已具备“终端状态 + 浏览器格式化输出”的基础示例。结合最新头文件与构建结果，当前可行方案是：

- 直接基于 Ghostty 官方仓库构建 `ghostty-vt.wasm`；
- 以 Git submodule 锁定一个明确的 Ghostty release/commit；
- 在仓库内补齐固定 `zig v0.15.2` 的自包含构建链；
- 在仓库内新增一个独立 workspace 包；
- 由该包维护浏览器侧 wasm wrapper、render adapter、key/mouse encoder 与最小 xterm 风格兼容 API；
- 在兼容层里保留 `.xterm` 风格 DOM class 与 E2E debug object 形状，降低测试和页面层改造面；
- `apps/fe` 只依赖这个本地包，不引入 `ghostty-web`。

## 关键决策

| 决策 | 选择 | 说明 |
| --- | --- | --- |
| 分支策略 | 当前分支 `ghostty-wasm-terminal` 继续推进 | 不再额外切新分支 |
| 封装层 | 新增 workspace 包 | 避免第三方依赖细节泄露到 `apps/fe` |
| Ghostty wasm 来源 | Ghostty 官方仓库构建产物 | 以 submodule 锁定版本，使用 `zig v0.15.2` 构建 `ghostty-vt.wasm` 并固定到本地包 |
| 适配层 | 自维护 workspace 包 | 不依赖 `ghostty-web` |
| FE 迁移方式 | 保持页面/状态机接口不变，替换终端底座 | 降低回归面 |
| DOM / 调试兼容 | 保留 `.xterm` 类名和兼容调试对象 | 降低现有 E2E 迁移成本 |
| 测试策略 | 先写失败测试，再做实现 | 遵守 TDD |

## 范围

### In Scope

- 新增独立 workspace npm 包，例如 `packages/ghostty-terminal`
- 该包封装官方 `ghostty-vt.wasm` 初始化、render adapter 与兼容导出
- `apps/fe` 终端组件切换到新包
- 清理 `apps/fe` 中不再需要的 xterm 直连依赖
- 补充至少一个能证明 FE 已切到 Ghostty 路径的测试

### Out of Scope

- gateway / ws 协议改造
- 终端页面交互逻辑重设计
- 终端主题体系重构
- 非终端相关页面改动

## 实施任务

### Task 1：归档与分支准备

**Files:**
- Create: `prompt-archives/2026041600-ghostty-wasm-terminal/plan-prompt.md`
- Create: `prompt-archives/2026041600-ghostty-wasm-terminal/plan-00.md`

**Steps:**
1. 归档用户 prompt、外部调研结论、范围与注意事项。
2. 更新计划，明确本次在当前 `ghostty-wasm-terminal` 分支继续推进。

### Task 2：先写失败测试，证明 FE 终端实现已切换

**Files:**
- Modify: `apps/fe/tests/terminal-ui.spec.ts` 或新增单独 spec

**Steps:**
1. 增加一个只会在 Ghostty 路径下成立的断言。
2. 运行定向测试，确认当前分支上先失败。
3. 失败原因应明确指向“终端实现仍是 xterm 路径”，而不是环境错误。

### Task 3：新增独立 workspace 包

**Files:**
- Create: `.gitmodules`
- Create: `vendor/ghostty`（submodule）
- Create: `packages/ghostty-terminal/package.json`
- Create: `packages/ghostty-terminal/src/index.ts`
- Create: `packages/ghostty-terminal/tsconfig.json`（如当前仓库结构需要）
- Create: `packages/ghostty-terminal/src/*.test.ts`（如适合做包级测试）
- Create: `packages/ghostty-terminal/scripts/*`
- Modify: 根 `package.json`（如需要补脚本）

**Steps:**
1. 以 submodule 形式引入 Ghostty 官方仓库，并固定到明确版本。
2. 在仓库内补一条固定 `zig v0.15.2` 的构建脚本，生成并纳入官方 `ghostty-vt.wasm` 产物。
3. 在包内实现 wasm loader、terminal wrapper、render state wrapper、key encoder wrapper。
4. 处理单例初始化，避免 React 严格模式下重复初始化 wasm。
5. 导出独立于 React 的 controller / types / helper，避免把实现细节泄漏到 `apps/fe`。

### Task 4：替换 `apps/fe` 的终端底座

**Files:**
- Modify: `apps/fe/src/components/terminal/Terminal.tsx`
- Modify: `apps/fe/src/components/terminal/types.ts`
- Modify: `apps/fe/package.json`
- Modify: 其他受影响终端文件（按实际需要）

**Steps:**
1. 将 `react-xtermjs` / `@xterm/xterm` / `xterm-addon-fit` 的直接依赖替换为新包导出。
2. 保留现有 `TerminalRef` 对页面层的 contract。
3. 继续支持：
   - history/live output 写入
   - IME 输入兜底
   - custom key handler
   - resize / sync / post-select resize
   - 主题切换
   - E2E 调试钩子
4. 如果 Ghostty 的 open/init 生命周期与 xterm 不同，在组件内部做适配，不把差异泄漏到页面层。
5. 对外新增更中性的 `__tmexE2eTerminal*` 标识，同时在迁移期保留 `__tmexE2eXterm` 兼容对象，避免一次性打碎所有现有 E2E。

### Task 5：回归验证与结果归档

**Files:**
- Create: `prompt-archives/2026041600-ghostty-wasm-terminal/plan-00-result.md`

**Steps:**
1. 运行定向测试：
   - 新增的失败测试回绿
   - 受影响的终端相关 E2E
2. 运行前端构建与必要的 workspace 测试。
3. 记录验证命令、结果、剩余风险和后续观察点。

## 风险与处置

1. 官方 C API 的浏览器侧包装需要自己维护，初期适配层工作量高于直接接第三方库。
   - 处置：严格收敛到当前仓库真实用到的 API 面，不追求一次覆盖完整 xterm 全量能力。
2. xterm 相关 addon / CSS 假设可能残留在 `apps/fe`。
   - 处置：从终端组件入口向外逐层清理，优先保持 `DevicePage` 无感。
3. Ghostty 当前源码要求 `zig v0.15.2`，与本机现有 `zig 0.16.0` 不兼容。
   - 处置：仓库内自带固定版本 Zig 下载/缓存脚本，不依赖全局工具链。
4. wasm 初始化如果做成每实例一次，可能在切 pane / 严格模式下产生额外开销或竞态。
   - 处置：封装成模块级一次性初始化 Promise。
5. render-state 路径会直接影响 resize、scrollback 和字体度量。
   - 处置：优先适配现有 E2E 强覆盖的尺寸与 history 行为。
6. E2E 环境对字体度量更敏感，可能影响 resize 断言。
   - 处置：优先跑已有终端 UI / resize spec，并记录残余风险。

## 验收标准

- 仓库存在独立的 Ghostty 终端 workspace 包；
- `apps/fe` 不再直接以 xterm 作为终端底座；
- 至少一个测试能证明终端已走 Ghostty 路径，并已从红转绿；
- 终端页面基础可用：可渲染输出、可发送输入、可 resize、可切 pane；
- `plan-00-result.md` 已归档验证结果。
