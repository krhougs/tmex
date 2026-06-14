# 生产 tmux window 报错复核结论（plan-01，校正版）

> 本文是对 `plan-00-result.md`（另一 Agent 报告）的复核。**核心结论与其相反**：根因不是服务端生成坏快照，而是入站 `select-window` 收到了来自过期/外部客户端的复合目标串。下文每条结论均有线上一手证据。

## 一句话结论

`can't find window: @0_0_bash_1` 不是 tmux/OS/systemd 兼容问题，**也不是服务端生成的坏快照**。它是某个**过期/外部 WS 客户端**发来的 `TMUX_SELECT_WINDOW` 消息里携带了复合目标串 `@id_index_name_active`，服务端 `selectWindow()` 未传 `allowTargetMissing`，把本应静默的 target-missing 失败放大成连接级告警（`[conn-alert]` + `[push]` + 抛错刷屏）。

## 远端环境（一手）

- OS：Ubuntu 24.04.1 LTS（Noble）
- systemd：255（255.4-1ubuntu8.4）
- tmux：3.4
- Bun：1.3.14
- tmex：cliVersion 0.8.2，安装目录 `/root/.local/share/tmex`
- 服务形态：systemd **user** unit（`journalctl --user -u tmex`，非 system unit）

## 关键证据链

### 1. 报错来自入站 select-window，不是快照下发

部署 bundle `/root/.local/share/tmex/runtime/server.js`：

- `selectWindow(windowId)`（96847）→ `runAndRefresh(['select-window','-t',windowId])`，**未传 `allowTargetMissing`**（默认 false）。
- 对比同文件：`closeWindowInternal` 的 `kill-window`（97228）、`selectPaneInternal` 的 `select-window`（97243）、`kill-pane`（98xx）都传了 `true`。
- 入站链路：WS `KIND_TMUX_SELECT_WINDOW`(514) → `handleTmuxSelectWindow(deviceId, windowId)`（105602）→ `runtime.selectWindow(decoded.windowId)`（105606）。`windowId` 直接取自 WS 报文，**无任何校验**。

journal 堆栈与之完全吻合：

```
error: can't find window: @0_0_bash_1
  at runTmux (server.js:97459:11)        # throw new Error(message)
  at async runAndRefresh (server.js:97220:23)
[conn-alert] device 082c...(local) source=runtime type=unknown: can't find window: @0_0_bash_1
[push] tmux error on device 082c...
```

### 2. 服务端快照解析只产出 `@N`，不可能产出复合串（直接反驳 plan-00 核心论点）

部署 bundle `parseSnapshotWindows`（97330）：

```js
const [id, indexRaw, name24, activeRaw] = line.split("\t");
// list-windows -F "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}"
this.snapshotWindows.set(id, { id, index, name, active, panes: [] });
```

`id` 取的是制表符分隔的**第一字段** = `#{window_id}` = `@0`。下发给前端的 window id 必然是 `@0/@55/@56`，**永远不会是 `@0_0_bash_1`**。

> plan-00 声称"抓到服务端下发 snapshot 已是坏值 `@0_0_bash_1`"——与运行中代码相矛盾，属误判/误读（可能把自己的出站消息或解码产物当成了服务端快照）。

### 3. 复合串的形态指向"仓库外/过期客户端"

`@0_0_bash_1` = `#{window_id}_#{window_index}_#{window_name}_#{window_active}` 用 `_` 拼接。

- 同次 burst 里同一窗口出现 `@0_0_bash_1` 与 `@0_0_bash_0`、`@55_1_bash_0` 与 `@55_1_bash_1`——**末位 0/1 随当前活动窗口翻转**，说明末位是 tmux 的 **raw `#{window_active}` (0/1)**。
- 而 tmex wire 协议里 `active` 是 `b.bool()`（布尔），FE 各处用裸 `window.id`。**当前及历史 tmex 代码都不产生这个 `_` 拼接串**（与历史调查一致，见 memory `project_cant_find_window_composite_target`）。
- 直接消费 tmux `-F` 原始输出再用 `_` 拼 id 的，只能是**旧浏览器标签页或外部 WS 客户端**。dns 上 tmex 会话 5/14 创建、跑过数周旧版本，符合过期标签页特征。

### 4. tmux 侧行为（查证，非 bug）

tmux `@` 前缀目标只接受 `@<纯数字>`（`window.c` 的 `window_find_by_id_str` → `strtonum`）；`@0_0_bash_1` 含 `_`，解析失败 → `can't find window`。tmux 3.0–3.5、Linux/macOS 行为一致。手工 `tmux select-window -t @0_0_bash_1` 在 dns 上同样 `code=1`。**与 tmux/OS 版本无关。**

### 5. 现状：升级/重启后已停发

journal 显示 burst 集中在 21:18 / 21:20 / 22:13 / 22:58 / 23:17（pid 99042→100298→110295→122931，对应多次重启；23:17 与安装目录 mtime 一致 = 一次 `tmex upgrade`）。**23:17:51 之后再无该错误**，只有 `[ws] client connected/disconnected`。说明触发方是"特定客户端主动发 select-window"，升级后该过期标签页未再连入；若是服务端持续生成坏快照，重启不会让错误消失。

## 修复方案（承重墙 + 纵深防御）

> 仅给方案，不实施。生产更新走正式发版 + 用户执行 `tmex upgrade`。

1. **承重墙**：`selectWindow()` 改为 `runAndRefresh([...], true)`，与 `closeWindow` 对齐。
   - `apps/gateway/src/tmux-client/local-external-connection.ts:265`
   - `apps/gateway/src/tmux-client/ssh-external-connection.ts:243`
   - 效果：target-missing 时走 `recoverFromTargetMissingError`（清 active 指针 + 重新快照）静默恢复，不再 `notifyRuntimeError` / `[conn-alert]` / `[push]`。这同时覆盖了"合法但过期的 `@N` 竞态"（窗口刚被关、客户端还按旧快照点）。
2. **纵深防御**：`handleTmuxSelectWindow`（`apps/gateway/src/ws/index.ts:634`）校验 `windowId` 形如 `^@\d+$`，非法直接 reject + 触发快照刷新，不下发 tmux。`handleTmuxSelectPane` 同理校验 `^%\d+$`。
   - 注意：这是辅助。**flag 才是承重墙**，因为合法但过期的 `@N` 仍需 benign 处理，正则拦不住。
3. （可选）`runTmux` 抛错日志带上 `argv/deviceId/sessionName`，便于定位失败命令。

### 对 plan-00 方案的取舍

plan-00 提的"统一 local/SSH 用 `|` 分隔 + `splitSnapshotFields` + 抽共享 parser"是**合理的代码整洁项，但与本 bug 无因果关系**——local 的 `\t` parser 取第一字段同样得到 `@N`，分隔符差异不产生复合串。不应把它当成本次修复的根因项；可作为独立重构另议。

## 验证方案

- 单测：构造 `selectWindow('@0_0_bash_1')` 与 `selectWindow('@999')`（合法但不存在），断言**不触发** `connectionAlertNotifier.notify` / 不抛连接级错误，且触发一次快照刷新。
- WS 层：非法 `windowId`（含 `_`）不调用 `runtime.selectWindow` 真正下发。
- 发版后线上：journal 不再出现 `can't find window: @*_*_*_*`；正常 select-window 仍生效。

## 风险与注意

- 禁止改 `/root/.local/share/tmex/` 或重启生产；本次仅只读排查。
- 只改 parser/分隔符而不加 flag，过期标签页或竞态仍会刷告警。
- 关联 memory：`project_cant_find_window_composite_target`、`feedback_fail_fast_and_notify_once`、`project_service_config_propagation`。
