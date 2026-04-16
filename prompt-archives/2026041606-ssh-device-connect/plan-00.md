# 计划：修复 SSH device connect 主链路

## 背景

- 用户反馈当前 SSH connect 完全不可用，需要仔细 review 并修正 SSH 相关架构，让 SSH device 真正可用。
- 本轮调试目标设备为开发服务器中的 `dns shanghai`，但该目标只能作为运行时传入参数，不能硬编码到代码、测试或配置常量中。
- 历史资料显示当前实现存在 probe stub、错误分类不够细、真实远端回归缺失等问题；本轮必须把“探测成功”和“终端真正可用”明确区分。

## 注意事项

- 修复边界优先锁定在 `apps/gateway` 的 SSH 生命周期、probe 契约与真实 tmux runtime；前端只做最小接线与结果展示。
- 验收标准不能停留在“接口返回成功”，必须覆盖：真实连接、拿到 tmux snapshot、定位有效 pane、执行一条无害命令并看到回显。
- e2e 与调试必须支持按设备名/目标参数选择目标，不允许把 `dns shanghai` 或任意 host 写死在仓库中。
- 新增业务约束：一个 device 只能对应一个 SSH 连接；同设备重复 connect 必须复用既有连接或被明确拒绝，不能并发建立多个 SSH transport。
- 当前仍有并行探索任务在运行；它们的结果用于验证或微调本计划的实现细节，不应扩大范围。

## 目标

1. 让 Gateway 的 `test-connection` 变成真实 SSH probe，而不是 stub。
2. 修复 SSH runtime connect，使 SSH device 能真实进入 tmux、拿到 snapshot 并具备基础 I/O 能力。
3. 建立参数化 e2e／调试链路，允许通过运行参数指定 `dns shanghai` 做实机验证。

## 非目标

- 不重构本地设备链路。
- 不做移动端、terminal 渲染、通知系统或无关 UI 优化。
- 不在本轮完整实现 `sshConfigRef` 解析；若涉及该路径，仅保持显式失败语义。

## 验收标准

### Probe 成功

满足以下全部条件才算 probe 成功：

1. 设备解析成功。
2. 认证参数解析成功。
3. SSH transport 建立成功。
4. 远端 bootstrap 成功。
5. tmux 二进制与基础环境可用。

### Runtime 成功

满足以下全部条件才算 SSH connect 修复完成：

1. 在真实 SSH device 上建立会话并拿到首个非空 tmux snapshot。
2. 能定位到有效 pane，并能持续接收输出。
3. 通过 active pane 发送 `printf '__TMEX_SSH_SMOKE__\n'` 后能看到回显。
4. 前端不会把 probe 成功误导成“终端已可用”。
5. 同一个 device 在整个链路中始终只保留一个 SSH 连接实例。

## 实施步骤

### 阶段 1：用失败测试钉死 probe 与 runtime 边界

目标文件（预估）：

- `apps/gateway/src/tmux-client/ssh-bootstrap.test.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`
- `apps/gateway/src/ws/error-classify.test.ts`
- `apps/gateway/src/tmux-client/ssh-probe.test.ts`（新增）
- `packages/shared/src/index.ts`（如需补充共享类型）

执行要点：

1. 先新增/调整测试，明确当前 `test-connection` 仍是 stub。
2. 用测试定义 probe 成功与 runtime 成功的不同语义。
3. 为认证失败、无 `SSH_AUTH_SOCK`、tmux 不存在、bootstrap 失败等场景补足失败断言。
4. 补一条单 device 重复 connect 回归，确认不会并发拉起第二个 SSH 连接。

### 阶段 2：把 Gateway probe 改成真实 SSH 生命周期复用

目标文件（预估）：

- `apps/gateway/src/api/index.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-bootstrap.ts`
- `apps/gateway/src/tmux-client/ssh-probe.ts` 或等价共享 helper（新增）
- `packages/shared/src/index.ts`

执行要点：

1. 抽出 probe 与 runtime 共用的“终端前”生命周期：设备参数→认证→SSH connect→远端 bootstrap。
2. `test-connection` 只负责 probe，不安装 hook，不声明 terminal 已可用。
3. probe 结果保留阶段信息，便于前端和日志判断失败点。

阶段验证：

- 运行新增 probe 测试，确认 stub 行为先失败，真实 probe 落地后转绿。
- 用 API 断言 probe 返回的是阶段化结果，而不是笼统 success。

### 阶段 3：修复 SSH runtime connect 到可用 tmux 终端

目标文件（预估）：

- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/device-session-runtime.ts`
- `apps/gateway/src/ws/index.ts`（仅在事件顺序必须调整时）

执行要点：

1. 围绕真实链路补失败回归：connect → ensure session → hook → snapshot → pane I/O。
2. 只修真正损坏的阶段，不顺手重构本地 runtime。
3. 保持“probe 成功 ≠ 终端可用”的状态边界。
4. 明确 device 级单连接策略，防止页面刷新、重复点击或并发请求把同一设备连出多个 SSH transport。

阶段验证：

- 运行 runtime 相关单测，确认首次连接能拿到 snapshot。
- 补重复 connect 场景，确认同设备不会建立第二条 SSH 连接。

### 阶段 4：补参数化 e2e 与最小前端接线

目标文件（预估）：

- `apps/fe/src/pages/DevicesPage.tsx`
- `apps/fe/scripts/run-e2e.ts`
- `apps/fe/playwright.config.ts`
- `apps/fe/tests/ssh-device-connect.spec.ts`（新增）

执行要点：

1. 新增基于环境变量或命令参数的目标设备名选择，例如 `TMEX_E2E_SSH_DEVICE_NAME`。
2. 运行时通过 `/api/devices` 或现有 fixture 解析目标设备 ID，而不是硬编码服务器信息。
3. 在计划落地前先明确测试环境中的设备来源：要么复用指定数据库中的现有设备，要么在测试准备阶段通过 API/fixture 创建 SSH device；不能假设 `dns shanghai` 会天然出现在 Playwright 的临时数据库里。
3. 前端仅展示 probe 阶段结果，不改 terminal 主流程。

阶段验证：

- 缺少目标设备名时快速失败并输出清晰报错。
- 在目标设备存在时，Playwright 通过运行时参数解析 deviceId 后完成连接 smoke。

### 阶段 5：使用 `dns shanghai` 做实机验证

执行要点：

1. 通过参数传入目标设备名 `dns shanghai`。
2. 先跑 probe，再打开真实 terminal。
3. 验证 snapshot、pane、I/O smoke 全链路通过。
4. 验证重复触发 connect 时仍保持单 device 单 SSH 连接。

## 计划中的验证命令

> 实际命令会根据代码落点微调，但必须保留这些验证目标。

```bash
DATABASE_URL=:memory: bun test apps/gateway/src/tmux-client/ssh-probe.test.ts
DATABASE_URL=:memory: bun test apps/gateway/src/tmux-client/ssh-external-connection.test.ts
DATABASE_URL=:memory: bun test apps/gateway/src/ws/error-classify.test.ts
bun run --filter @tmex/gateway test
TMEX_E2E_SSH_DEVICE_NAME='dns shanghai' bun run --cwd apps/fe test:e2e -- ssh-device-connect.spec.ts
bun run lint
```

## 风险

1. `ssh2` 当前使用方式可能存在交互通道模型不匹配，修复时要以仓库现状与真实行为为准，避免盲目套用外部示例。
2. 实机环境的 SSH 认证方式、远端 tmux 配置与本地测试桩不同，必须保留阶段化日志与错误分类，避免把所有失败都收敛成认证错误。
3. e2e 若把目标选择写死，会在后续环境迁移时直接退化为一次性脚本，因此必须坚持参数化。
4. 如果 device 级连接去重策略处理不当，页面刷新或重复点击可能制造僵尸 SSH 连接，必须在实现与验证中显式覆盖。
