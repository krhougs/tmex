# Prompt：为 UI primitives 增加可选宿主层语义注册

跨平台 native 宿主需要从 Dialog、Sheet、DropdownMenu、ContextMenu、Select、Toast 和终端 split drag 获得稳定的层级、输入与几何语义，替代应用侧对 `data-slot`/`data-testid` 的 selector、MutationObserver 和视觉挖洞兼容代码。

该机制必须保持开源中性：不依赖具体桌面壳或商业应用；无 Provider 时现有 web 行为、样式和 DOM 结构不变。

