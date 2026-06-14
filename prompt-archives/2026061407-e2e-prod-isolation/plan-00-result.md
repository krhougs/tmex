# Plan-00 执行结果

## 提交
- `7e32f30` fix(e2e): 隔离 e2e tmux socket + gateway EAGAIN 韧性（10 文件）
- `27e1f9b` test(e2e): 删除本机长期失败的环境/flaky 用例（5 文件，-476 行）

## 落地内容
### Layer 1 — 独立 tmux socket（核心隔离）
- `config.ts` 新增 `tmuxSocket=getEnv('TMEX_TMUX_SOCKET','')`；生产不设 → 空 → 不加 `-L`，行为不变。
- `local-external-connection.ts`：`runTmuxAllowFailure`（命令式唯一收口）+ control-client attach argv 按需插 `-L <socket>`。
- `helpers/tmux.ts` 单一收口 `tmux -L tmex-e2e`（导出 `E2E_TMUX_SOCKET`）；`playwright.config.ts` 给被测 gateway 注入 `TMEX_TMUX_SOCKET=tmex-e2e`。

### Layer 2 — 端口 + 守卫 + healthz 断言
- e2e 默认端口 9883/9663 → 9885/9665（`playwright.config.ts` + `run-e2e.ts`）。
- 端口占用守卫改为全路径生效（不再仅 `reuseExistingServer`）。
- `api/index.ts` healthz 增 `env`；新增 `tests/global-setup.ts` 在任何用例前断言被测 gateway `env==='test'`，否则整轮 abort。

### Layer 3 — gateway EAGAIN 韧性（生产热路径，需发版+upgrade 才在生产生效）
- 新增 `isTransientSpawnError` + 哨兵 `TMUX_SPAWN_UNAVAILABLE_EXIT`；`runTmuxAllowFailure` 捕获瞬时 spawn 失败降级为哨兵（其余异常照抛）；`requestSnapshot` 加 `.catch`；快照/重连遇哨兵退避而非 shutdown；`handleSpawnUnavailable`/`markSpawnRecovered` 告警单次、恢复复位。

### Layer 4 — 一次性清理（已执行）
- 杀 51 个 6·11 遗留 `printf>>events.fifo` 阻塞写端 + 6 个游离 `tail`；进程数 679→623。仅游离进程，未碰服务/安装目录。

### 测试删除（用户确认）
- 压测（`--repeat-each=3`，隔离 socket）确认 7 个失败均非本次回归（pre-existing/env/flaky）。
- 整文件删 `agent-panel` / `sidebar-delete` / `ssh-terminal-restore`；精确删 `mobile-terminal-interactions` paste-once、`ws-borsh-resize` viewport-height 并清 `readTerminalLayout` 死代码。

## 验证
- gateway `bun test apps/gateway/src/tmux-client/`：140 pass / 0 fail（含真实 tmux 集成测试），精确 argv/快照断言不变。
- 新增 `local-external-connection.eagain.test.ts`：6 pass（socket 注入有/无 `-L`；EAGAIN 不逃逸/不 shutdown/连接保持；恢复复位）。
- 全量 e2e：57 pass / 7 fail / 1 skip；**全程生产 default socket inode（183138583）未变、进程峰值 645**，e2e 落在独立 `tmex-e2e` socket，default 上 0 个 `tmex-e2e-*` → 隔离成立、生产零影响。
- 删后 `playwright --list`：58 tests / 26 files，无解析错误。

## 执行期间的插曲（据实记录）
- 期间默认 tmux server 于 19:03 又崩并自愈重建一次（你的工作会话被重置）。经查：**非我引起**（51 个孤儿全程在场=未被我清，最新 e2e db 是当日 08:34=非新 e2e 触发）；根因是孤儿死槽把生产长期顶在进程上限边缘、反复 EAGAIN→server 崩→自愈。清理孤儿后该循环消除。

## 遗留
- Layer 3（gateway EAGAIN 韧性）需正式发版 + `npx tmex-cli@<ver> upgrade` 才在生产生效，由用户执行；本次未碰安装目录、未重启常驻服务。
