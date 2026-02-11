# 执行结果

## 结果概览

- 已修复直链冷启动/刷新时可能连接错误设备的问题。
- 已补充覆盖“多设备并存 + 冷启动直链”的 e2e 回归用例。
- 已完成前端构建与相关测试验证。

## 根因结论

1. 前端对同一设备连接来源未显式区分，`Sidebar` 与 `DevicePage` 在路由初始化阶段可能发生连接时序竞争。
2. `Sidebar` 在直链 pane 路由场景中自动展开时会触发连接，可能干扰页面主连接逻辑。
3. 路由匹配采用双 `useMatch`，在冷启动切换阶段可读性和判定稳定性较弱，不利于避免误连。

## 主要变更

- 更新 `apps/fe/src/stores/tmux.ts`：
  - 为 `connectDevice/disconnectDevice` 增加并统一使用连接来源 `ref`（`page`/`sidebar`）。
  - 新增 `lastConnectRequest` 状态用于记录最近连接请求，便于诊断连接时序。
  - 增加本地开发态连接日志输出。
- 更新 `apps/fe/src/pages/DevicePage.tsx`：
  - 页面连接改为显式 `connectDevice(deviceId, 'page')`。
  - 新增 cleanup：离开页面时执行 `disconnectDevice(deviceId, 'page')`。
  - 增加开发态路由设备与最近连接请求不一致的告警。
- 更新 `apps/fe/src/components/Sidebar.tsx`：
  - 路由匹配改为 `matchPath + useLocation`，收敛匹配逻辑。
  - `Sidebar` 连接操作显式使用 `ref='sidebar'`。
  - 在 pane 直链场景中仅自动展开，不主动触发连接，避免抢连。
- 更新 `apps/fe/tests/tmux-direct-url.e2e.spec.ts`：
  - 新增“冷启动直链不应连接到其他设备”用例。
  - 用 websocket `device/connect` 帧断言：直链 A 仅连接 A，不连接 B。

## 验证结果

1. 执行：`source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe build`
   - 结果：通过。
2. 执行：`source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe test:e2e -- tests/tmux-direct-url.e2e.spec.ts`
   - 结果：`4 passed`，新增用例通过。
3. 执行：`source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/gateway test`
   - 结果：`25 pass, 0 fail`。

## 风险与后续建议

- 目前新增连接日志仅在本地开发态输出，不影响生产日志量；若后续需要线上排障，建议追加可控开关的结构化日志。
- 现有 e2e 已覆盖冷启动直链核心回归路径；后续可补“多标签页并发切换设备”的压力回归场景。
