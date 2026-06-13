# 执行结果

分支：`worktree-prod-crash-hardening`（worktree：`.claude/worktrees/prod-crash-hardening`）。
三处问题各一个独立 commit，外加一个存档 commit。全程未碰生产（`~/Library/Application Support/tmex/`）。

## 改动与验证

### commit 1 · fix(gateway) 隐患1：history 超时兜底解除输出门控
- `apps/gateway/src/ws/borsh/switch-barrier.ts`：`handleTimeout` 的 `history` 分支在 `sendLiveResume`
  之后**无条件**补 `sessionStateStore.stopOutputBuffering(ws, deviceId)`。`sendLiveResume` 有 5 处提前 return
  （pending 空 / 状态非 ACKED·HISTORY_APPLIED / token 不匹配 / borshState 空 / 转移 LIVE 失败），
  任一命中原先都到不了内部解除门控的那行，导致门控永久卡 `BUFFERING`、每段输出刷 `Output buffer overflow`。
  兜底幂等，成功路径下为空操作。
- `apps/gateway/src/ws/borsh/index.test.ts`：新增确定性测试——经 `(switchBarrier as any).handleTimeout`
  直接触发 history 超时（不等真实 1.5s 定时器），先把 `ws.data.borshState` 置空制造 `sendLiveResume`
  提前 return，断言超时后 `isBuffering === false`。反向验证：移除兜底行该测试 fail（Received: true），恢复后 pass。

### commit 2 · fix(gateway) 隐患3：SQLite PRAGMA 加固
- `apps/gateway/src/db/client.ts`：新增导出 `applyPragmas(database)`，依次设
  `foreign_keys=ON` / `journal_mode=WAL` / `busy_timeout=5000` / `synchronous=NORMAL`；
  `ensureSqliteClient` 改为调用它。
- `apps/gateway/src/db/client.test.ts`（新增）：临时**文件**库（WAL 不支持 `:memory:`）+ 唯一路径，
  读回断言（列名经实测）：`journal_mode=wal`、`busy_timeout` 列名 `timeout=5000`、`foreign_keys=1`、`synchronous=1`。
- 说明：本项属 DB 健壮性加固，**与本次 SQLITE_FULL 非同一根因**（根因在已被替换的旧运行时，详见 `background.md`）。

### commit 3 · fix(app) tmux 跨平台存活
- `packages/app/src/lib/service.ts`：systemd 单元 `[Service]` 加 `KillMode=process`（stop/restart/crash 只处理
  MainPID、不杀整个 cgroup）；launchd plist 在 KeepAlive 后加 `AbandonProcessGroup`/`true`；`buildLaunchdPlist`
  改为 export 以便测试。
- `packages/app/src/lib/service.test.ts`：systemd 用例补 `KillMode=process` 断言；新增 `buildLaunchdPlist` 用例
  断言含 `AbandonProcessGroup` 紧跟 `<true/>`。
- `docs/service/2026061400-process-survival.md`（新增）：记录两平台改动语义、Linux logout/reboot 的
  `KillUserProcesses` 边界（需用户手动 `loginctl enable-linger`，tmex 不代为启用）、生效方式与一次性副作用。

## 测试
worktree 内 `NODE_ENV=test`：
- `bun test apps/gateway/src` → **510 pass / 0 fail**（含新增门控泄漏测试、db PRAGMA 测试）。
- `bun test packages/app/src` → **14 pass / 0 fail**（含 service 模板新断言）。

## 待用户处理（不在本次代码范围）
- 服务模板改动**仅在安装/升级时重渲染**：现有生产安装需用户自行 `tmex upgrade`/重装才落地；
  且**携带本修复的那一次升级自身的 stop/restart 仍按旧策略掉一次 tmux**，此后才受保护。
- Linux 跨 logout/reboot 存活需用户按需 `loginctl enable-linger <user>`（本次按决策不代为启用）。
- 合并：分支 `worktree-prod-crash-hardening`，可发 PR 或并入 main 后由用户走正式发版。
