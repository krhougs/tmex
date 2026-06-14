# Plan-00：e2e 拖垮生产 tmex —— 隔离 + 韧性加固

## 背景
2026-06-14 生产 tmex（launchd 常驻，9883）因进程数耗尽（`EAGAIN posix_spawn tmux`）功能性崩溃：默认 tmux server（`/private/tmp/tmux-501/default`）被拖死，连带工作中的会话被重置。只读排查定位四层成因：

1. **共用默认 tmux socket**：e2e helper 用裸 `tmux`（默认 socket），生产 local device 也在默认 socket 上；端口/DB 隔离挡不住 per-uid 的单例 tmux server。
2. **端口雷 + guard 漏洞**：e2e 默认 FE 端口=9883（生产端口）；「拒绝复用未知实例」guard 只在 `reuseExistingServer` 为真时跑，`forceFreshServers` 路径被跳过。
3. **gateway 把 spawn EAGAIN 抛成 unhandledRejection**：`requestSnapshot()` 无 `.catch()`；reconnect 探测把 EAGAIN 误判成 session gone → shutdown → 重连风暴自我放大。
4. **历史孤儿死槽**：51 个 6·11 遗留 `printf >> events.fifo` 阻塞写端 + 6 个游离 `tail`，长期占进程槽，把系统顶在 4000 上限边缘。

## 目标
让 e2e 结构上无法触碰生产 tmux server / 生产 gateway；让 gateway 在进程压力下优雅降级而非雪崩；清掉存量孤儿。**硬约束：不改动任何现有测试的业务行为。**

## 改动（已落地）
### Layer 1 — 独立 tmux socket
- `apps/gateway/src/config.ts`：新增 `tmuxSocket: getEnv('TMEX_TMUX_SOCKET', '')`（生产不设 → 空 → 不加 `-L`，行为不变）。
- `apps/gateway/src/tmux-client/local-external-connection.ts`：`runTmuxAllowFailure` 与 control-client attach argv 在 `'tmux'` 后按需插入 `-L <socket>`。
- `apps/fe/tests/helpers/tmux.ts`：单一收口 `tmux -L tmex-e2e`（导出 `E2E_TMUX_SOCKET`）。
- `apps/fe/playwright.config.ts`：被测 gateway 注入 `TMEX_TMUX_SOCKET=tmex-e2e`（与 helper 对齐）。

### Layer 2 — 端口 + guard + healthz 断言
- `playwright.config.ts` / `scripts/run-e2e.ts`：默认端口 9883/9663 → **9885/9665**，避开生产。
- `playwright.config.ts`：端口占用 guard 改为全路径生效（不再仅 `reuseExistingServer`）。
- `apps/gateway/src/api/index.ts`：`/healthz` 增 `env: NODE_ENV`。
- `apps/fe/tests/global-setup.ts`（新增）：跑任何用例前断言被测 gateway healthz `env==='test'`，否则整轮 abort（webServer 早于 globalSetup 启动，已由官方文档确认）。

### Layer 3 — gateway EAGAIN 韧性（生产热路径，需发版+upgrade 才在生产生效）
- `local-external-connection.ts`：新增 `isTransientSpawnError` + 哨兵退出码 `TMUX_SPAWN_UNAVAILABLE_EXIT`；`runTmuxAllowFailure` 捕获瞬时 spawn 失败降级为哨兵结果（其余异常照常抛）；`requestSnapshot` 加 `.catch`；快照遇哨兵只退避、不发 null 快照、不 shutdown；reconnect 探测遇哨兵不判 session gone、退避重试且不计入放弃预算；`handleSpawnUnavailable`/`markSpawnRecovered` 实现告警单次、恢复复位。

### Layer 4 — 一次性清理（已执行）
- 杀掉 51 个 `printf>>events.fifo` 阻塞写端 + 6 个游离 `tail`（仅游离进程，不碰服务/安装目录/不删 /tmp/tmex 目录）。进程数 679→623。

## 验证
- `bun test apps/gateway/src/tmux-client/`：140 pass / 0 fail（含真实 tmux 集成测试），精确 argv 与快照断言不变。
- 新增 EAGAIN/socket 单测。
- 末轮全量 `bun run test:e2e`，并核验生产默认 socket 全程不受扰。

## 注意
- Layer 3 改生产热路径，仅正式发版 + `npx tmex-cli@<ver> upgrade` 后在生产生效，由用户执行；本次不碰安装目录/不重启常驻服务。
