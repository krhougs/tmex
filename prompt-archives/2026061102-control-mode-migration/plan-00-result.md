# Plan 00 执行结果：gateway 订阅层迁移到 tmux control mode

执行日期：2026-06-11。计划见 `plan-00.md`，全部完成，另有一项计划外的重要发现与对策（见下）。

## 改动总览

新增：

- `apps/gateway/src/tmux-client/control-mode-parser.ts`：字节级 control mode 协议解析器
  （%begin/%end/%error 块、%output/%extended-output 八进制反转义、通知分发、%exit、
  超长行/非法转义容错），22 个单测覆盖跨 chunk 任意切分、逐字节投喂、UTF-8 原样字节、
  块内通知交错等边界（fixture 来自 tmux 3.4 实测抓包）。
- `apps/gateway/src/tmux-client/control-mode-subscription.ts`：订阅管理器，包掉协议解析 +
  每 pane 懒建 `PaneStreamParser`（OSC 9/99/777/1337、DCS passthrough、bell、标题逻辑
  完全复用），结构通知 leading+trailing 防抖（150ms）触发快照刷新，`prunePanes` 随快照清理。
- `apps/gateway/src/tmux-client/tmux-version.ts`：`tmux -V` 解析与 >= 3.0 版本闸门
  （无法解析的 master/next 构建放行）。

改造（订阅层替换，命令/快照/输入/历史层不变）：

- `local-external-connection.ts`：pipe-pane/fifo/cat 与 set-hook/fifo/tail 全部删除；
  `Bun.spawn(['tmux','-C','attach-session','-t',session])` 常驻 control client（stdin 持有
  引用防 GC 关闭、stderr 收尾部 2KB 供报错）；意外退出退避重连（3 次、500ms*n、稳定 10s
  重置计数），重连前 `has-session` 探测，会话没了走既有 shutdown/onClose 路径，重连成功
  后补快照 + 重发活动 pane 历史；connect 阶段瞬退显式抛错。
- `ssh-external-connection.ts`：同构改造，control client 跑在独立 ssh exec channel 上
  （`openReaderChannel` 增加 `onStderr` 选项）；远端版本由 ssh-bootstrap 的 `tmux -V`
  检查；远端 fifo 目录/清理逻辑全部删除。
- 两者 `configureSessionOptions`：`focus-events on` → **off**；新增
  `destroy-unattached off`（session 级，防止 control client detach 触发会话销毁）。
- 删除 `fs-paths.ts`（不再有任何运行时 fifo 目录）。

## 计划外发现：attach 时焦点投递不受 focus-events 约束 → parking window 舞步

plan-00 预设 `focus-events off` 即可挡住焦点事件。实现期间集成测试抓到反例，随后实验
（exp8）与源码核实确认：

- `server_client_set_session`（attach 路径）对 `window_update_focus` 的调用**无条件**
  （3.4 与 master 均如此），`focus-events off` 时 attach 仍会向当前窗口活动 pane（若开了
  ?1004h）发送 `ESC[I`，且 control client 退出后不会补发 `ESC[O`，pane 永久卡在
  focused——正是会打死 Claude Code 通知的形态；
- `-f '!focused'` 之类 client flag 不存在（实测 3.4 拒不识别，attach 仍 focused）；
- `select-window` 路径：3.4 无焦点调用，3.5+ 有但被 focus-events 选项闸门住。

对策（已实现并实验验证）：每次 control attach 前执行 parking 舞步——
`new-window -n tmex-park 'sleep 30'`（curw 切到无 ?1004h 的一次性 pane）→ attach →
等 greeting 块（≤3s）→ `last-window` 切回 → `kill-window`。实测 ?1004h pane 全程
零焦点字节；`sleep 30` 保证 gateway 中途崩溃也不会留下垃圾窗口。

## 验证结果

- 单测：gateway 164 pass（含 control-mode-parser 22、subscription 11、本地/ssh 连接重写
  用例）；shared 36、ghostty-terminal 26、tmex-cli 13 全过。
- 真 tmux 集成测试（`local-external-connection.integration.test.ts`，5 pass）：
  1. 输出流/历史/bell 走 control mode 正常；
  2. **OSC 9 原始 + tmux passthrough 包装通知端到端解析**（覆盖 Claude Code 形态）；
  3. **双 gateway 同会话互不抢占**（A/B 同时收输出、A 断开 B 不受影响——根治验收）；
  4. **?1004h pane 全程收不到 ESC[I/ESC[O**（"Claude Code 离开 60 秒后通知能弹"回归守护：
     焦点保持 undefined → 60 秒输入回退继续生效）;
  5. 并发重复 selectPane 无错误。
- e2e（端口 9885/9665，`env -u NODE_ENV`）：最终全量 38 pass / 7 fail / 1 skip，**7 个失败
  全部在基线（main）上复现**，与迁移无关：
  - `terminal-mouse-recovery` ×3、`ssh-terminal-restore` ×2：本机 opencode 起不来（既有环境问题）；
  - `sidebar-delete`：基线同样失败（环境问题）；
  - `terminal-selection-canvas` autoscroll：既知 flaky（阈值问题）；
  - `terminal-selection-canvas:220`：压测对比为存量 flaky（迁移后 5/15 挂、**基线 6/15 挂**），
    失败形态为初始渲染后拖拽选区未生效，与订阅层无关。
- lint：与基线 diff 为零（存量 format 告警未新增）；tsc 非测试错误与基线一致（均为存量）。

## 行为变化与注意事项

1. `focus-events` 全局（server 级）从强制 on 改为强制 off：用户在真实终端 attach 同一
   tmux server 时 vim 等收不到焦点事件。旧版同样全局强制（方向相反），control mode 下
   on 必然打死通知，off 是唯一安全值。
2. tmux 最低版本要求 3.0（local + ssh connect 时检测，给出明确设备错误）。
3. 每设备一个常驻 `tmux -C` 子进程（local）/ ssh channel（ssh）；不开 pause-after，
   gateway 停读超过 tmux `CONTROL_MAXIMUM_AGE`（5 分钟）会被服务端断开，由重连策略恢复。
4. remain-on-exit 场景下 pane 死亡无 control 通知（旧 hook pane-died 能感知），由前端
   查看时的 1s 快照轮询兜底。
5. **过渡期注意**：旧版常驻服务（≤0.5.1）会在每次设备连接时把 `focus-events` 改回 on。
   新旧 gateway 共存时（旧版 pipe-pane 不与 control mode 抢占，输出互不影响），若旧版把
   focus-events 翻回 on，新版的 parking 舞步仍挡住 attach 路径，但 3.5+ 的 select-window
   路径会重新暴露。**升级后尽快更新常驻服务。**
6. parking 窗口（`tmex-park`）在 attach 期间短暂存在（约 100-200ms），快照恰好落在
   中间时前端可能闪现一个窗口，属预期。

## 已知问题文档

`docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md` 已标注
"已根治"并补充上述要点。
