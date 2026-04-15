# plan-00 执行结果

## 完成情况

`plan-00.md` 已完成落地，Gateway 默认 tmux 后端已从 `tmux -CC` control mode 切换到 external tmux CLI 架构。

本次完成的关键项如下：

- 新增 `tmux-client/` 侧的共享 runtime、命令构造、输入编码、pane title 解析、SSH bootstrap、本地 external tmux connection、SSH external tmux connection。
- `ws/index.ts` 与 `push/supervisor.ts` 改为通过 `TmuxRuntimeRegistry` 共享 `DeviceSessionRuntime`，不再各自独立创建 tmux 后端连接。
- 本地设备通过外部 `tmux` CLI + `pipe-pane` + session hook 提供 snapshot、history、live output、bell。
- SSH 设备通过 `ssh2` 的 `exec('/bin/sh -s', { pty:false })` 建立命令通道，bootstrap 远端 PATH 与 `tmux` 绝对路径，并复用同样的 snapshot / history / `pipe-pane` / hook 模型。
- 删除旧的 control-mode 实现文件：
  - `apps/gateway/src/tmux/connection.ts`
  - `apps/gateway/src/tmux/connection.test.ts`
  - `apps/gateway/src/tmux/parser.ts`
  - `apps/gateway/src/tmux/parser.test.ts`
- 删除已放弃的 out-of-band 同步回归：
  - `apps/fe/tests/ws-borsh-follow-active.spec.ts`
- 更新了 SSH `tmuxUnavailable` 文案和架构文档，新增 external CLI 架构说明：
  - `docs/terminal/2026041400-tmux-external-cli-architecture.md`

## 额外修复

在执行重构的过程中，顺手修复了两类回归风险：

- `LocalExternalTmuxConnection` 同 pane 并发重选时，`pipe-pane` 生命周期串行化，避免重复 reopen FIFO。
- 前端首次点击切 pane 时，`TMUX_SELECT` 的 `cols/rows` 现在会优先取终端容器尺寸，取不到时回退到当前 xterm 尺寸，再回退到 snapshot 中的 pane 尺寸，避免 barrier 首包尺寸为空。

## 验证结果

### Gateway / 单元测试

已执行：

```bash
bun test apps/gateway/src/tmux-client apps/gateway/src/ws apps/gateway/src/push
```

结果：

- `49 pass`
- `0 fail`

### 静态检查

已执行：

```bash
bunx @biomejs/biome check apps/gateway/src/tmux-client apps/gateway/src/ws apps/gateway/src/push apps/gateway/src/runtime.ts apps/fe/src/pages/DevicePage.tsx apps/fe/src/components/terminal/Terminal.tsx README.md docs/2026021000-tmex-bootstrap/architecture.md docs/terminal/2026041400-tmux-external-cli-architecture.md packages/shared/src/i18n/resources.ts packages/shared/src/i18n/locales/en_US.json packages/shared/src/i18n/locales/zh_CN.json packages/shared/src/i18n/locales/ja_JP.json
```

结果：

- 通过

### 前端 E2E

已执行：

```bash
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- ws-borsh-history.spec.ts ws-borsh-switch-barrier.spec.ts ws-borsh-resize.spec.ts
```

结果：

- `4 passed`
- `0 fail`

## 结论

本轮计划目标已完成，默认 tmux 后端已全面切换到 external CLI 路径，现有 WebUI 终端核心流程（history、resize、barrier、live output、bell、push 订阅）保持正常。

## 2026-04-15 线上回归修复

在 plan 完成后，又补了一次真实页面回归修复，针对本地 device 切换 pane 时出现的 `history timeout` / `can't find pane: %` / `ERR_STREAM_RELEASE_LOCK` 噪声。

### 根因

- 前端 `apps/fe/src/utils/tmuxUrl.ts` 对 React Router 已经 decode 过的 `paneId` 又执行了一次 `decodeURIComponent()`。
- tmux pane id 形如 `%25`、`%30` 时，会被错误还原成 `%`、`0` 等非法或错误值，导致 `TMUX_SELECT` 发错 paneId。
- gateway `LocalExternalTmuxConnection` 在主动 `reader.releaseLock()` 停掉 pipe reader 时，把预期的 `AbortError` 也上报成 tmux error，污染 push 日志。

### 修复内容

- `apps/fe/src/utils/tmuxUrl.ts`
  - 去掉 paneId 的二次 decode。
- `apps/fe/src/utils/tmuxUrl.test.ts`
  - 新增 `%25` / `%251` 编解码回归测试。
- `apps/fe/tests/helpers/tmux.ts`
  - E2E helper 补充返回 `windowId`，方便直接构造 pane 路由。
- `apps/fe/tests/ws-borsh-pane-route.spec.ts`
  - 新增“直接打开 `/windows/:windowId/panes/:paneId` 路由”回归，验证 URL 不被解坏，目标 pane history 正常加载。
- `apps/gateway/src/tmux-client/local-external-connection.ts`
  - 忽略 `reader.releaseLock()` 触发的预期 `AbortError`。
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
  - 新增对应单测。

### 额外验证

已执行：

```bash
bun test apps/fe/src/utils/tmuxUrl.test.ts apps/gateway/src/tmux-client/local-external-connection.test.ts
bunx @biomejs/biome check apps/fe/src/utils/tmuxUrl.ts apps/fe/src/utils/tmuxUrl.test.ts apps/fe/tests/helpers/tmux.ts apps/fe/tests/ws-borsh-pane-route.spec.ts apps/gateway/src/tmux-client/local-external-connection.ts apps/gateway/src/tmux-client/local-external-connection.test.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- ws-borsh-pane-route.spec.ts ws-borsh-history.spec.ts ws-borsh-switch-barrier.spec.ts
```

结果：

- 单测：`5 pass`
- Biome：通过
- E2E：`4 passed`

## 2026-04-15 第二轮前端数据流修复

在真实页面回归中，又发现一类前端切换竞争问题：

- WebUI 点击切换 pane / window 后，终端先 reset；
- 随后前端会被旧的 `pane-active` 事件或旧 active snapshot 拉回切换前的 pane；
- 用户需要再点第二次，目标 pane 才能真正稳定显示。

### 根因

`apps/fe/src/pages/DevicePage.tsx` 同时存在三条会修改当前选择的通路：

- URL 显式目标；
- `pane-active` 事件跟随；
- active snapshot fallback 跟随。

原实现只对 snapshot fallback 做了非常弱的“recent select”抑制，而且只在 sidebar click 时通过 `tmex:user-initiated-selection` 标记用户选择；这导致两类竞争都可能把目标 pane 覆盖回旧 pane：

- 旧 `pane-active` 回声晚到，覆盖刚点击的目标；
- 显式 `/windows/:windowId/panes/:paneId` 路由还没完成 select，旧 active snapshot 先把 URL 改回去。

后续在真实 device 上继续复现时，又发现了第二层更细的竞争：

- 点击目标 pane / window 后，前端先发出正确的 `TMUX_SELECT target`；
- 紧接着又会被旧 snapshot 回流触发一次反向的 `TMUX_SELECT old`；
- 于是左侧 active 圆点先切到目标，再立即闪回旧 pane。

### 修复内容

- 新增 `apps/fe/src/utils/selectionGuards.ts`
  - 统一管理“待确认用户选择”的 TTL；
  - 统一判断何时忽略旧 `pane-active`；
  - 统一判断何时跳过 snapshot fallback。
- 新增 `apps/fe/src/utils/selectionGuards.test.ts`
  - 覆盖 stale `pane-active`、pending user selection、snapshot fallback 竞争场景。
- 更新 `apps/fe/src/pages/DevicePage.tsx`
  - 将 sidebar click 记录的用户目标扩展为带时间戳的 pending selection；
  - 在 `pane-active` 跟随分支里忽略与 pending target 冲突的旧事件；
  - 在 snapshot fallback 分支里忽略与 pending target 冲突的旧 active snapshot；
  - 将“显式 URL 目标 pane”也纳入 pending selection，避免 direct route 初始加载被旧 active pane 回退。
  - 新增“最新一次 `selectPane` 请求优先级最高”的 guard，保护窗口内所有与最新目标不一致的旧 snapshot / 旧 `pane-active` 都不得反向跟随。

### 验证

已执行：

```bash
bun test apps/fe/src/utils/selectionGuards.test.ts apps/fe/src/utils/tmuxUrl.test.ts
bunx @biomejs/biome check apps/fe/src/pages/DevicePage.tsx apps/fe/src/utils/selectionGuards.ts apps/fe/src/utils/selectionGuards.test.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- ws-borsh-history.spec.ts ws-borsh-switch-barrier.spec.ts ws-borsh-pane-route.spec.ts
```

结果：

- 单测：`6 pass`
- Biome：通过
- E2E：`4 passed`

另外已对真实本地环境做定向验证：

- 直接访问 `http://127.0.0.1:19883/devices/6de4ac46-f59e-49c2-81d4-5a2ae3af6472/windows/@1/panes/%251`
- 点击 `window-item-@23`
- 验证结果：
  - 不再出现第二条反向 `TMUX_SELECT @1/%1`
  - 最终 URL 稳定停在 `.../windows/@23/panes/%2525`
