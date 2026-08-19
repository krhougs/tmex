# Host Layer Registry 实施计划

## 目标

在 `@tmex/ui` 提供可选、渲染器无关的 Host Layer Context。UI primitives 在挂载期间主动注册自身语义和 HTMLElement ref，宿主可据此合成 native surface、Web 浮层和输入路由；普通浏览器未安装 Provider 时完全 no-op。

## 实现

1. 新增 `host-layer.tsx`：定义 layer kind、input/keyboard/backdrop intent、descriptor、registry 和合并 ref hook。
2. Dialog/Sheet 注册 modal backdrop 与 panel；DropdownMenu/ContextMenu/Select 注册 floating region；ToastCard 注册 toast region。
3. 若 split drag 的真实调用链需要宿主让位，在 terminal-ui 的 drag shield/feedback 源头注册对应语义，不扫描 DOM。
4. 保留所有现有 className、data-slot、动画、dismiss、focus 和 portal 行为；无 Provider 时不增加监听器。

## 验证

- 运行 `@tmex/ui` 现有测试/类型检查入口和受影响前端 build。
- 检查无 Provider 渲染结果与现状一致。
- 不新增仅为覆盖率服务的永久测试。

