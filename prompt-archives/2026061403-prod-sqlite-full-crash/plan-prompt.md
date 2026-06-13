# 本机生产 tmex 崩溃排查（SQLITE_FULL → 输出缓冲刷屏）

归档时间：2026-06-14
归档目录：`prompt-archives/2026061403-prod-sqlite-full-crash/`

## 用户原始诉求（按时间顺序）

1. 「刚刚本地跑的 tmex 生产崩溃了，帮我看看为什么。」
2. 澄清：「不是还活着，是自动重启了。」（launchd KeepAlive 拉起了新进程，看到的 PID 是崩溃后的。）
3. 「继续干，但是不要碰 production 的东西。」
4. 「继续之前先把环境和背景研究清楚，存档到 prompt-archives，并且用一个 todo 文档追踪进展（用 `[ ]`）。」
5. 「Skip 掉那个卡住的命令。」
6. 「继续从代码侧排查问题，最后给我汇报，然后我来决定怎么改。」

## 关键约束（来自 AGENTS.md + 用户）

- **严禁触碰本机生产环境的 tmex**：常驻 launchd 服务 `com.tmex.tmex`（监听 9883）、安装目录
  `~/Library/Application Support/tmex/`（`resources/`、`runtime/`、`data/tmex.db`、`app.env`）。
  禁止写入/覆盖/删除、禁止 kill/重启进程。**只允许只读诊断**（读日志、对纯文本 bundle 做 grep）。
- 本次只做「代码侧根因排查 + 汇报」，**不自行改代码**，改法由用户拍板。
- 项目用 Bun.js（非 Node），交流用简体中文。

## 排查过程中的环境坑

- 早期对生产 `data/tmex.db`（WAL，正被生产进程以坏的 SQLITE_FULL 状态持有）跑了
  `sqlite3 ... mode=ro`，CLI 阻塞在 shm 锁上，把 Bash 工具的**持久 shell 占死**，后续 Bash 调用全部排队无返回。
  按用户指示 skip 该命令；改用独立工具（Read/Write/Edit/Agent，各自独立执行环境）继续，shell 随后自行恢复。
- 教训：**不要对生产正在写的 WAL 库直接用 sqlite3 CLI**（即便 ro 也会尝试建 -shm 而阻塞）。

## 结论指针

- 根因与完整时间线见 `background.md`。
- 进度与待办见 `todo.md`。
