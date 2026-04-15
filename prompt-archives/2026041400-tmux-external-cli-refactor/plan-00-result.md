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

## 2026-04-15 第三轮终端尺寸回归修复

又补了一轮尺寸链路修复，针对以下两个新回归：

- 页面初始进入 / 页面刷新 / pane 切换后，终端宽高无法正确同步到 tmux pane；
- 浏览器 resize 后，tmux pane 会短暂闪动，但尺寸随即被恢复成外部 tmux client 的尺寸。

### 根因

`apps/gateway/src/tmux-client/local-external-connection.ts` 和 `ssh-external-connection.ts` 的 `resizePaneInternal()` 在执行完：

```bash
tmux resize-window -t <window> -x <cols> -y <rows>
```

之后，又额外执行了一次：

```bash
tmux set-window-option -t <window> window-size latest
```

但 tmux 3.4 手册明确说明，`resize-window` 本身就会把 `window-size` 自动设为 `manual`。这里把它改回 `latest`，会导致“最近活跃的外部 tmux client”立刻把浏览器目标尺寸冲掉，所以外部观察只会看到 pane 闪一下。

### 修复内容

- 删除以下两处错误回退：
  - `apps/gateway/src/tmux-client/local-external-connection.ts`
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- 新增命令序列回归测试：
  - `apps/gateway/src/tmux-client/local-external-connection.test.ts`
  - `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`
- 新增端到端尺寸收敛回归：
  - `apps/fe/tests/helpers/tmux.ts`
  - `apps/fe/tests/ws-borsh-resize.spec.ts`
  - 覆盖“页面初始加载”和“浏览器 viewport resize 后”，`xterm` 尺寸最终与 tmux pane 实际尺寸一致。

### 验证

已执行：

```bash
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts
bunx @biomejs/biome check apps/gateway/src/tmux-client/local-external-connection.ts apps/gateway/src/tmux-client/ssh-external-connection.ts apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts apps/fe/tests/helpers/tmux.ts apps/fe/tests/ws-borsh-resize.spec.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- ws-borsh-resize.spec.ts ws-borsh-history.spec.ts ws-borsh-switch-barrier.spec.ts
```

结果：

- Gateway 单测：`6 pass`
- Biome：通过
- 前端 E2E：`5 passed`

## 2026-04-15 第四轮终端初始布局与高度收敛修复

在继续对真实页面做尺寸取样时，又发现前一轮修复只解决了“tmux 尺寸会被外部 client 冲掉”的后端问题，但前端初始布局仍然存在一层单独的收敛缺陷：

- 真实页面中，终端宿主区域高度约为 `744px`，但 `.xterm` 实际高度只有 `675px`；
- 终端 `rows = 45`，正好对应 `675 / 15`，说明 xterm 本地行数仍停留在旧值；
- 而切换 pane 后高度会恢复正常，说明“切 pane 路径”的二次收敛逻辑比“初始挂载路径”更完整。

### 根因

前端尺寸链路存在两个问题叠加：

- `useTerminalResize` 在本地只通过 `fitAddon` 推导尺寸并上报给后端，但没有先把同样的 `cols/rows` 立即应用到本地 xterm；
- `Terminal` 初始挂载时只做了一次单次 `sync`，没有复用切 pane 后的多次收敛流程，因此很容易在字体尚未稳定、renderService 尺寸尚未最终收敛时拿到偏小的行高结果。

这就会导致：

- 初始进入页面 / 刷新时，本地 `.xterm` 高度小于 wrapper；
- 后续只有在 pane 切换触发 `runPostSelectResize()` 后，终端才会被重新拉到正确高度；
- 浏览器 resize 时，对“变小”更敏感，但对“变大”场景恢复不稳定。

### 修复内容

- 更新 `apps/fe/src/components/terminal/useTerminalResize.ts`
  - 用 `fitAddon.proposeDimensions()` 仅计算列数；
  - 行数始终基于容器高度和 cell height 计算；
  - 计算出 `cols/rows` 后，先调用 `term.resize(cols, rows)` 立即更新本地 xterm，再同步到后端。
- 更新 `apps/fe/src/components/terminal/Terminal.tsx`

## 2026-04-15 第五轮双浏览器尺寸回环修复

在不同 viewport 的两个浏览器同时打开同一个 pane 时，又发现一类新的尺寸回环：

- A 页面对 tmux 发出一次正常 resize；
- B 页面收到更新后的 remote pane size 后，不只是本地重绘，还会再次触发上行 `TERM_SYNC_SIZE`；
- 两边尺寸不断互相覆盖，最终形成持续的 resize storm，终端内容抽搐。

### 根因

前端尺寸链路里有两条不该存在的“被动收到 remote 信息后再次上行”的路径：

1. `apps/fe/src/pages/DevicePage.tsx`
   - 当 remote pane size 与本地 pending size 不一致时，会调用 `scheduleResize('sync')` 反向重发本地尺寸。
   - 这原本是为了对抗 stale snapshot，但在多浏览器同 pane 场景下会直接形成 `remote -> local sync -> remote -> local sync` 回环。
2. `apps/fe/src/components/terminal/useTerminalResize.ts`
   - `visibilitychange` / `focus` 也会触发上行 `sync`。
   - 这不属于“冷启动 / 浏览器窗口 resize / 切换 pane”三种预期触发源，会把尺寸状态再次搅乱。

### 修复内容

- 更新 `apps/fe/src/pages/DevicePage.tsx`
  - 保留“stale remote size 不覆盖最近一次本地 resize”的 guard；
  - 但彻底删除“收到 stale remote size 后再次 `scheduleResize('sync')`”的反向补偿逻辑。
- 更新 `apps/fe/src/components/terminal/useTerminalResize.ts`
  - 删除 `visibilitychange` / `focus` 触发的上行尺寸同步；
  - 保持只有三类路径会向 tmux 发 resize：
    - 页面冷启动；
    - 浏览器窗口 resize；
    - 切换 pane 后的 post-select resize。
- 更新 `apps/fe/src/utils/resizeSyncGuards.ts`
  - `shouldForceLocalSizeSync()` 明确不再请求任何补偿性上行 sync，只保留“remote size 是否允许覆盖本地渲染”的判断职责。
- 更新测试：
  - `apps/fe/src/utils/resizeSyncGuards.test.ts`
    - 新断言：stale remote size 到来时，不允许再次请求本地 sync。
  - `apps/fe/tests/ws-borsh-resize.spec.ts`
    - 新增双浏览器回归：两个不同 viewport 页面同时打开同一个 pane 时，主动 resize 的一侧可以上行发送尺寸，另一侧只能本地消费 remote resize，不能再发 `TERM_RESIZE/TERM_SYNC_SIZE`。

### 验证

已执行：

```bash
bun test apps/fe/src/utils/resizeSyncGuards.test.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- --grep "remote tmux resize does not trigger resize echo from another browser" tests/ws-borsh-resize.spec.ts
bunx @biomejs/biome check apps/fe/src/pages/DevicePage.tsx apps/fe/src/components/terminal/useTerminalResize.ts apps/fe/src/utils/resizeSyncGuards.ts apps/fe/src/utils/resizeSyncGuards.test.ts apps/fe/tests/ws-borsh-resize.spec.ts prompt-archives/2026041400-tmux-external-cli-refactor/plan-prompt.md
```

结果：

- 单测：通过
- 双浏览器 E2E：`1 passed`
- Biome：通过

## 2026-04-15 第六轮恢复 focus / visibility 尺寸补 sync

在收掉“双浏览器 resize 回环”之后，又按最新要求把 `visibilitychange` / `focus` 的尺寸同步补了回来，但没有回退成旧的无条件回环实现。

### 目标

- 保留上一轮已经修掉的 `remote resize -> 反向上行 resize` 问题；
- 恢复页面在重新获得焦点、从后台切回前台时，对 tmux 补发一次本页尺寸同步的能力；
- 不影响现有冷启动、窗口 resize、切 pane 主流程。

### 修复内容

- 更新 `apps/fe/src/components/terminal/useTerminalResize.ts`
  - 恢复 `visibilitychange` / `focus` 监听；
  - 两个事件共享现有 `scheduleResize('sync', { force: true })` 防抖链路，不额外新开通道；
  - 将尺寸测量提取为内部复用函数，确保普通 resize 和 focus/visibility 补 sync 使用同一套 `cols/rows` 计算逻辑。
- 更新 `apps/fe/src/utils/resizeSyncGuards.ts`
  - 新增 `shouldSyncOnViewportRestore()`，用于表达“页面恢复时允许补发一次 sync”的判断语义。
- 更新 `apps/fe/src/utils/resizeSyncGuards.test.ts`
  - 新增 viewport restore 相关断言。
- 更新 `apps/fe/tests/ws-borsh-resize.spec.ts`
  - 保留上一轮双浏览器“remote resize 不回声”的回归；
  - 新增“stale 页面收到 focus 后补发一次 `TERM_SYNC_SIZE`，但不升级成 loop”的回归。

### 验证

已执行：

```bash
bun test apps/fe/src/utils/resizeSyncGuards.test.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- --grep "focus restore resyncs one stale terminal without reintroducing resize loop|remote tmux resize does not trigger resize echo from another browser" tests/ws-borsh-resize.spec.ts
```

结果：

- 单测：`9 pass`
- 定向 E2E：`2 passed`
  - 初始挂载不再只做一次 `scheduleResize('sync')`；
  - 改为直接复用 `runPostSelectResize()`，与“切 pane 后”的尺寸收敛路径完全一致，包含立即同步、延迟重试和字体稳定后的再次同步。
- 更新 `apps/fe/src/pages/DevicePage.tsx`
  - 为包裹 `TerminalComponent` 的外层 wrapper 补齐 `h-full min-h-0`，避免 flex 场景下高度约束不完整。
- 扩展 `apps/fe/tests/ws-borsh-resize.spec.ts`
  - 新增断言：`.xterm` 视口高度与宿主区域高度的差值必须控制在一个终端 cell 高度内；
  - 继续覆盖初始加载与浏览器 resize 两条路径。

### 验证

已执行：

```bash
bunx @biomejs/biome check apps/fe/src/components/terminal/useTerminalResize.ts apps/fe/src/components/terminal/Terminal.tsx apps/fe/src/pages/DevicePage.tsx apps/fe/tests/ws-borsh-resize.spec.ts
cd apps/fe && CI=1 TMEX_E2E_GATEWAY_PORT=9896 TMEX_E2E_FE_PORT=10017 bun run test:e2e -- ws-borsh-resize.spec.ts ws-borsh-history.spec.ts ws-borsh-switch-barrier.spec.ts
```

结果：

- Biome：通过
- 前端 E2E：`6 passed`

## 2026-04-15 第五轮尺寸链路根因补充结论

在继续按真实 `http://127.0.0.1:19883/devices/6de4ac46-f59e-49c2-81d4-5a2ae3af6472` 页面做 4K 复现后，最终把问题拆成了两层：

### 第一层：前端本地被旧 remote size 反向覆盖

- 真实页面从普通窗口放大到 4K 后，宿主高度会立刻增长，但 xterm 会被一次旧的 remote pane size 重新 `term.resize()` 回去；
- 这一层已经通过 `resizeSyncGuards` 修掉：
  - 前端本地先正确算出并应用 `449x133`；
  - 旧 snapshot / 旧 `selectedPane.width,height` 不再允许覆盖最近一次本地 resize；
  - 真实页面探针已确认第二次反向 `term.resize(132, 45)` 消失。

### 第二层：真实 tmux session 本身不接受当前 external CLI 路径的尺寸改写

进一步证据显示，前端稳定后，tmux 本体仍然可能保持旧尺寸，这不是前端造成的，而是当前 live session 的 tmux 行为本身如此：

- 页面和直接 borsh 客户端都能向 `19663/ws` 发出正确的 `TERM_SYNC_SIZE`：
  - `deviceId = 6de4ac46-f59e-49c2-81d4-5a2ae3af6472`
  - `paneId = %1`
  - grow 后 `cols = 449, rows = 133`
- 但真实 tmux pane `%1` 尺寸始终停在 `132x45`。
- 更关键的是，直接在 shell 里对真实 session 执行原生命令也无效：

```bash
tmux resize-window -t @1 -x 220 -y 70
tmux resize-pane -t %1 -x 220 -y 70
```

执行前后 `#{window_width} #{window_height}` / `#{pane_width} #{pane_height}` 都不变。

### 结构性结论

这说明当前 external CLI 架构至少在“真实有 attached client 的 tmux session”上，不能再假设 `resize-window` / `resize-pane` 一定能把浏览器尺寸落到 live session。也就是说：

- `pipe-pane + list/capture + shell tmux 命令` 可以替代 I/O 与 snapshot；
- 但“浏览器作为终端 client 驱动 tmux 尺寸”这件事，旧 control-mode client 提供的语义，当前 external CLI 方案并没有等价替代。

目前这一层还没有代码级最终修复，后续需要在架构上二选一：

- 为浏览器引入一个真正能影响 tmux client-size 的隐藏 client 路径；
- 或重新约束产品语义，不再要求浏览器尺寸强行驱动真实 attached session 的 pane/window 尺寸。
