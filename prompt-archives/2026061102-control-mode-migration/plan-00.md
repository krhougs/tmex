# Plan 00：gateway 订阅层迁移到 tmux control mode

## 背景

详见 `docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md`：
gateway 目前用 `pipe-pane -O` + fifo + `cat` 订阅 pane 输出，用 `set-hook` + fifo + `tail -f`
监听结构变化。两者都是"后到者顶掉前者"，导致多个 gateway 实例（常驻服务 + dev）接同一
tmux 会话时互相抢占、双方断流。根治方案：迁移到 `tmux -C attach` control mode，
`%output` 通知原生支持多客户端订阅。

本计划只替换**订阅层**；命令层（一次性 `tmux ...` exec / ssh 常驻命令通道）、快照层
（`list-windows`/`list-panes` 轮询解析）、输入层（`send-keys -H`）、历史层（`capture-pane`）
全部保持不变，对上层 ws 协议无影响。

## 关键事实（源码 + 本机 tmux 3.4 实验确认，2026-06-11）

### focus 回归点（最重要）

- tmux 源码（master 与 3.4 一致）：`server_client_create` 给**每个**新 client（包括
  control client）默认置 `CLIENT_FOCUSED`；`window_pane_update_focus`（window.c）判定
  不排除 control client，闸门是 `c->session->attached != 0` 与调用点的
  `focus-events` 选项检查（如 `window_set_active_pane`）。
- 实验实锤（隔离 socket，`stty raw -echo` + `?1004h` + `cat -u` 捕获 pane stdin）：
  - control client attach 使 `session_attached` 0→1，client flags 为
    `attached,focused,control-mode`；
  - `focus-events on` 时：attach / select-pane 切换会向开启 ?1004 的 pane 投递
    `ESC[I` / `ESC[O`（实测收到字节）；
  - `focus-events off` 时：完全不投递。
- 结论：**必须把 configureSessionOptions 中 `focus-events on` 改为 `off`**（两个
  connection 都要改），否则 Claude Code 的 user_present 判定被焦点事件永久置位，
  通知永久静默。`on` 是 ee91b6f 引入的，在 pipe-pane 架构下本来就不起作用（会话
  永不 attached），改 off 无隐藏依赖。focus-events 是 server 级选项（-g），文档中
  注明此副作用。

### control mode 协议（3.4 实测 + control.c）

- 行协议，`\n` 结尾。greeting 为空 `%begin/%end` 对 + `%session-changed`。
- `%output %<pane-id> <data>`：data 中字节 <0x20 与 `\`(0x5c) 转义为 `\` + 3 位八进制
  （`\033`/`\015`/`\134`…）；**>=0x80 的字节（UTF-8）原样输出** → 解析必须字节级，
  不能先按 UTF-8 解码。
- `%extended-output %<pane-id> <age> ... : <data>`：仅 pause-after 模式出现；我们不开启
  （不传 `-f pause-after`，默认无 %pause），parser 仍需兼容解析（跳 token 到 ` : `）。
- 结构通知（实测可用）：`%window-add @N`、`%window-close @N`、`%unlinked-window-close @N`、
  `%layout-change @N <layout> <visible> <flags>`、`%window-renamed @N <name>`（name 含空格，
  取行剩余部分）、`%window-pane-changed @N %N`、`%session-window-changed`、
  `%session-renamed`、`%sessions-changed`、`%client-session-changed`、`%client-detached`。
- 会话被 kill：`%sessions-changed` + `%exit`，随后客户端进程退出；stdin EOF 也触发
  `%exit`。tmux server 被 kill：进程直接退出。
- 双 control client 各自收到完整独立流；attach 后新建的 pane 自动纳入订阅。
- control client 不影响窗口尺寸（不发 `refresh-client -C` 即可，实测 80x24 不变）。
- `%begin/%end/%error` 三元组字段 `<time> <number> <flags>` 完全一致可配对；我们不向
  control stdin 写任何命令，块只来自 attach greeting（及可能的 `%config-error`），
  parser 仍按通用规则处理，且块内允许通知交错。

### 其他迁移注意

- `destroy-unattached`：以前 tmex 会话从不 attached，该选项即使为 on 也不触发；迁移后
  control client detach（gateway 重启）会触发"最后一个 client 离开"→ 会话可能被销毁。
  须在 configureSessionOptions 增加 `set-option -t <session> destroy-unattached off`
  （session 级选项）。
- 版本下限：核心通知 3.0+ 可用，流控/flags 3.2+（我们不用）。实现 `tmux -V` / ssh
  bootstrap 版本解析，< 3.0 给出明确设备错误；无法解析（master/next 构建）放行。
  attach 命令不带 `-f` flags（3.2+ 才有，且无必要）。
- pipe-pane 与 %output 取的都是 pane 原始输出流（实测 OSC/DCS 序列原样流过），
  pane-stream-parser（OSC 9/99/777/1337、DCS tmux passthrough、BEL、标题）逻辑完全复用。
- bell：BEL 字节出现在 %output（`\007`），反转义后由 pane-stream-parser 捕获，路径不变。

## 设计

### 新文件 `apps/gateway/src/tmux-client/control-mode-parser.ts`

字节级解析器（仿 pane-stream-parser 的工厂风格）：

```ts
createControlModeParser(callbacks: {
  onOutput(paneId: string, data: Uint8Array): void;     // %output / %extended-output 反转义后
  onNotification(n: ControlModeNotification): void;      // 结构化通知（含 unknown 兜底）
  onBlockEnd?(block: ControlModeBlock): void;            // %begin..%end/%error
  onExit(reason: string | null): void;
}): { push(chunk: Uint8Array): void; flushEnd(): void }
```

- 内部维护字节缓冲，按 0x0a 切行（带上限保护，超长行丢弃并告警）；
- 行首 token ASCII 解析，payload 保持字节；八进制反转义 `\ddd`（严格 3 位），
  非法转义序列宽容处理（原样输出 + 一次性 warn）；
- 块状态机：`%begin` 开块记录三元组，匹配的 `%end`/`%error` 收块；块内已知 `%` 通知
  正常分发，其余行进块体；
- 未知 `%xxx` 通知 → `{ type: 'unknown', raw }`，不报错（向前兼容新版本 tmux）。

### 新文件 `apps/gateway/src/tmux-client/control-mode-subscription.ts`

两个 connection 共用的订阅管理器，包掉 parser + 每 pane 的 PaneStreamParser：

```ts
createControlModeSubscription(callbacks: {
  onTerminalOutput(paneId, data: Uint8Array): void;
  onTitle(paneId, title): void;
  onBell(paneId): void;
  onNotification(paneId, n: PaneStreamNotification): void;
  onStructureChanged(): void;   // 已防抖（150ms trailing）
  onExit(reason: string | null): void;
}): { push(chunk): void; handleStreamEnd(): void; prunePanes(valid: Set<string>): void }
```

- `%output` → 懒建对应 pane 的 `createPaneStreamParser` → 输出/标题/bell/通知回调；
- 结构通知（window-add/close/unlinked-close/layout-change/window-renamed/
  window-pane-changed/session-window-changed/session-renamed）→ 防抖后
  `onStructureChanged`（连接侧映射到 requestSnapshot）；
- `prunePanes` 在快照后清掉已消失 pane 的 parser。

### `local-external-connection.ts` 改造

- 删除：hook fifo 全套（startHooks/stopHooks/installHook/handleHookChunk/hookReadAbort/
  hookBuffer）、pane fifo 全套（paneReaders/startPipeForPaneNow/stopPipeForPaneNow/
  syncPipeReaders/stopAllPipeReaders/queuePipeTransition）、ensureRuntimeDirs/fsPaths
  （本地不再需要 /tmp/tmex 运行时目录）。
- 新增：`startControlClient()` —— `Bun.spawn(['tmux','-C','attach-session','-t',session],
  {stdin:'pipe'})`，stdout 喂 subscription，stderr 收集错误信息；deps 增加可注入的
  `spawnControlClient`（单测注入 fake）；`enableHooks` dep 改名 `enableSubscription`
  （语义：是否启动 control client）。
- 生命周期：connect = ensureSession → configureSessionOptions（focus-events off、
  destroy-unattached off）→ 版本检查 → startControlClient → connected → snapshot。
  disconnect/shutdown = kill control 进程。
- 意外退出重连：connected && !manualDisconnect 时，control 进程退出 → 退避重试
  （最多 3 次，500ms*n；存活超 10s 重置计数）；重试前 `has-session` 探测，server/会话
  已消失 → 走现有 shutdownInternal(true) 路径；重连成功 → requestSnapshot + 对
  activePaneId 重新 capturePaneHistory（补输出空洞）。
- snapshot 流程去掉 syncPipeReaders，改为 subscription.prunePanes。

### `ssh-external-connection.ts` 改造

- 同样删除远端 fifo/hook 全套与 ensureRemoteRuntimeDirs/rm -rf 清理；
- `startControlClient()` 用现有 `openReaderChannel` 模式开独立 channel：
  `exec <tmuxBin> -C attach-session -t <session>`，onData → subscription.push，
  onClose → 与 local 相同的重连策略（ssh client 仍在时重开 channel）；
- ssh-bootstrap 已带回 `tmux -V` 字符串，新增版本解析与 < 3.0 的明确报错。

### 测试

1. `control-mode-parser.test.ts`（新）：转义/反转义（含 `\134`、`\007`、UTF-8 原样字节、
   连续转义）、跨 chunk 任意切分（含转义序列中间、行中间切）、%extended-output、
   %begin/%end 配对与块内通知交错、%exit（带/不带 reason）、未知通知、空行、超长行、
   非法转义宽容。fixture 直接取实验抓到的真实字节样本。
2. `control-mode-subscription.test.ts`（新）：%output → pane parser 分发、OSC 通知穿透、
   bell、结构通知防抖、prunePanes。
3. 更新 `local-external-connection.test.ts` / `ssh-external-connection.test.ts`：
   配置命令断言（focus-events off、destroy-unattached off）、删 hook/pipe 相关用例、
   注入 fake control client 验证订阅数据流与意外退出重连。
4. `local-external-connection.integration.test.ts`（真实 tmux）：现有两用例应继续通过；
   新增 focus 回归用例——pane 内 `stty raw -echo` + `?1004h` + `cat -u` 记录 stdin，
   connect + selectPane 后断言**没有** `ESC[I`（保住 Claude Code 60 秒回退）。
5. e2e 全量（端口 9885/9665，`env -u NODE_ENV`），重点：通知 toast 相关 spec、
   ws-borsh 切换/resize/history、terminal-focus。

## 任务清单

1. 实现 control-mode-parser + 单测；
2. 实现 control-mode-subscription + 单测；
3. local connection 迁移 + 单测更新 + 集成测试（含 focus 回归用例）；
4. ssh connection 迁移 + 单测更新 + 版本检查；
5. 全量单测 + e2e + 手工双 gateway 验证；
6. 更新已知问题文档（标注根治 + focus-events off 副作用说明）+ plan-00-result.md。

## 验收标准

- 双 gateway（常驻 + dev）接同一会话，两边页面输入/输出均正常，互不抢占；
- OSC 9/99/777（含 tmux passthrough 包装）通知 toast 正常；
- ?1004h pane 在 gateway 全生命周期（attach/切 pane/断开重连）收不到 ESC[I/ESC[O；
- 现有全部单测、e2e 通过；
- kill-session / kill-server / gateway 重启后行为与现状一致（设备报错或自动恢复）。

## 风险

- focus-events 改为 off 是 server 级全局选项：用户在真实终端 attach 同一 tmux server
  的其它会话时 vim 等失去焦点事件。但现状是 tmex 强制 on（同样全局），且 control mode
  下 on 必然打死通知，权衡后 off 是唯一安全值，文档注明。
- 用户开启 destroy-unattached 的场景靠新增的 session 级 off 兜底。
- 远端低版本 tmux（< 3.0）从"可能勉强工作"变为明确报错，属于已接受的行为变化。
- control client 进程是新的常驻子进程（每设备一个），异常退出靠重连策略兜底；
  不开 pause-after，tmux 端缓冲在 gateway 停读超 5 分钟（CONTROL_MAXIMUM_AGE）时
  会主动断开 control client（"too far behind"），由重连策略恢复。
