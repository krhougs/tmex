# 崩溃背景与根因分析

## 一、现象（崩溃当时，约 06:22）

`tmex.err.log` 涨到 **12MB / 83523 行**，其中 **72868 行（87%）** 是同一句刷屏：

```
[session-state] Output buffer overflow for beeaf877-5b7e-4d7b-8de5-57bcaee3a6ed
```

真正的根因信号（被刷屏淹没，去重后才看到）：

```
[session-state] flushOutputBuffer error for <id>: SQLITE_FULL: database or disk is full
```

伴随的崩溃链尾部：

```
[switch-barrier] Transaction timeout at stage: history for <id>
[local] tmux control client exited (code 1) on <id>, reconnecting (attempt 1)
[local] tmux session gone on <id>: no server running on /private/tmp/tmux-501/default
[conn-alert] device <id> (local) source=close type=connection_closed: ssh_connection_closed
```

崩溃后 launchd `KeepAlive` 自动拉起新进程（PID 14352 → 之后又换成 78223）。

## 二、关键否证：不是磁盘满

- 数据卷 `/System/Volumes/Data` 还有 **783GB** 空闲。
- 当前仓库 DB 初始化 `apps/gateway/src/db/client.ts:9-16` 只设了 `PRAGMA foreign_keys = ON`，
  **没有设 `max_page_count`**；bun:sqlite 默认上限约 281TB，正常撞不到。
- 因此 `SQLITE_FULL` 不是「磁盘满」，而是崩溃当时那套**旧运行时**特有的写入路径所致。

## 三、决定性发现：崩溃的是旧运行时，当前代码已无该架构

对崩溃字符串做全仓 + 全 git 历史检索：

| 字符串 | 当前仓库源码 | 全 git 历史（`git log --all -S`） |
| --- | --- | --- |
| `flushOutputBuffer` | **0** | **0（从未存在）** |
| `SQLITE_FULL` | 0 | 0 |
| `max_page_count` | 0 | 0 |
| `Output buffer overflow` | 1（`session-state.ts:386`） | 有（`890a7fc wip: fe`） |

对生产 bundle `~/Library/Application Support/tmex/runtime/server.js`（纯文本，只读 grep）：

| 字符串 | 命中数 |
| --- | --- |
| `flushOutputBuffer` | 0 |
| `SQLITE_FULL` | 0 |
| `max_page_count` | 0 |
| `Output buffer overflow` | 1 |

即：当前仓库与**当前生产 bundle**都已经**没有** `flushOutputBuffer`（把终端输出写进 SQLite 的那条路径）。
当前的输出缓冲是**纯内存环形缓冲**：

`apps/gateway/src/ws/borsh/session-state.ts`
- `OutputGateContext.buffer: Uint8Array[]`，`maxBufferSize: 1000`（行 67-71、356）。
- `bufferOutput()`（行 381-392）：BUFFERING 状态下，buffer 满 1000 就打印
  `Output buffer overflow` 并 `shift()` 丢弃最旧一条，再 push。**不写 SQLite。**

结论：**崩溃发生在一套已经被淘汰的旧运行时**（把输出 flush 进 SQLite，撞 SQLITE_FULL 后反复重试失败、每条新输出刷一行 overflow，把日志撑到 12MB、IO/事件循环打满 → switch-barrier 超时 → tmux 控制连接退出 → 进程崩溃 → launchd 重启 → 循环）。

## 四、时间线（文件 mtime 佐证）

| 时间 | 事件 |
| --- | --- |
| 05:57 | 崩溃后 launchd 拉起 PID 14352（旧 runtime） |
| ~06:22:05 | `tmex.err.log` 写到 12MB 后**冻结**，SQLITE_FULL/overflow 刷屏停止 |
| 06:27:30 | `runtime/server.js` 被**重建替换**（新代码，无 flushOutputBuffer/SQLITE_FULL） |
| 06:27:54 | `tmex.log` 最后写入；当前进程 PID 78223 |

`err.log` 自 06:22 起不再增长 → **SQLITE_FULL 崩溃循环已终止**，重建的新 bundle 不再走那条路径。
即时火情已灭，但属于「碰巧被一次重建带过」，并非定向修复。

## 五、当前代码里仍存在的隐患（汇报重点，待用户定夺）

### 隐患 1：history 超时若 LIVE 转移失败，输出门控会永久卡在 BUFFERING

`apps/gateway/src/ws/borsh/switch-barrier.ts`
- `handleTimeout` 的 history 分支（行 388-393）只调 `sendLiveResume` 后 `return`，
  **本身不直接** `stopOutputBuffering`（对比 ack 分支行 397 是直接停的）。
- 解除门控依赖 `sendLiveResume` 内部行 300 的 `stopOutputBuffering`，
  但该调用在行 295 `transitionSelectState(...,'LIVE')` **成功之后**；
  若该转移失败（行 296 提前 return，例如当前态不是 ACKED/HISTORY_APPLIED），
  则**永不**执行行 300，门控**永久停在 BUFFERING**。
- 后果：之后该设备每来一段输出都进 `bufferOutput`，满 1000 后**每条都打** `Output buffer overflow`
  → 重现刷屏（虽无 SQLITE_FULL，但日志膨胀 + 噪声依旧）。
- 违反 memory 记录的 **fail-fast / 告警只发一次** 原则：写失败/异常态不收敛、还高频刷日志。

### 隐患 2：overflow 告警未去重/未限频

`session-state.ts:386` 在 buffer 满后对**每一条**输入都 `console.warn`。即便门控最终能解除，
一次较慢的事务也可能刷大量同句日志。应**每个 buffering 周期只告警一次**（或限频），符合「告警只发一次」。

### 隐患 3（与本次崩溃无直接因果，属 DB 健壮性）

`apps/gateway/src/db/client.ts:9-16` 仅设 `foreign_keys=ON`：
- 未设 `busy_timeout` → WAL 并发下易直接 `SQLITE_BUSY`。
- 未显式 `journal_mode=WAL` / `wal_autocheckpoint`（依赖默认）。
- 建议补 `busy_timeout`、显式 WAL 配置，作为长期健壮性加固（与本次 SQLITE_FULL 非同一根因）。

## 六、仍未坐实的点

- 旧运行时 `SQLITE_FULL` 的精确触发点（max_page_count？独立 output 库的容量上限？临时目录卷满？）
  **无法从当前代码/git 历史复原**——那段把输出写 SQLite 的代码从未进过本仓库 git 历史，
  只存在于已被替换的旧发布产物里。继续深挖死代码价值低。
- 当前生产 bundle（06:27 重建）对应哪个版本/分支，未核实；`install-meta.json` 记 `cliVersion 0.8.2`
  （`updatedAt 2026-06-13T22:27:30Z`），但 06:27 的 server.js 比它新，疑似 dev 重建写入了 runtime 目录。
