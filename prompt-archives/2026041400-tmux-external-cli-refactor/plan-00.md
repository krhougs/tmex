# Plan · tmux 外部 CLI 重构（放弃 control mode）

> 分支：`tmux-redesign` ｜ 归档目录：`prompt-archives/2026041400-tmux-external-cli-refactor/`

## Context

`apps/gateway` 目前通过 `tmux -CC new-session -A`（control mode）与 tmux 交互。control mode 的八进制 `%output` 转义、`%begin/%end` 块匹配、与 IO 流混合在同一通道导致状态同步复杂、易出错。历史修复反复围绕这些问题。

本次目标：**基于当前分支，下线 control mode，改用「外部 `tmux` CLI + 独立 per-pane 输出通道 + 最小 hook 回调 + device/session 共享 runtime」的最佳实践**。前端协议零改动；`apps/fe/` 不改。

**范围限定**：不要求外部 tmux client（非 webui 发起）操作同步回 webui。

## 关键决策（含两轮审阅修正）

| 决策 | 选择 | 说明 |
| --- | --- | --- |
| 迁移方式 | 一次性替换 | 基于 `tmux-redesign` 分支 |
| **tmux server / session 契约** | **复用默认 tmux server + `device.session`** | 对齐 `connection.ts:176/375`、`tests/helpers/tmux.ts:15`；命令不带 `-S/-L`；session 名取 `device.session ?? 'tmex'`；`new-session -A -s <session>`（无 `-CC`） |
| **运行时所有权** | **`DeviceSessionRuntime` 单例，`TmuxRuntimeRegistry` 管理** | ws 与 push 共享同一 runtime；解决 `pipe-pane` 独占（`tmux(1) man:1442`）与 `set-hook` 覆盖（`tmux(1) man:2520`）冲突 |
| **hook 作用域** | **`-t <session>`（非 `-g`）** | 不污染默认 tmux server 其他 session |
| **hook/FIFO 生命周期** | **reader 先于 install；shutdown/reconnect 必 unset** | FIFO 路径含 gateway pid；启动扫 stale 目录；teardown `set-hook -u -t <session> <ev>` |
| **SSH 命令通道实现** | **`conn.exec('/bin/sh -s', { pty: false })` + PATH bootstrap** | 无 pty 规避 MOTD/PS1 污染；bootstrap 阶段 `source /etc/profile + ~/.profile` 拉 PATH，解析 `command -v tmux` 缓存绝对路径；后续调用使用 `"$TMUX_BIN"` |
| Output 订阅策略 | **被订阅 pane 集合**（deviceSession 内并集） | 多 WS client 各自 `selectedPanes` 的并集 |
| **同步范围** | 仅 webui 自发操作 + 关键实时事件 | 不监听 out-of-band tmux 操作 |
| **外部 tmux 操作同步能力** | **放弃** | 删除 `ws-borsh-follow-active.spec.ts`；FE 事件链保留不改；P5 不恢复 |
| **多 WS client "不同 pane" 长期一致性** | **删除该 QA 条目** | FE `stores/tmux.ts:304` 是全局 `pane-active` 状态，`DevicePage.tsx:497` 必跟随；在"apps/fe/ 不改"前提下不成立 |
| tmux 最低版本 | 3.2+ | session-scoped hook、`pipe-pane -O`、`window-size latest` 均可用 |
| Server 生命周期 | 保持现状 | 不自动 `kill-server`；关闭最后 window 前 `new-window -d` 保活 |
| `DEVICE_EVENT` 错误类型 | 复用 `error + errorType='tmux_unavailable'` | FE 只处理 `error/disconnected/reconnected` |
| 书签能力 | 不在本次范围 | 仓库无实现 |

## 目标架构

```
WS Client ↔ ws/index.ts ────┐      push/supervisor ────┐
(isComposing 丢弃 +         │                          │
 paste 1024 char 切块 +      ├────┐                     │
 TERM_OUTPUT 过滤 保留)      │    │                     │
                             ↓    ↓                     │
               ┌─────── TmuxRuntimeRegistry ─────┐     │
               │  Map<deviceId, DeviceSessionRuntime>  │
               │  ref-count acquire / release          │
               └───────────────┬──────────────────┘    │
                               │                        │
                ┌──────── DeviceSessionRuntime ─────────┴─────┐
                │  shared by ws (client-scoped ref) + push     │
                │  ─ TmuxClient (LocalTmuxClient/SshTmuxClient)│
                │    ├─ CommandChannel + CommandBuilder        │
                │    ├─ SubscriptionManager (多 client 引用计数)│
                │    ├─ OutputMultiplexer + PaneOutputStream   │
                │    ├─ PaneTitleParser                        │
                │    ├─ HookInstaller (-t <session>) +         │
                │    │   HookCallbackServer (FIFO+pid路径)     │
                │    ├─ CommandDrivenEvents                    │
                │    ├─ SnapshotStore                          │
                │    ├─ HistoryCapture                         │
                │    ├─ BellCoordinator                        │
                │    ├─ InputEncoder (send-keys -H, 256B 切块) │
                │    ├─ ResizeArbiter                          │
                │    └─ ServerLifecycle + keep-alive           │
                └──────────────────────────────────────────────┘
```

## 文件变更

**新建**（`apps/gateway/src/tmux-client/`）

```
index.ts               types.ts            factory.ts
runtime-registry.ts    device-session-runtime.ts
local-client.ts        ssh-client.ts
command-channel.ts     command-queue.ts    sentinel.ts
command-builder.ts
ssh-bootstrap.ts       (远端 PATH / tmux 绝对路径探测)
subscription-manager.ts
output-mux.ts          pane-output-stream.ts
pane-title-parser.ts
input-encoder.ts       resize-arbiter.ts
event-bus.ts           hook-installer.ts   hook-callback-server.ts
command-driven-events.ts
snapshot-store.ts      history-capture.ts  bell-coordinator.ts
server-lifecycle.ts    keep-alive.ts
fs-paths.ts            (FIFO/目录路径 = /tmp/tmex/<device>-<pid>/..., stale 扫描)
debug.ts
transport/transport.ts transport/local-transport.ts transport/ssh-transport.ts
__tests__/{sentinel,command-channel,command-queue,command-builder,
           ssh-bootstrap,runtime-registry,subscription-manager,event-bus,
           bell-coordinator,snapshot-store,history-capture,hook-installer,
           hook-callback-server,server-lifecycle,output-mux,pane-title-parser,
           input-encoder,resize-arbiter,keep-alive,command-driven-events,
           fs-paths,integration}.test.ts
```

**删除（仅 control mode 相关）**

- `apps/gateway/src/tmux/connection.ts` + `connection.test.ts`
- `apps/gateway/src/tmux/parser.ts` + `parser.test.ts`
- **`apps/gateway/src/control/runtime.ts` 保留**（gateway 重启控制器）

**修改**

- `apps/gateway/src/ws/index.ts`：
  - 原 `new TmuxConnection(...)` 改为 `TmuxRuntimeRegistry.acquire(deviceId)`（refCount +1）
  - `DeviceConnectionEntry.connection` → `runtime: DeviceSessionRuntime`
  - `:286` `isComposing` 丢弃、`:547` paste 1024 char 切块、`:695` TERM_OUTPUT 过滤 全部保留
  - TERM_SELECT → per-client `selectedPanes` + `runtime.subscription.ref(paneId, wsId)` / 旧 pane `unref`
  - 每个写类入口完成后 `runtime.refreshSnapshot()`
  - WS 连接关闭：遍历 `selectedPanes` 逐个 `unref`，最后 `TmuxRuntimeRegistry.release(deviceId)`（refCount -1）
- `apps/gateway/src/push/supervisor.ts`：
  - `createConnection: (options) => new TmuxConnection(options)` → `TmuxRuntimeRegistry.acquire(deviceId, { purpose:'push' })`
  - 删除 `PushConnectionEntry.connection` 的独立生命周期，改为订阅 runtime events + bell handler 内 `lastSnapshot` age > 10s 兜底 `await runtime.refreshSnapshot()`
  - supervisor 自己不持有连接所有权，仅作为"长存订阅者"增加 refCount
- `apps/gateway/src/ws/borsh/{session-state,switch-barrier}.ts`：仅换事件源，状态机/协议不变
- `apps/gateway/src/events/index.ts`：subscribe 改源
- `apps/gateway/src/tmux/{ssh-auth,local-shell-path,bell-context}.ts`：保留复用
- `apps/gateway/src/runtime.ts`：引入 `TmuxRuntimeRegistry.startup()`（stale FIFO/dir 清理） + `shutdown()`（unset hook、remove FIFO、release all）；`pushSupervisor.start()` 顺序不变
- `apps/fe/tests/ws-borsh-follow-active.spec.ts`：**删除**（P2）

**文档/i18n 同步**

- `packages/shared/src/i18n/resources.ts:248`：`tmuxUnavailable` 文案
- `README.md:156`：替换 control mode 描述
- `docs/2026021000-tmex-bootstrap/architecture.md:5`：更新拓扑
- `docs/terminal/2026041400-tmux-external-cli-architecture.md`：新增，覆盖所有要点 + 明确"不同步外部 tmux 操作"

## §0 运行时注册表与生命周期（新）

**`TmuxRuntimeRegistry`**：进程单例。

```
acquire(deviceId): DeviceSessionRuntime   // refCount += 1，首次触发 connect
release(deviceId)                         // refCount -= 1，0 时 shutdown runtime
```

**`DeviceSessionRuntime`**：

- 生命周期：`bootstrap → ready → (normal ops) → shutdown`
- `bootstrap()`：
  1. `fs-paths.ensureBaseDir('/tmp/tmex/<deviceId>-<gatewayPid>/', 0o700)`
  2. 启动前扫描 `/tmp/tmex/<deviceId>-*/`（不含当前 pid）的 stale 目录，`rm -rf`
  3. 创建 `CommandChannel`（Local 直接 spawn；SSH 先走 `ssh-bootstrap`）
  4. `ServerLifecycle.ensureSession(sessionName)`：`has-session -t <session> || new-session -d -s <session> -c <homedir>`
  5. `HookCallbackServer.start()` **先于** `HookInstaller.install()`（否则 hook 触发写 FIFO 阻塞）
  6. `HookInstaller.install()` 注册 `alert-bell`/`pane-died`/`pane-exited`（session 级）
  7. 启动 `SnapshotStore` + 首次 refresh
- `shutdown()`（**必须执行**，绑到 refCount=0、进程退出、transport close、重连前 teardown）：
  1. `HookInstaller.uninstall()` → `set-hook -u -t <session> alert-bell; set-hook -u -t <session> pane-died; set-hook -u -t <session> pane-exited`
  2. `OutputMultiplexer.closeAll()`（逐个 `tmux pipe-pane -t <pane>`，不带参数停止）
  3. `HookCallbackServer.stop()` + unlink FIFO
  4. `CommandChannel.close()`（送 EOF/关 ssh channel）
  5. `fs-paths.removeBaseDir()`（best-effort）
- 断线重连路径：reconnect = **完整 shutdown + 完整 bootstrap**（新 FIFO 路径、重装 hook、重建订阅集合 pane stream、重新 snapshot）。旧 hook/FIFO 不复用
- 进程退出：`runtime.ts` 注册 `process.on('SIGINT'/'SIGTERM'/'exit')` → `TmuxRuntimeRegistry.shutdownAll()`

## §1 CommandChannel + CommandBuilder + SshBootstrap

### CommandBuilder

`quote(arg: string): string` — 单引号包裹，`'` → `'\''`；控制字符原样；`argv: string[]` → `arg.map(quote).join(' ')`。所有 tmux 参数（session 名、window 名、FIFO 路径、`pipe-pane -c 'cat >…'` 内层、`run-shell 'printf …'` 内层）必须经 quote；嵌套 shell 命令额外 `shSingleQuote` 再包一层。

### Local CommandChannel

`Bun.spawn(['/bin/sh', '-s'], { stdin, stdout, stderr, env })`；env 经 `buildLocalTmuxEnv(getLocalShellPath())` 注入；sentinel 协议见下。

### SSH CommandChannel（重写）

**不**使用 `ssh2.Client.shell()`（交互式 shell 会引 MOTD/PS1）。采用：

```
conn.exec('/bin/sh -s', { pty: false }, (err, stream) => { … })
```

- 无 pty → sshd 不触发 MOTD、shell 不加载 rc/profile（避免 `.bashrc` 提示符污染 sentinel）
- `pty: false` 是 ssh2 `exec` 默认；显式写明

**SshBootstrap 阶段**（所有后续命令前一次性执行）：

```sh
# step 1: 吸收常见登录 PATH
. /etc/profile 2>/dev/null || true
[ -f "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true
[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null || true

# step 2: 解析 tmux 绝对路径（缓存，后续所有调用用这个）
TMUX_BIN="$(command -v tmux 2>/dev/null || true)"
if [ -z "$TMUX_BIN" ]; then
  # 兜底搜常见路径
  for p in /usr/local/bin/tmux /opt/homebrew/bin/tmux /usr/bin/tmux /bin/tmux; do
    [ -x "$p" ] && TMUX_BIN="$p" && break
  done
fi

# step 3: 版本 + 报告（经 sentinel 回执）
if [ -z "$TMUX_BIN" ]; then
  printf 'TMEX_BOOT_FAIL tmux_not_found\n'
else
  printf 'TMEX_BOOT_OK %s %s\n' "$TMUX_BIN" "$("$TMUX_BIN" -V 2>/dev/null)"
fi
```

- 解析结果经 sentinel 回给 gateway；`TMUX_BIN` 缓存到 `CommandChannel`
- 后续所有命令用 `"$TMUX_BIN"` 而非 `tmux` 裸名，绕过 PATH 不确定性
- bootstrap 失败 → `DEVICE_EVENT.error{errorType:'tmux_unavailable'}`

### Sentinel 协议（不变）

```
{ "$TMUX_BIN" <quoted args…> ; } 2>&1
printf '\036TMEX_END %s %d\036\n' '<uuid-v4>' $?
```

接收端 `/\x1eTMEX_END ([0-9a-f-]{36}) (-?\d+)\x1e/` 扫描；UUID 不匹配丢弃；超时 10s（capture-pane 30s），只 reject Promise 不 kill 子进程；全局唯一串行队列。

## §2 Per-subscribed-pane Output

（不变，要点保留）

- `SubscriptionManager.ref(paneId, wsId)` / `unref(paneId, wsId)` 引用计数（多 client 共享订阅）
- `openPaneStream`：Local `mkfifo /tmp/tmex/<device>-<pid>/panes/<safe-paneId>.fifo`（0600）→ 打开读端 → `tmux pipe-pane -O -t <pane> 'cat >'<QuotedPath>`；SSH 远端同路径 + 独立 reader exec channel 跑 `cat <FIFO`
- **读端先打开**再发 pipe-pane 命令（否则 `cat >FIFO` 会阻塞写侧）
- 关闭：`tmux pipe-pane -t <pane>`（空参停止）→ close reader → unlink FIFO
- 背压 `highWaterMark=256KB`；断流 3 次指数退避重开失败 → `DEVICE_EVENT.error{errorType:'pipe_broken'}`
- SSH channel 预算：命令 shell (1) + hook-tail (1) + N 订阅 pane；超 10 拒新 ref

## §3 事件系统（最小 hook + 命令驱动 refresh + 完整生命周期）

**3 个 session 级 hook**：`alert-bell` / `pane-died` / `pane-exited`。

**安装顺序**（`DeviceSessionRuntime.bootstrap`）：
1. 创建 FIFO 目录 + FIFO 文件
2. **HookCallbackServer 先 start**（Local 打开 FIFO 读端；SSH 起 `tail -n +1 -f <FIFO>` exec channel）
3. 然后 `HookInstaller.install()` 逐条 `set-hook -t <session> <ev> "run-shell -b <Quoted(printf … >> <Quoted FIFO>)>"` — 三层 quote 全过 CommandBuilder

**teardown**（`shutdown` 或 reconnect 前）：
1. `set-hook -u -t <session> alert-bell`
2. `set-hook -u -t <session> pane-died`
3. `set-hook -u -t <session> pane-exited`
4. 关 reader + unlink FIFO

**命令驱动 refresh**（`CommandDrivenEvents`）：

- 监听 `CommandChannel.afterCommand`；写类命令（new-window/split-window/kill-window/kill-pane/select-window/select-pane/rename-window/resize-window 等）成功后：
  1. `SnapshotStore.refresh()` 执行 `list-windows -t <session> -F …; list-panes -s -t <session> -F …`
  2. 与上次快照 diff 合成 TMUX_EVENT 枚举（`window-add/close/renamed/active`、`pane-add/close/active`、`layout-change`；`bell`/`output` 走各自路径）
  3. push `runtime.events.snapshot` + `runtime.events.event`
- 50ms 合并窗口

**supervisor snapshot 新鲜度**：
- 同订阅 runtime.events.snapshot，`lastSnapshot` 自动新鲜
- bell handler 兜底：到达时若 `lastSnapshot == null || now - lastSnapshot.at > 10s` → `await runtime.refreshSnapshot()` 再 `resolveBellContext`

**启动时 stale 清理**（`fs-paths`）：
- 扫描 `/tmp/tmex/<deviceId>-*/`，排除当前 pid
- 对每个 stale 目录：尝试 `set-hook -u -t <每个可能的 session>`（best-effort 只对当前 deviceId 对应的 `device.session`）→ `rm -rf` 目录

## §4 PaneTitleParser

状态机扫描 `ESC ] (0|2) ; <text> (BEL | ESC \\)`；命中 emit `title_change`；不剥离原字节；`#{pane_title}` 作 snapshot 兜底。

## §5 Bell 双路径去重

保留 200ms 去重窗口。`BellCoordinator` 维护 `Map<paneId, {hookAt?, byteAt?}>`；复用 `bell-context.ts`。

## §6 Resize 仲裁

- `TERM_RESIZE` / `TERM_SYNC_SIZE` → `ws/index.ts` 按 windowId 汇总各 client → `ResizeArbiter` 取最小矩形 → 30ms debounce
- `set-option -w -t @N window-size latest; set-option -w -t @N aggressive-resize off; resize-window -t @N -x W -y H`
- 不再使用 `refresh-client -C`

## §7 历史捕获

- `display-message -p -t <pane> '#{alternate_on}'`；1 → `capture-pane -a -S - -E - -e -p -q`，否 → `capture-pane -S - -E - -e -p`
- 500ms 去重；输出保持原始 LF

## §8 输入 / 粘贴（三层保留）

- 第一层 `ws/index.ts:286`：`TERM_INPUT.isComposing === true` → return（不动）
- 第二层 `ws/index.ts:547`：`TERM_PASTE` 1024 字符切块（不动）
- 第三层 `InputEncoder`：UTF-8 后按 `SEND_KEYS_HEX_CHUNK_BYTES = 256` 字节切（对齐 `connection.ts:611`）→ `send-keys -t <pane> -H <hh> …`，经 `CommandBuilder`
- bracketed-paste 由客户端自行附加 `\x1b[200~ / \x1b[201~`

## §9 Server 生命周期 & 保活

- `ensureSession`：`has-session -t <session> || new-session -d -s <session> -c <homedir>`
- **Close-last-window 保活**：`KIND_TMUX_CLOSE_WINDOW` / `pane-exited` 触发前检查 `list-windows -t <session> | wc -l`；为 1 则先 `new-window -d -t <session>`，再执行 kill
- 远程 `tmux kill-session -t <session>` / `kill-server` → CommandChannel EOF → `shutdown + emit DEVICE_EVENT.disconnected`

## §10 SSH channel 拓扑

- 1 × 命令 exec channel（`sh -s` 无 pty，长存）
- 1 × hook-pipe tail exec channel（长存）
- N × 订阅 pane reader exec channel（通常 1-3）
- keepalive `interval=15s, countMax=3`；断线指数退避 1/2/4/8/16s；重连路径 = shutdown + bootstrap
- `ssh-bootstrap` 失败 → `tmux_unavailable`

## 迁移阶段

| Phase | 工作内容 | 验证点 |
| --- | --- | --- |
| **P0** 骨架 | 新目录、`TmuxClient` 接口、`TmuxRuntimeRegistry` 接口 + 空实现、`CommandBuilder`、`fs-paths` + 单测；`ws/index.ts` + `push/supervisor.ts` import 切新路径（临时 throw）；编译通过 | `bun test` 通过；`command-builder.test.ts` / `fs-paths.test.ts` 绿 |
| **P1** 本地核心 | CommandChannel Local + env 注入、ServerLifecycle + keep-alive、SnapshotStore、HookInstaller（**reader 先于 install；shutdown 必 unset**）、HookCallbackServer、SubscriptionManager、OutputMultiplexer + PaneOutputStream（Local FIFO，`<device>-<pid>` 路径）、PaneTitleParser、HistoryCapture、InputEncoder（256 字节切块）、ResizeArbiter、CommandDrivenEvents、`DeviceSessionRuntime` + Registry；**ws 与 push 共享同一 runtime** | 本地设备 connect→select→history→live→input（IME 中间态丢弃 + 1024 切块 + 大粘贴）→resize→split→close-last-window→shutdown（hook unset 可观测）→reconnect（新 pid 目录、旧 FIFO 清）全通；单元全绿 |
| **P2** 事件完备 + bell + supervisor + 清理外部同步 | EventBus 合成 TMUX_EVENT、BellCoordinator 双路径、`push/supervisor.ts` 切 runtime 源 + bell 兜底 refresh；**删除 `ws-borsh-follow-active.spec.ts`** | `ws-borsh-switch-barrier / history / resize` Playwright 通过；`supervisor.test.ts` 绿 |
| **P3** SSH | SshTransport、`ssh-bootstrap` 远端 PATH / tmux 绝对路径探测、`/bin/sh -s` 无 pty 命令通道、远端 FIFO reader、重连走 shutdown+bootstrap、`tmux_unavailable`、`ssh-agent-local.integration.ts` | 真实 SSH 设备端到端（目标机 tmux 在 `/usr/local/bin` / `/opt/homebrew/bin` 等非默认 PATH 亦通）；`devices.spec.ts` / `settings.spec.ts` 通过 |
| **P4** 清理 + 文档 | 删 `tmux/connection.ts` + `tmux/parser.ts`（**保留 `control/runtime.ts`**）；同步 i18n/README/architecture.md；新增 `docs/terminal/2026041400-...`；biome/lint；`plan-00-result.md` | 全量 `bun test` + 回归清单通过；手动 QA 清单过 |

（Phase 5 可选：订阅集合 LRU；`STATE_SNAPSHOT_DIFF` 增量快照。外部 tmux 操作同步不恢复。）

## 验证

### 单元（新增）

`sentinel`、`command-channel`（大输出/超时/僵死）、`command-queue`、`command-builder`（空格/单引号/分号/控制字符/嵌套）、`ssh-bootstrap`（PATH 注入 + tmux 绝对路径探测 + 不存在时报 `tmux_unavailable`）、`runtime-registry`（refCount acquire/release/shutdown + 并发安全）、`subscription-manager`、`event-bus`（NDJSON 跨行 + 3 hook + diff 合成）、`bell-coordinator`（四象限 + lastSnapshot 老旧 refresh）、`snapshot-store`、`history-capture`、`hook-installer`（断言只装 3 个、作用域 `-t <session>`、**reader 未 ready 时拒绝 install**、**shutdown 必发 `set-hook -u`**）、`hook-callback-server`（FIFO 创建 → 打开 → 读 NDJSON；路径含 pid）、`server-lifecycle` + `keep-alive`（close-last-window 先建隐藏 window）、`output-mux`（Local FIFO + SSH reader）、`pane-title-parser`、`input-encoder`（UTF-8 256 切块 + hex）、`resize-arbiter`、`command-driven-events`、`fs-paths`（stale 扫描 + 清理、路径拼装）、`integration`（真 tmux）。

### Playwright 回归（必过）

- `ws-borsh-switch-barrier.spec.ts` / `ws-borsh-history.spec.ts` / `ws-borsh-resize.spec.ts`
- `sidebar-delete.spec.ts` / `devices.spec.ts` / `terminal-ui.spec.ts` / `settings.spec.ts` / `mobile-*.spec.ts`

**删除**：`ws-borsh-follow-active.spec.ts`。

### 手动 QA 清单

连接本地/SSH、输入 / 粘贴 / IME 中间态丢弃 / 超大粘贴（>10KB 跨 1024/256 切块）、resize（桌面+移动）、bell toast、split/close pane、**关闭最后窗口保活**、大输出（`yes|head -100000`）、SSH 断网 5s 恢复（`shutdown + bootstrap` 重装 hook、重开 FIFO）、**SSH 目标机 tmux 仅存于非默认 PATH（如 `/opt/homebrew/bin`）时 ssh-bootstrap 成功**、SSH 无 tmux → `tmux_unavailable`、**远程 `tmux kill-session -t <session>` 触发后 gateway shutdown 干净（hook 自动 unset）**、pane 标题 OSC 实时、pane `exit` 经 `pane-died`/`pane-exited` 清理、**session/window 名含空格或单引号命令链不崩**、**gateway 重启后 stale `/tmp/tmex/<device>-<oldpid>` 被清理**。

**不在验证范围**：外部 `tmux attach` 操作同步、"多 WS client 不同 pane 长期分离"（FE 全局 `pane-active` 状态无法支持）、从 webui 发起 rename window（FE store 无此能力）、书签。

## 关键文件路径

- `apps/gateway/src/tmux/connection.ts`（待删；迁移对照：`buildLocalTmuxCommand` → `ServerLifecycle`、`sendUtf8Bytes` → `InputEncoder`、close-last-window → `keep-alive.ts`、SSH `conn.exec` 带 pty → 新 SSH 通道 `exec /bin/sh -s` 无 pty + bootstrap）
- `apps/gateway/src/tmux/parser.ts`（待删；OSC title → `pane-title-parser.ts`）
- `apps/gateway/src/ws/index.ts`（`:286/:547/:695` 保留；`:586` 改 `TmuxRuntimeRegistry.acquire`；WS close 调 release）
- `apps/gateway/src/push/supervisor.ts:37/:71/:274/:308`（改 Registry.acquire + runtime events 订阅 + bell 兜底 refresh）
- `apps/gateway/src/runtime.ts`（startup 扫 stale dir；注册 shutdown 钩子）
- `apps/gateway/src/ws/borsh/{session-state,switch-barrier}.ts`（换事件源）
- `apps/gateway/src/events/index.ts`（换源）
- `apps/gateway/src/tmux/{ssh-auth,local-shell-path,bell-context}.ts`（保留）
- `apps/gateway/src/control/runtime.ts`（**保留不动**）
- `apps/fe/src/stores/tmux.ts:234`（errorType 确认兼容，不改）
- `apps/fe/tests/ws-borsh-follow-active.spec.ts`（P2 删除）

## 风险与兜底

| 风险 | 兜底 |
| --- | --- |
| ws 与 push 各起连接导致 `pipe-pane`/`set-hook` 互踩 | **`TmuxRuntimeRegistry` 共享 `DeviceSessionRuntime` 单例**；refCount 管理生命周期 |
| SSH 交互 shell 的 MOTD/PS1 污染 sentinel | `conn.exec('/bin/sh -s', { pty: false })` + `ssh-bootstrap` 源 profile 并解析 `$TMUX_BIN` 绝对路径 |
| 远端 tmux 不在默认 PATH | `ssh-bootstrap` 源 `/etc/profile` / `~/.profile` / `~/.bash_profile` + 兜底搜 `/usr/local/bin /opt/homebrew/bin /usr/bin /bin`；缓存 `$TMUX_BIN` |
| Hook 残留（gateway crash / reconnect） | FIFO 路径含 gateway pid；启动 scan 清 stale；shutdown/reconnect 必发 `set-hook -u`；重连走完整 shutdown+bootstrap |
| Hook 触发时 FIFO 无 reader | **reader 先 start，hook 后 install**；`hook-installer` 断言 reader ready |
| 多 WS client "不同 pane" QA 与 FE 冲突 | 已删除该 QA 条目（FE 全局 `pane-active` 状态不可支持，且 FE 不改） |
| Marker `\x1e` 冲突 | UUID 校验丢弃 |
| Shell profile 污染 (Local) | `sh -s` 无 login；`buildLocalTmuxEnv` 注入 PATH |
| Shell 转义（session 名含空格/单引号） | 所有 arg 过 `CommandBuilder.quote`；单测覆盖 |
| FIFO 权限/存在 | `0700` 目录、`0600` FIFO；路径含 device+pid+pane |
| SSH `pipe-pane 'cat'` stdout 空 | 远端 FIFO + 独立 reader channel |
| tmux < 3.2 或不存在 | 自检 → `tmux_unavailable` |
| supervisor `lastSnapshot` 陈旧 | bell handler age > 10s 主动 refresh |
| SSH channel 上限 | 订阅集合 + 2 长存 channel；超 10 告警 |
| `kill-server`/`kill-session` 竞态 | CommandChannel close → reject in-flight + emit disconnected |
| 背压 | `highWaterMark=256KB` |
| OSC 标题跨包 | 解析状态机持久化 + `#{pane_title}` 兜底 |
| 外部 tmux 操作同步能力 | 已放弃；不预留 |
| `control/runtime.ts` 误删 | 明示保留；P4 review |
| 书签误入范围 | 明示不在范围 |
| Windows 平台 | 不在 MVP；README 明示 |

## 归档

本 plan 复制到 `prompt-archives/2026041400-tmux-external-cli-refactor/plan-00.md`；P4 结束写 `plan-00-result.md`。
