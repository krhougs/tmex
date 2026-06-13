# 修复计划：tmux 进程独立存活 + 输出门控泄漏 + DB PRAGMA 加固

## Context（背景）

本机生产 tmex（launchd 常驻，监听 9883）发生过一次崩溃刷屏。完整调查见
`prompt-archives/2026061403-prod-sqlite-full-crash/`。结论：

- **原始崩溃**（`flushOutputBuffer → SQLITE_FULL` 刷屏 7.2 万行）发生在一套**已被淘汰的旧运行时**里，
  该路径在当前仓库 git 历史中从未存在，当前生产 bundle（06:27 重建）也已无此路径。**即时火情已灭。**
- 因此本计划**不去追那段死代码**，而是修三件当前代码里真实存在、且与本次事故同源的问题。

用户已确认范围：**隐患1 修、隐患2 不管、隐患3 修**，并追加一个更重要的架构诉求——
**业务用的 tmux 进程不能跟着 tmex 一起死**（tmex 崩溃/重启后，pane 里跑的东西要存活，事后还能 attach）。

用户对 tmux 诉求的明确约束：
1. 必须**同时覆盖 Linux 和 macOS**；
2. tmex **不需要完全管理** tmux daemon，「只要能 attach 上就行」——只需简单地起一个不随 tmex 死的 tmux，
   不要引入独立 socket / 完整生命周期托管（已排除「独立固定 socket」方案）。

三块改动放在**同一个分支**。注意：服务定义（plist/systemd unit）只在**安装/升级时**重新生成，
本计划改的是模板，**生效需用户事后自行 `tmex upgrade` / 重装服务**——我不碰生产，不重启服务。

---

## 改动一：tmux 进程独立存活（跨平台，核心诉求）

### 根因（已查证）
tmex 用 `tmux new-session -d` 起 server（`local-external-connection.ts:361`），tmux 自身会 daemon/setsid
脱离——所以 server **本就在独立 session 里**。真正把它带走的是**服务管理器的 kill 策略**：

- **Linux systemd**：unit 缺 `KillMode`，默认 `control-group` → stop/restart 时杀**整个 cgroup**，
  连 setsid 脱离的 tmux 也一起杀。（`service.ts:45-71`，`buildSystemdServiceContent`）
- **macOS launchd**：plist 缺 `AbandonProcessGroup` → 默认 `false`，重启时 SIGKILL **整个进程组**。
  （`service.ts:82-113`，launchd 模板）

tmex 代码侧**不主动** kill server（全仓无 `kill-server`/`kill-session`），所以无需改 app 逻辑，
只改两个服务模板即可让 tmux 存活。这正符合用户「简单起一个不随 tmex 死的 tmux」的哲学。

### 改法
文件 `packages/app/src/lib/service.ts`：

1. **systemd unit（`buildSystemdServiceContent`，约 45-71）**：在 `[Service]` 段加一行
   ```ini
   KillMode=process
   ```
   语义：stop/restart/crash 时 systemd 只处理 MainPID（`exec` 的 bun 进程），不再杀整个 cgroup，
   daemon 化的 tmux server 存活。现有 `Type=simple` / `Restart=always` / `RestartSec=3` / `TimeoutStopSec=20` 不动。

2. **launchd plist（约 82-113）**：在 `<dict>` 里加
   ```xml
   <key>AbandonProcessGroup</key>
   <true/>
   ```
   语义：launchd 终止/重启该 job 时不向进程组广播信号，tmux server 与残留控制客户端不被连带杀。
   （可选）同时加 `<key>ThrottleInterval</key><integer>10</integer>` 显式化重启节流，抑制类似刷屏导致的紧重启循环；launchd 默认本就是 10s，加上只是显式。

> 不在 run.sh 里加 `setsid`：`Type=simple` 下 `exec setsid bun ...` 会 fork 出新进程导致 systemd 的
> MainPID 跟踪错位，得不偿失。tmux server 已自带 daemon 化，靠上面两个 kill 策略即可，无需动 run.sh。
> 控制模式客户端（`tmux -C attach`）是 gateway 直接子进程，被回收无妨——下次启动 tmex 会重连。

### 兼容性分析（已查证）

**macOS（launchd `AbandonProcessGroup=true`）**
- launchd.plist(5) 文档明确：默认 job 死亡时 launchd 会杀掉与 job 同进程组的残留进程；置 `true` 关闭该传播，
  子进程得以存活。长期存在的 key（OS X 10.x 起），现代 macOS（11~15+）全支持，无版本风险。
- 覆盖范围：crash、`launchctl bootout`、KeepAlive 重启、`kickstart -k` —— 都不再误杀 tmux。✓

**Linux（systemd `--user` 单元 `KillMode=process`）**
- `KillMode=process` 自 systemd 早期即有，主流发行版近十年版本（Ubuntu 16.04+/Debian 9+/RHEL·CentOS 7+/
  Fedora/Arch/openSUSE 等）全支持，未废弃（被劝退的是 `KillMode=none`，不是 `process`）。
  语义：stop/restart/crash 时只对 MainPID 发信号，cgroup 内其他成员（daemon 化的 tmux）保留。✓
  覆盖 `systemctl --user stop|restart tmex` 与进程自身崩溃。
- **注意 setsid 不改 cgroup**：tmux `new-session -d` 虽 setsid，但仍在该 user service 的 cgroup 内；
  靠 `KillMode=process`（cgroup 感知）才不被连带杀，这正是所选方案能成立的关键。

**Linux 关键边界 —— logout/reboot 需要 linger（已查证 tmex 当前未启用）**
- tmex Linux 走**用户级** systemd（`systemctl --user`，单元挂在 `user@UID.service` 切片下）。
  当该用户**最后一个登录会话结束**，systemd 停掉整个 user 切片，默认 `KillUserProcesses=yes`
  会**无视 per-unit KillMode** 杀光切片内所有进程——连脱离的 tmux 和 tmex 自身一起。
- 要让进程跨 logout/reboot 存活，须 `loginctl enable-linger <user>`。**仓库内全无 linger/loginctl**
  （已 grep 确认），即 tmex 当前安装**不启用 linger**——这是先于本次改动就存在的局限，也影响 tmex 自身的常驻性。
- 对本次诉求（「tmux 不随 tmex **崩溃/重启**而死」）：`KillMode=process` 已足够，logout/reboot 是另一根轴。
- **已决策：不在安装路径里启用 linger**（不擅自改用户账户系统状态）。本次只保证崩溃/重启存活；
  logout/reboot 仍会掉，**写进文档**提示用户按需自行 `loginctl enable-linger <user>`。
  → 新增/更新一处文档（`docs/` 下服务安装相关，或 README 服务章节），说明：
  Linux 用户级 systemd 下 tmex/tmux 跨 logout/reboot 存活需手动 `enable-linger`；并说明 `KillMode=process` 的作用边界。

**Windows**：`detectServiceManager` 返回 `none`，不安装服务，本改动不涉及。

### 安装/升级流程联动（已查证，决定改动范围）
一键安装/升级会自动落地新模板，**无需额外迁移代码**：
- `runInit`（`commands/init.ts`）和 `runUpgrade`（`commands/upgrade.ts:120-125`）都调同一个
  `installService()`（`service.ts:188-202`），它**每次都重新渲染**模板 → 写盘覆盖旧
  plist/unit → systemd `daemon-reload` / launchd `bootstrap` → 重启服务。无版本条件、无跳过逻辑。
- 因此只改 `service.ts` 两个模板函数（+ 测试）即可；用户跑一次 `tmex upgrade` 新策略即生效。
- **一次性副作用（需写入 result 并告知用户）**：`runUpgrade` 在重部署前先 `stopService`，
  而 stop 用的是**磁盘上的旧定义**（launchd `bootout` / systemd `stop`，旧策略仍会杀进程组/cgroup）。
  所以**携带本修复的这一次升级，自身的 stop/restart 仍会把当前 tmux 带走一次**；
  此后所有崩溃/重启才受新策略保护。这是一次性的，不引入额外复杂度去规避。

### 关键文件
- `packages/app/src/lib/service.ts`（`buildSystemdServiceContent` 45-71、`buildLaunchdPlist` 82-113 两个模板）
- 安装/升级调用链 `commands/init.ts` + `commands/upgrade.ts` + `service.ts:installService`：**只读确认，无需改**
- 复用现成平台判断 `packages/app/src/lib/platform.ts:detectServiceManager()`（无需新造）
- 新增一处文档（`docs/` 服务安装相关）说明 Linux `enable-linger` 的 logout/reboot 边界与 `KillMode=process` 作用范围

---

## 改动二：隐患1 — history 超时导致输出门控永久卡 BUFFERING（最小兜底）

### 根因（已查证）
`apps/gateway/src/ws/borsh/switch-barrier.ts` 的 `handleTimeout`（374-404）在 `history` 分支
（388-393）只调 `sendLiveResume` 后 `return`，解除门控完全依赖 `sendLiveResume` 内部
（300 行的 `stopOutputBuffering`）。但 `sendLiveResume`（269-334）有 **5 处提前 return**
（pending 空 / 状态非 ACKED|HISTORY_APPLIED / token 不匹配 / borshState 空 / `transitionSelectState('LIVE')` 失败），
任一命中都**到不了** `stopOutputBuffering`，门控永久停在 `BUFFERING`，之后每段输出都刷
`Output buffer overflow`。违反 fail-fast 原则。

### 改法（用户选「最小兜底」）
在 `handleTimeout` 的 `history` 分支，`sendLiveResume(...)` 之后**无条件**补一次解除门控：
```ts
if (stage === 'history') {
  this.sendLiveResume(ws as any, deviceId, expectedToken);
  // 兜底：无论 sendLiveResume 是否提前 return，确保门控被解除，避免永久 BUFFERING
  sessionStateStore.stopOutputBuffering(ws, deviceId);
  pending.callbacks.onTimeout?.(stage);
  return;
}
```
`stopOutputBuffering` 幂等：成功路径下 sendLiveResume 已把 buffer flush 并置 FLOWING，再调返回空数组、无副作用；
仅在罕见的提前 return 路径上丢弃尚未 flush 的 buffer——超时/异常场景下丢这点缓冲可接受，
代价远小于门控泄漏。

### 关键文件
- `apps/gateway/src/ws/borsh/switch-barrier.ts`（`handleTimeout` history 分支，约 388-393）

### 测试
`apps/gateway/src/ws/borsh/index.test.ts` 新增用例（沿用现有 `mockWs` + `sessionStateStore.create` +
`switchBarrier.startTransaction` 写法，参考 147-169 的 isBuffering 测试）：
- 构造 `wantHistory: true` 事务 → `sendSwitchAck` 进 ACKED → 直接调 `handleTimeout(ws, deviceId, 'history', token)`
  模拟 history 超时；
- 关键断言：制造一个 `sendLiveResume` 会提前 return 的条件（如 token 不匹配，或 borshState 缺失），
  仍断言 `sessionStateStore.isBuffering(mockWs, deviceId) === false`（修复前为 true，暴露泄漏）。

---

## 改动三：隐患3 — DB 客户端缺 busy_timeout / 显式 WAL（健壮性加固）

> 说明：此项与本次 SQLITE_FULL **非同一根因**（那是死代码），属长期 DB 健壮性加固。

### 根因（已查证）
`apps/gateway/src/db/client.ts` 的 `ensureSqliteClient()` 只设了 `PRAGMA foreign_keys = ON`，
缺 `busy_timeout`（WAL 并发下锁冲突直接 `SQLITE_BUSY` 而非退避重试）与显式 `journal_mode=WAL`。
全仓仅此一处建 `bun:sqlite` 的 `Database`（`client.ts:11`），PRAGMA 统一设在这里即可。

### 改法
把 PRAGMA 设置抽成一个可单测的小函数并在建库后调用：
```ts
export function applyPragmas(database: Database): void {
  database.run('PRAGMA foreign_keys = ON');
  database.run('PRAGMA journal_mode = WAL');
  database.run('PRAGMA busy_timeout = 5000');
  database.run('PRAGMA synchronous = NORMAL'); // WAL 下兼顾持久性与性能
}
```
`ensureSqliteClient()` 里 `new Database(config.databaseUrl)` 后改调 `applyPragmas(sqliteClient)`。
（`databaseUrl` 来自 `config.ts:23`，三套环境均为文件库，非 `:memory:`，支持 WAL。）

### 关键文件
- `apps/gateway/src/db/client.ts`

### 测试
新增针对 `applyPragmas` 的单测（对一个临时文件库直接建 `Database` → `applyPragmas` →
读回断言）：`PRAGMA journal_mode` 返回 `wal`、`PRAGMA busy_timeout` 返回 `5000`。
抽成独立函数是为了绕开 `ensureSqliteClient` 的单例缓存、保证测试隔离。

---

## 验证

统一在 `NODE_ENV=test`（仓库根 `test.env`）下跑，不碰生产：

1. **单测**：
   - `bun run --filter @tmex/gateway test`（switch-barrier 门控兜底、db applyPragmas）
   - `bun run --filter @tmex/app test`（service 模板含 `KillMode=process` / `AbandonProcessGroup`）
2. **服务模板内容**：`service.test.ts` 断言渲染结果含新字段（systemd `KillMode=process`；launchd `AbandonProcessGroup`）。
3. **tmux 存活端到端（用户侧，我不执行）**：用户跑 `tmex upgrade`（它会重写服务定义并重启，
   这一次仍会按旧策略掉一次 tmux），升级完成后再触发一次 `systemctl --user restart tmex`（Linux）/
   launchd 重启（macOS）或制造一次 tmex 崩溃，确认**这次** `tmux ls`（对应 socket）pane 内进程仍存活。
   —— 此步需真实安装，按约束由用户在生产侧自行验证。
4. （可选）仓库内临时实例：按 AGENTS.md 显式覆盖 `GATEWAY_PORT`/`TMEX_FE_DIST_DIR`/`TMEX_BIND_HOST` 等
   起临时 tmex，验证门控与 DB 改动不影响正常收发；不复用生产 9883、不读生产 env。

## 注意事项
- 三处改动互相独立，集中在一个分支；改完把结果写入 `prompt-archives/2026061403-prod-sqlite-full-crash/plan-00-result.md`。
- 服务模板改动**不会**自动作用于现有生产安装，需用户事后 `tmex upgrade` / 重装服务才生效。
- 隐患3 是健壮性加固，**不要**对外宣称它修复了本次 SQLITE_FULL（根因是已被替换的旧代码）。
- 不动生成文件、不 lint 生成物；不碰 `~/Library/Application Support/tmex/`，不 kill/重启生产服务。
