# Prompt Archive · Ghostty Canvas Terminal + SOTA Selection

## 背景

当前分支为 `ghostty-wasm-terminal`，最近两个提交为：

- `7d7157c feat: switch web terminal to ghostty wasm`
- `9542e9d fix: isolate gateway runtime fifo paths`

现有前端终端已从 xterm 切到 `packages/ghostty-terminal`，但当前渲染实现仍然是：

1. Ghostty wasm 维护终端状态；
2. 通过 formatter 生成 HTML / plain 文本；
3. 前端将 HTML 写入 `.xterm-screen.innerHTML`；
4. 兼容 buffer 通过 plain 文本维护。

对应关键实现文件：

- `packages/ghostty-terminal/src/terminal.ts`
- `packages/ghostty-terminal/src/ghostty-wasm.ts`
- `apps/fe/src/components/terminal/Terminal.tsx`

当前架构已经不再依赖 xterm 作为状态机，但渲染层仍属于“DOM formatter 适配层”，并没有真正用上 Ghostty 官方 render-state API。

## 用户新增需求

### Prompt 1

> I prefer to render the terminal in Canvas instead in DOM, while we can make the render effect more smooth. Take care in cleaning up the terminal and memory

### Prompt 2

> All in, make it SOTA while making selection features SOTA too.

### Prompt 3

> All in, make it SOTA while making selection features SOTA too.
> Make a new plan to do this.

## 需求澄清结论

本轮目标不是“小幅优化当前 DOM 版 Ghostty 终端”，而是：

1. 将前端终端渲染彻底切换为 Canvas；
2. 基于 Ghostty 官方 render-state API 做增量、可持续维护的渲染器；
3. 选区能力不再沿用最小兼容实现，而是同步升级为高质量、可扩展方案；
4. 将清理、释放、内存回收、事件解绑、wasm 句柄释放作为一等目标，不接受“功能先通、清理后补”的路线。

## 技术调研结论

### 当前实现的瓶颈

`packages/ghostty-terminal/src/terminal.ts` 当前每次渲染都要：

- 走 `formatViewport(..., HTML)` 生成 HTML 字符串；
- 走 `formatViewport(..., PLAIN)` 生成 plain 字符串；
- 通过 `screenElement.innerHTML = html` 更新屏幕。

这一链路的问题包括：

- 每帧字符串分配较重；
- HTML 解析和 DOM 更新成本高；
- 不支持真正的 dirty row 增量绘制；
- 很难做高质量选区命中与绘制；
- 清理路径依赖 DOM 节点移除和 wasm 句柄释放，缺少渲染器级资源生命周期管理。

### Ghostty 官方更适合的能力面

Ghostty 官方已提供 `render.h` / `src/terminal/c/render.zig`，能力包括：

- `ghostty_render_state_new/free/update`
- 全局 dirty state
- row iterator / row dirty state
- row cells iterator
- cell style / grapheme / 前景色 / 背景色
- cursor 可见性、样式、位置、颜色
- palette 与默认前景背景色读取

这意味着前端可以直接基于 render-state 做 Canvas renderer，而不需要继续依赖 HTML formatter。

## 规划约束

- 继续在当前分支 `ghostty-wasm-terminal` 上推进；
- 计划必须先归档，再继续实现；
- 不引入新的现成 Web terminal 库；
- 以 Ghostty 官方 C API / wasm 导出为唯一终端语义来源；
- 维持 `apps/fe` 页面层 contract 尽量稳定，不把底层复杂度泄漏到页面层；
- 第一阶段就必须包含选区、复制、自动滚动和资源释放，不接受“以后再补”。

## 本轮计划的目标

产出一份新的实施计划，覆盖：

- Canvas 渲染架构
- render-state wasm 绑定扩展
- 选区模型与交互能力
- 清理 / 内存 / 生命周期策略
- TDD 与回归验证矩阵
- 分阶段落地与风险处置

### Prompt 4

> prompt-archives/2026041601-ghostty-canvas-terminal/plan-00.md  Let's go
