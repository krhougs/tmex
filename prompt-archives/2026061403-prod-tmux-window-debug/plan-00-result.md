# 生产 tmux window 报错调查结果

## 结论

远端生产报错不是 tmux 3.4、Ubuntu 24.04 或 systemd 的兼容性问题，而是 tmex 服务端下发的本地 tmux 快照已经包含错误的 window ID。

生产快照里出现的 `@0_0_bash_1`、`@56_0_bash_1` 不是合法 tmux window ID。它们是窗口快照字段 `#{window_id}`、`#{window_index}`、`#{window_name}`、`#{window_active}` 被拼成一个字符串后的形态。前端拿到该错误 ID 后调用 `selectWindow(deviceId, windowId)`，后端执行 `tmux select-window -t @0_0_bash_1`，tmux 找不到该 target，于是在 systemd journal 中记录 `can't find window`。

## 关键证据

- systemd user unit：`/root/.config/systemd/user/tmex.service`，`ExecStart=/usr/bin/env bash "/root/.local/share/tmex/run.sh"`，stdout/stderr 进入 journal。
- 生产 bundle 堆栈：`/root/.local/share/tmex/runtime/server.js:97459` 在 `runTmux()` 抛错，调用方是 `server.js:97220` 的 `runAndRefresh()`。
- 当前 tmux 真实窗口为 `@0`、`@55`、`@56`，对应 session 为 `$0 tmex`、`$1 tmex1`；手工执行 `tmux select-window -t @0_0_bash_1` 返回 `can't find window`。
- 通过 `ws://10.110.88.5:9883/ws` 只发 `HELLO` 和 `DEVICE_CONNECT` 抓取快照，服务端下发内容已经是：
  - local：`session.id="$0_tmex"`，windows 为 `@0_0_bash_1`、`@55_1_bash_0`，panes 为空。
  - l1：`session.id="$1_tmex1"`，windows 为 `@56_0_bash_1`，panes 为空。
- 本地源码路径对应：`apps/gateway/src/tmux-client/local-external-connection.ts` 的 `requestSnapshotInternal()` 使用 tab 分隔并用 `line.split('\t')` 解析；`apps/gateway/src/ws/index.ts` 的 `handleTmuxSelectWindow()` 当前直接转发 windowId，没有 target ID 防御。
- SSH connection 已改为 `|` 分隔和 `splitSnapshotFields()`，local connection 仍是旧的 tab 解析路径。

## 版本信息

- OS：Ubuntu 24.04.1 LTS，kernel `6.8.8-2-pve`。
- systemd：`255 (255.4-1ubuntu8.4)`。
- tmux：`tmux 3.4`，apt package `3.4-1ubuntu0.1`。
- Bun：`1.3.14`。
- tmex：`install-meta.json` 中 `cliVersion=0.8.2`，安装目录 `/root/.local/share/tmex`。

## 文档核对

- tmux 官方/手册说明 window ID 形如 `@1`，pane ID 形如 `%1`，session ID 形如 `$1`，并且这些 ID 在对应对象生命周期内稳定。
- `select-window [-lnpT] [-t target-window]` 选择的是 `target-window`，而 `target-window` 的有效 window 形式包括 window index 或 `@数字` 这类 window ID。
- systemd journald 文档说明服务 stdout/stderr 可通过 `StandardOutput=journal`、`StandardError=journal` 进入 journal，因此 journal 中的 Bun stack 行号应视为应用抛错位置，不是 systemd 自身错误。

参考：

- https://man7.org/linux/man-pages/man1/tmux.1.html
- https://github.com/tmux/tmux/wiki/Advanced-Use
- https://systemd.io/JOURNAL_NATIVE_PROTOCOL/

## 修复方案

1. 将 local connection 的 snapshot 格式与 SSH connection 对齐：统一使用 `SNAPSHOT_FIELD_SEPARATOR='|'` 和 `splitSnapshotFields()` 解析 session/window/pane 三类输出，避免继续依赖 tab 分隔。
2. 抽出共享 snapshot format/parse helper，避免 local 与 SSH 两套实现再次分叉。
3. 在 local/SSH parser 中增加 target ID 校验：
   - window ID 必须匹配 `^@\d+$`。
   - pane ID 必须匹配 `^%\d+$`。
   - session ID 必须匹配 `^\$\d+$`。
   - 校验失败时丢弃该 snapshot 或返回 `session:null` 并记录结构化日志，禁止把拼接串作为 ID 下发给前端。
4. 在 WS 入站处理加防御：`handleTmuxSelectWindow()`、`handleTmuxSelect()` 收到非法 windowId/paneId 或当前 snapshot 中不存在的 ID 时，不执行 tmux 写命令，只返回错误并触发快照刷新。
5. 给 `runTmux()` 错误日志补充失败 argv、deviceId、sessionName，方便下次直接定位失败命令。

## 验证方案

- 单测覆盖 local parser：
  - `@0|0|bash|1` 正常解析为 window id `@0`。
  - window name/pane title 含分隔符时仍能保留字段。
  - `@0_0_bash_1` 不应被接受为 window id。
- WS 层测试覆盖非法 `selectWindow`：非法 windowId 不应触发 `tmux select-window`。
- 临时实例或发版后验证：重新连接 `ws://10.110.88.5:9883/ws`，快照中 window id 应为 `@0/@55/@56`，pane id 应为 `%0/%55/%56`，journal 不再出现 `can't find window: @*_bash_*`。

## 风险与注意事项

- 不要直接修改 `/root/.local/share/tmex/` 或重启生产服务；生产更新应通过正式发版和 `tmex upgrade` 由用户执行。
- 如果只修 parser 不加 WS 入站防御，浏览器旧快照或恶意请求仍可能触发同类 tmux 错误。
- 如果只把 tab 改成其他分隔符但不抽共享 helper，local/SSH 后续仍容易行为漂移。
