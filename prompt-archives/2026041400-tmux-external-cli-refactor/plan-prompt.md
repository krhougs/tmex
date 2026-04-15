# Prompt Archive — tmux 外部 CLI 调用重构

## 背景

当前分支 `tmux-redesign` 中，gateway 通过 tmux 的 **control mode**（`tmux -CC` 以及相关 escape-code 转义协议）来与终端会话交互。control mode 带来了一系列状态同步、escape 转译、控制流交错等问题，维护成本持续升高。

## 用户原始 Prompt（2026-04-14）

> 我们基于当前分支重构一下整个tmux的调用和状态机，不再使用control mode，而是直接使用外部调用tmux的最佳实践来避免control mode带来的转译、状态同步、控制流问题。
> 请先仔细research相关内容，重构目标保证当前webui所有功能正常运行。

## 核心诉求

1. 基于当前 `tmux-redesign` 分支，重构整个 tmux 调用层与状态机；
2. 放弃 `tmux -CC` control mode；
3. 改为使用「外部调用 tmux」的最佳实践（通过 `tmux` CLI 子命令 + 独立的 PTY 附加通道来实现 IO 与状态查询分离）；
4. 保证当前 WebUI 所有功能正常运行（窗口/面板/会话管理、历史、resize、bell、SSH agent、书签、切换 barrier 等等）。

## 注意事项

- 完全基于当前 `tmux-redesign` 分支做重构，不回退到老的 control-mode 实现；
- 先存档再干活；
- 计划文件位于 `/Users/krhougs/.claude/plans/crystalline-painting-puppy.md`，最终正式 plan 在此目录下以 `plan-00.md` 存档；
- 执行结果总结在 `plan-00-result.md`。

## 相关目录速查

- `apps/gateway/src/tmux/` — 现有 tmux/SSH/本地 shell 适配层（含 control-mode 相关 parser、connection）
- `apps/gateway/src/control/` — 现有 control mode runtime
- `apps/gateway/src/ws/` & `ws/borsh/` — WebSocket 层
- `apps/fe/src/` — 前端，使用 xterm.js 呈现
- `packages/shared/src/ws-borsh/` — 前后端共享的 borsh 协议

## 补充 Prompt（2026-04-14，范围缩小）

> btw现在我不要求外部tmux session切换pane/窗口会同步过来，我现在只要求webui打开终端使用终端的流程完全正常

**影响：**

- 不需要监听 out-of-band（非 webui 发起的）tmux 操作；外部 tmux client 的切换/新建/关闭 pane、window 不要求同步回 webui
- hook 集合可大幅裁剪：仅保留实时性敏感的 `alert-bell` 和 pane 生命周期（`pane-died` / `pane-exited`）
- 其他状态变更由 gateway 在执行自身命令（新建/关闭/切换/split/resize）成功后主动 `SnapshotStore.refresh()` 广播
- 5s 轮询兜底可降级或移除（保留 pane-died hook 已能覆盖"shell 退出"场景）

## 审阅反馈（2026-04-14，prompt 存档）

用户对 plan-00.md 的 6 条技术核查（阻断 1-2、高风险 3-4、中风险 5-6）+ 4 条遗漏：

1. **阻断**：plan 把运行时建在自定义 socket + 硬编码 `tmex` session，破坏现有 `device.session` + 默认 tmux server 契约（`packages/shared/src/index.ts:25`、`apps/gateway/src/tmux/connection.ts:176/375`、`apps/fe/tests/helpers/tmux.ts:15`）
2. **阻断**：需求收缩"不同步外部 tmux 操作"与 Phase P2 保留 `ws-borsh-follow-active.spec.ts` 冲突（该 spec `apps/fe/tests/ws-borsh-follow-active.spec.ts:30` 由 `tmux select-pane` 驱动，FE 消费 `apps/fe/src/pages/DevicePage.tsx:497` 的 `pane-active` 事件）
3. **高风险**：输入链路现有行为未保留——`isComposing` 中间态丢弃（`apps/gateway/src/ws/index.ts:286`）、paste 1024 字符切块（`apps/gateway/src/ws/index.ts:547`）、`send-keys -H` 256 字节切块（`apps/gateway/src/tmux/connection.ts:611`）；plan 写的 3500 字节是臆造值
4. **高风险**：命令通道 shell 转义策略缺失，session 名/window 名/FIFO 路径/远端路径/`-c 'cat >FIFO'` 内层命令都会被带空格/引号/分号的输入打穿
5. **中风险**：`apps/gateway/src/push/supervisor.ts:274/308` 依赖 `lastSnapshot` 补 bell context；plan 取消周期轮询后未说明 `lastSnapshot` 如何持续新鲜
6. **中风险**：验收口径漂移——"TMUX_EVENT 1..10" 中 10 是 output（`packages/shared/src/ws-borsh/convert.ts:38`）、`TERM_DESELECT` 协议里不存在（`packages/shared/src/ws-borsh/kind.ts:18`）、手动 QA "rename window（webui 发起）" 在 FE store 无此能力（`apps/fe/src/stores/tmux.ts:42`）

**遗漏**：
1. 是否继续接入默认 tmux server + `device.session` 需明写
2. "外部 pane/window 切换同步"到底删能力还是删验收需明写
3. `isComposing` / paste 分块 / shell escaping / hook 安装作用域 / supervisor snapshot 刷新 要补进实现要点与测试
4. plan-prompt 提到"书签"但仓库无相关实现，需从验收里拿掉或指到具体代码

## 第二轮审阅（2026-04-14，4 项新发现）

1. **阻断 — 缺少 device/session 共享单例 runtime 设计**：`apps/gateway/src/ws/index.ts:586` 和 `apps/gateway/src/push/supervisor.ts:37` 当前各自 `new TmuxConnection(...)`（`runtime.ts:46` 印证 supervisor 常驻在线）。新架构 `OutputMultiplexer` / `HookInstaller` / `BellCoordinator` / `SnapshotStore` 如仍各起一份，`pipe-pane`（同 pane 同时只能绑一个命令，`tmux(1) man:1442`）+ `set-hook`（同名覆盖，`tmux(1) man:2520`）会直接互相踩。必须引入 `TmuxRuntimeRegistry` / `DeviceSessionRuntime`，ws 与 push 共享同一后端 runtime。
2. **高风险 — SSH 命令通道方案不成立**：plan 中 `ssh2.Client.shell({ term:'dumb' })` 与 ssh2 文档定性（interactive shell session）和现状 `conn.exec(...)` 路径（`apps/gateway/src/tmux/connection.ts:375`）不符。缺少"消除 PS1/MOTD/profile 噪声、sentinel 不被污染、远端 PATH bootstrap"的完整方案（目前只处理了本地 PATH，`apps/gateway/src/tmux/local-shell-path.ts:199`）。
3. **中风险 — "多 WS client 不同 pane"QA 与 FE 行为冲突**：`apps/fe/src/stores/tmux.ts:304` 任意 `pane-active` 都会写全局状态，`DevicePage.tsx:497` 会跟随跳转。在"apps/fe/ 完全不改"前提下不成立。二选一：删 QA，或后端只把 command-driven `pane-active` 回给发起端。
4. **中风险 — hook/FIFO 生命周期无闭环**：只写了安装与读取、重连后重建，没写 teardown/unset。复用默认 tmux server 后，gateway 重启/断线重连/device disconnect 都会残留旧 hook 指向失效 FIFO；`run-shell` 写入会悬挂或失败。需要补齐：reader 先于 hook 安装、teardown 时 `set-hook -u -t <session>`、启动时 stale FIFO 清理 / 路径带 gateway pid。

## 补充决定（2026-04-14）

> 遗漏2应该 放弃外部同步

**处置**：遗漏 2 走**放弃能力**路径，而非仅移出回归。

- 直接**删除** `apps/fe/tests/ws-borsh-follow-active.spec.ts`（不是 skip）
- FE `apps/fe/src/pages/DevicePage.tsx:497` 的 `activePaneFromEvent` 跟随副作用保持不动（已被 `recentSelectRequestsRef` 自回声过滤；新架构下 `CommandDrivenEvents` 产生的 `pane-active` 均由 webui 自身操作触发，不会造成"跟随回声"漂移）——与"apps/fe/ 完全不改"契约一致
- P5 不再保留"恢复能力"预案
- 风险表"能力漂失"改为"能力已放弃"

## 执行续接 Prompt（2026-04-14）

> 阅读 prompt-archives/2026041400-tmux-external-cli-refactor 干活

## 执行续接 Prompt（2026-04-14，继续实现）

> 按照项目规范，继续干活，直到计划完全实现完成

## 用户纠偏 Prompt（2026-04-14）

> 我让你干活，没要你加戏

## 线上复现 Prompt（2026-04-15）

> [switch-barrier] Transaction timeout at stage: history for 6de4ac46-f59e-49c2-81d4-5a2ae3af6472
> [push] tmux error on device 6de4ac46-f59e-49c2-81d4-5a2ae3af6472: 604 |           }
> 605 |         }
> 606 |       })();
> 607 |
> 608 |       this.pipeReadAbort = () => {
> 609 |         reader.releaseLock();
>                 ^
> AbortError: Stream reader cancelled via releaseLock()
>  code: "ERR_STREAM_RELEASE_LOCK"
>
>       at <anonymous> (/Users/krhougs/LocalCodes/tmex/apps/gateway/src/tmux-client/local-external-connection.ts:609:16)
>       at stopPipeNow (/Users/krhougs/LocalCodes/tmex/apps/gateway/src/tmux-client/local-external-connection.ts:631:10)
>       at <anonymous> (/Users/krhougs/LocalCodes/tmex/apps/gateway/src/tmux-client/local-external-connection.ts:567:18)
>
> [push] tmux error on device 6de4ac46-f59e-49c2-81d4-5a2ae3af6472: 664 |     updateDeviceRuntimeStatus(this.deviceId, {
> 665 |       lastSeenAt: new Date().toISOString(),
> 666 |       tmuxAvailable: false,
> 667 |       lastError: message,
> 668 |     });
> 669 |     throw new Error(message);
>                     ^
> error: can't find pane: %
>       at runTmux (/Users/krhougs/LocalCodes/tmex/apps/gateway/src/tmux-client/local-external-connection.ts:669:15)
>       at async <anonymous> (/Users/krhougs/LocalCodes/tmex/apps/gateway/src/tmux-client/local-external-connection.ts:614:18)
>
> 复现方式： http://127.0.0.1:19883/devices/6de4ac46-f59e-49c2-81d4-5a2ae3af6472
> 然后切换到local这个device的3号pane

## 线上复现更正 Prompt（2026-04-15）

> 不是第三个，是前面写的编号为3的pane（从0开始数）

## 执行续接 Prompt（2026-04-15）

> 继续

## 新回归 Prompt（2026-04-15）

> bug: web上点击切换pane之后终端会清空然后变回切换前的pane，要再点一次才能切过去
> 请仔细review当前的dataflow和状态机检查实现并修复
