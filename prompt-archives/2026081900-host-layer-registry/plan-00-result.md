# Host Layer Registry 实施结果

## 完成内容

- `@tmex/ui` 新增可选的 `HostLayerProvider`、语义 descriptor、ref 注册 hook 与通用元素包装器。
- Dialog、Sheet、DropdownMenu、ContextMenu、Select、Toast 在各自 primitive 源头注册 backdrop、浮层、输入和键盘语义。
- terminal-ui 的 split drag shield 与反馈层使用同一注册协议，不再要求宿主按 DOM selector 识别组件。
- 未安装 Provider 时 registry 为 no-op，原有 Web DOM、样式、动画、dismiss 与 focus 行为保持不变。

## 验证

- `bun test packages/ui/src/components`：7 项通过。
- `bunx biome check` 覆盖全部受影响文件：通过。
- 下游 workspace-ui、native-terminal-ui 与 Web 生产构建通过，确认可选注册接口未改变普通浏览器路径。
