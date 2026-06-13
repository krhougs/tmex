# TODO：生产 tmex SQLITE_FULL 崩溃排查

## 调查（已完成）

- [x] 读崩溃日志，定位刷屏行与真正根因（`flushOutputBuffer error: SQLITE_FULL`）
- [x] 否证「磁盘满」（数据卷 783GB 空闲）
- [x] 全仓 + 全 git 历史检索崩溃字符串 → 确认 `flushOutputBuffer` 从未进过本仓库
- [x] 只读 grep 生产 bundle `runtime/server.js` → 确认当前生产已无该架构
- [x] 读当前 DB 初始化（仅 `foreign_keys=ON`，无 `max_page_count`）
- [x] 读 `session-state.ts` 内存环形缓冲实现（maxBufferSize 1000，满则 shift）
- [x] 读 `switch-barrier.ts` 超时路径，定位 BUFFERING 可能卡死的边界
- [x] 用文件 mtime 还原时间线，确认 err.log 自 06:22 冻结、06:27 重建 bundle、崩溃循环已止
- [x] 环境/背景归档到 `prompt-archives/2026061403-prod-sqlite-full-crash/`
- [x] 向用户汇报调查结论

## 决策与实现（已完成）

- [x] **隐患 1**（修）：history 超时分支无条件兜底 `stopOutputBuffering` + 确定性单测 → commit 1
- [x] **隐患 2**（不管）：用户决定跳过
- [x] **隐患 3**（修）：`applyPragmas`（WAL/busy_timeout/synchronous/foreign_keys）+ 单测 → commit 2
- [x] **tmux 跨平台存活**：systemd `KillMode=process` + launchd `AbandonProcessGroup` + 测试 + 文档 → commit 3
- [x] linger：决策「不代为启用」，仅写文档提示 `loginctl enable-linger`
- [x] 全套件验证：gateway 510 pass / app 14 pass（NODE_ENV=test）
- [x] 存档 result（`plan-00-result.md`）→ commit 4

## 待用户处理（生产侧，我不执行）

- [ ] 跑 `tmex upgrade`/重装让新服务策略落地（携带本修复的那次升级自身仍会掉一次 tmux）
- [ ] 按需 `loginctl enable-linger <user>`（跨 logout/reboot 存活）
- [ ] （可选）轮转/清理 12MB 的 `tmex.err.log`
- [ ] 合并分支 `worktree-prod-crash-hardening`（PR 或并入 main）

## 注意

- 全程只读诊断生产，未改任何生产文件、未 kill/重启进程。
