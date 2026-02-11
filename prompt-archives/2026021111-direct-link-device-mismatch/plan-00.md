# 计划：修复直链冷启动场景下的设备匹配错误

## 背景

- 在 `/devices/:deviceId/windows/:windowId/panes/:paneId` 直链刷新或冷启动时，前端可能连接到错误设备。
- 后端 `getDeviceById` 查询按 id 精确匹配，问题更可能出在前端连接时序与状态竞争。

## 注意事项

- 遵循最小改动原则，不改动无关功能。
- 先补测试复现，再做代码修复。
- 保持现有 URL 结构与后端协议不变。

## 执行步骤

1. 补充 e2e 用例：多设备并存 + 直链冷启动，验证不会串设备。
2. 修复 Sidebar 与 DevicePage 的 connect source 竞争：明确 `ref=sidebar/page`。
3. 在直链路由场景中限制 Sidebar 的自动连接，只做展开不抢连接。
4. 修复路由匹配歧义（替换双 `useMatch` 为明确的 `matchPath`）。
5. 增加开发态连接日志，便于后续定位。
6. 运行相关 e2e 与网关测试，输出结果归档。

