# 修复 LANG=C 导致 tmux snapshot window id 污染计划

> **For Claude / Codex:** 执行本计划前先使用项目要求的 `using-superpowers`、`brainstorming`、`systematic-debugging`、`test-driven-development`。如在独立会话执行，使用 `executing-plans` 按任务逐项推进。

**目标：** 修复生产 systemd `LANG=C` 环境下，本地 tmux snapshot 用 TAB 分隔被 tmux 渲染为 `_`，导致 `window.id` 变成 `@0_0_bash_1` 并回传 `select-window` 报错的问题。

**架构：** 根因修复放在 gateway 的本地 tmux snapshot 生成与解析路径：local 与 SSH 统一使用 `|` 作为 tmux format 字段分隔，并复用同一个结构化 parser。纵深防御放在 parser、WS 入站和 tmux target-missing 处理三层，保证坏 snapshot 不再进入前端，坏入站 target 也不会触发连接级告警。

**技术栈：** Bun 1.x、TypeScript、gateway Bun test、tmux 3.4+。

---

## 背景

此前 `plan-01-result-verified.md` 判断“服务端快照不可能生成 `@0_0_bash_1`，应是过期/外部客户端发起 `select-window`”。该判断已被新的一手证据推翻。

新的闭环证据：

- 生产 gateway 进程环境为 `LANG=C`。
- 本地路径当前使用 TAB 分隔：
  - `apps/gateway/src/tmux-client/local-external-connection.ts:821`
  - `apps/gateway/src/tmux-client/local-external-connection.ts:828`
  - `apps/gateway/src/tmux-client/local-external-connection.ts:836`
- tmux 3.4 在非 UTF-8 locale 下会把 format 字面 TAB 输出为 `_`，所以 `list-windows -F '#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}'` 实际 stdout 是 `@0_0_bash_1`。
- 当前 local parser 用 `line.split('\t')`：
  - `apps/gateway/src/tmux-client/local-external-connection.ts:875`
  - `apps/gateway/src/tmux-client/local-external-connection.ts:889`
  - `apps/gateway/src/tmux-client/local-external-connection.ts:916`
- 无 TAB 时整行被作为 `window.id`，pane 的 `windowId=@0` 无法挂到 `@0_0_bash_1` 下，坏 snapshot 继续下发给前端。
- 前端跳转相关 effect 不负责合成这个 id；它只是信任 snapshot 的 `window.id` 并回传，导致 `select-window -t @0_0_bash_1` 报错。
- SSH 路径已使用 `|` 与 `splitSnapshotFields`：
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:61`
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:69`
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:876`
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:883`
  - `apps/gateway/src/tmux-client/ssh-external-connection.ts:891`

生产注意事项：

- 严禁修改或重启本机生产 tmex 服务，严禁写入 `~/Library/Application Support/tmex/`。
- 远端生产也只允许只读验证；修复通过正式发版后由用户执行 `tmex upgrade`。
- 测试使用 `NODE_ENV=test`/仓库测试环境，不能继承生产 `app.env`。

## 修复原则

1. **承重墙是 snapshot 源头修复：** local 不再使用 TAB 分隔，改为与 SSH 一样的 `|`。
2. **parser 必须 fail closed：** 任何 session/window/pane id 不符合 tmux id 形态，不能进入 `snapshotSession`/`snapshotWindows`/pane 列表。
3. **入站命令必须防御：** WS 收到非法 id 或当前 snapshot 不存在的 id，不执行 tmux 写命令。
4. **target-missing 必须 benign：** `selectWindow()` 对合法但过期的 `@N` 走 `allowTargetMissing=true`，与 `closeWindow` 对齐。
5. **locale 加固是补充，不是唯一修复：** `buildLocalTmuxEnv` 需要覆盖 `LANG=C`，但分隔符和校验不能依赖 locale 正常。

## Task 1：抽共享 snapshot parser 与字段分隔符

**Files:**

- Create: `apps/gateway/src/tmux-client/snapshot-format.ts`
- Modify: `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- Modify: `apps/gateway/src/tmux-client/local-external-connection.ts`
- Test: `apps/gateway/src/tmux-client/snapshot-format.test.ts`

**Step 1：写共享工具测试**

新增测试覆盖：

- `SNAPSHOT_FIELD_SEPARATOR` 为 `|`。
- `splitSnapshotFields('@1|0|name|with|pipe|1', 4)` 返回 `['@1', '0', 'name|with|pipe', '1']`。
- `splitSnapshotFields('%1|@1|0|title|with|pipe|1|80|24|1|node', 9)` 保留 title 中的 `|`。

Run:

```bash
bun test apps/gateway/src/tmux-client/snapshot-format.test.ts
```

Expected: 先失败，提示模块不存在。

**Step 2：实现共享工具**

将 `ssh-external-connection.ts:61-111` 的 `SNAPSHOT_FIELD_SEPARATOR` 与 `splitSnapshotFields()` 移到新文件并导出。保持现有字段数量行为，避免扩大改动面。

**Step 3：替换 SSH import**

`ssh-external-connection.ts` 从 `./snapshot-format` import，不改变 SSH 行为。

Run:

```bash
bun test apps/gateway/src/tmux-client/snapshot-format.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts
```

Expected: PASS。

## Task 2：local snapshot 改用 `|` 并复用 parser

**Files:**

- Modify: `apps/gateway/src/tmux-client/local-external-connection.ts:815-916`
- Modify: `apps/gateway/src/tmux-client/local-external-connection.test.ts`

**Step 1：先改测试期望**

在 `connect runs exact command sequence with control-mode session options` 中，将期望命令改为：

```text
tmux display-message -p -t tmex-snapshot #{session_id}|#{session_name}
tmux list-windows -t tmex-snapshot -F #{window_id}|#{window_index}|#{window_name}|#{window_active}
tmux list-panes -s -t tmex-snapshot -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_title}|#{pane_active}|#{pane_width}|#{pane_height}|#{window_active}|#{pane_current_command}
```

同步修改 `createRunStub()` 对 session/windows/panes snapshot 的默认输出为 pipe-delimited。

Run:

```bash
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts
```

Expected: FAIL，因为实现仍输出/解析 TAB。

**Step 2：改 local 实现**

修改 `requestSnapshotInternal()` 中三个 tmux format 字符串，使用 `SNAPSHOT_FIELD_SEPARATOR` 拼接或直接改为 `|` 形式。

修改 parser：

- `parseSnapshotSession()` 使用 `splitSnapshotFields(line, 2)`。
- `parseSnapshotWindows()` 使用 `splitSnapshotFields(line, 4)`。
- `parseSnapshotPanes()` 使用 `splitSnapshotFields(line, 9)`。

Run:

```bash
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts
```

Expected: PASS。

## Task 3：parser fail closed，拒绝半坏 snapshot

**Files:**

- Modify: `apps/gateway/src/tmux-client/snapshot-format.ts`
- Modify: `apps/gateway/src/tmux-client/local-external-connection.ts`
- Modify: `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- Test: `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- Test: `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`

**Step 1：写 id 校验工具测试**

在 `snapshot-format.test.ts` 覆盖：

- `isTmuxSessionId('$1') === true`，`isTmuxSessionId('$abc') === false`。
- `isTmuxWindowId('@1') === true`，`isTmuxWindowId('@0_0_bash_1') === false`。
- `isTmuxPaneId('%1') === true`，`isTmuxPaneId('%1_bad') === false`。

Run:

```bash
bun test apps/gateway/src/tmux-client/snapshot-format.test.ts
```

Expected: FAIL。

**Step 2：实现 id 校验**

在 `snapshot-format.ts` 导出：

```ts
export const TMUX_SESSION_ID_PATTERN = /^\$\d+$/;
export const TMUX_WINDOW_ID_PATTERN = /^@\d+$/;
export const TMUX_PANE_ID_PATTERN = /^%\d+$/;
```

并导出对应 predicate。

**Step 3：给 local/SSH parser 加校验**

建议规则：

- session 行：`id` 不合法则 `snapshotSession=null`，跳过。
- window 行：`id` 不合法、`indexRaw` 非数字、`activeRaw` 非 `0/1`，跳过该 window 并 `console.warn` 一行结构化信息。
- pane 行：`paneId` 或 `windowId` 不合法、`indexRaw/widthRaw/heightRaw` 非数字、active 字段非 `0/1`，跳过该 pane 并 `console.warn`。
- 如果本次 snapshot 有 session 但没有任何合法 window，发 `session:null` 或保留空 windows 需要二选一；推荐 `session:null`，避免前端拿到半坏拓扑。

**Step 4：补 LANG=C 回归测试**

在 local connection 测试中新增用例：stub 返回旧 bug 形态：

```text
display-message: $1_tmex-snapshot
list-windows: @0_0_bash_1
list-panes: %1_@0_0_bash_1_80_24_1_node
```

断言最终 snapshot 不能包含 `@0_0_bash_1`；推荐断言 `session` 为 `null`。如果实现选择“空 windows”，则断言 windows 为空且没有坏 id。

Run:

```bash
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts apps/gateway/src/tmux-client/snapshot-format.test.ts
```

Expected: PASS。

## Task 4：`selectWindow()` target-missing benign

**Files:**

- Modify: `apps/gateway/src/tmux-client/local-external-connection.ts:260-266`
- Modify: `apps/gateway/src/tmux-client/ssh-external-connection.ts:238-244`
- Test: `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- Test: `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`

**Step 1：写失败测试**

local 测试新增：

- 连接成功后调用 `connection.selectWindow('@404')`。
- stub 对 `select-window -t @404` 返回 `{ exitCode: 1, stderr: "can't find window: @404" }`。
- 断言 `onError` 未被调用。
- 断言之后触发过 snapshot 刷新命令。

SSH 同理，fake payload 中 `select-window @404` 返回 exit 1。

Run:

```bash
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts
```

Expected: FAIL。

**Step 2：实现**

两处改为：

```ts
void this.runAndRefresh(['select-window', '-t', windowId], true).catch((error) => {
  this.callbacks.onError(error);
});
```

Run 同上，Expected: PASS。

## Task 5：WS 入站 target 校验和 snapshot 存在性校验

**Files:**

- Modify: `apps/gateway/src/ws/index.ts:584-637`
- Test: `apps/gateway/src/ws/index.test.ts`

**Step 1：写 WS 单测**

新增用例：

- `handleTmuxSelectWindow('device-a', '@0_0_bash_1')` 不调用 `runtime.selectWindow`，调用 `runtime.requestSnapshot`。
- `handleTmuxSelectWindow('device-a', '@404')` 在 `entry.lastSnapshot.session.windows` 不包含该 id 时不调用 `runtime.selectWindow`，调用 `runtime.requestSnapshot`。
- 合法且存在的 `@1` 才调用 `runtime.selectWindow('@1')`。
- `handleTmuxSelect()` 对非法 `windowId`/`paneId` 不启动 `switchBarrier`，不调用 `selectPane`，并请求 snapshot。

Run:

```bash
bun test apps/gateway/src/ws/index.test.ts
```

Expected: FAIL。

**Step 2：实现**

从 `snapshot-format.ts` import `isTmuxWindowId`/`isTmuxPaneId`。

实现建议：

- `handleTmuxSelectWindow`：
  - entry 不存在直接 return。
  - `!isTmuxWindowId(windowId)`：`console.warn`，`entry.runtime.requestSnapshot()`，return。
  - 若 `entry.lastSnapshot?.session?.windows` 存在且不包含 windowId：requestSnapshot，return。
  - 否则执行 `selectWindow`。
- `handleTmuxSelect`：
  - 只有在 windowId/paneId 都合法且存在于 lastSnapshot 时，才写 `selectedPanes`、刷新 polling、启动 switchBarrier。
  - 非法/不存在时 requestSnapshot 并 return；避免把坏 pane 写进 ws state。

Run:

```bash
bun test apps/gateway/src/ws/index.test.ts
```

Expected: PASS。

## Task 6：修正 `buildLocalTmuxEnv` 的 locale 兜底

**Files:**

- Modify: `apps/gateway/src/tmux/local-shell-path.ts:210-230`
- Modify: `apps/gateway/src/tmux/local-shell-path.test.ts:135-176`

**Step 1：写失败测试**

新增测试：

```ts
test('overrides non UTF-8 C locale for local tmux spawn', () => {
  expect(
    buildLocalTmuxEnv('/usr/bin:/bin', {
      HOME: '/Users/alice',
      PATH: '/usr/bin:/bin',
      LANG: 'C',
    })
  ).toMatchObject({
    LANG: 'C',
    LC_ALL: 'C.UTF-8',
  });
});
```

再覆盖 `LC_ALL: 'C'`、`LC_CTYPE: 'POSIX'` 的情况。

Run:

```bash
bun test apps/gateway/src/tmux/local-shell-path.test.ts
```

Expected: FAIL。

**Step 2：实现**

推荐策略：

- 如果 `LC_ALL`/`LC_CTYPE`/`LANG` 中已有任一 UTF-8 locale，保持现状。
- 如果没有 UTF-8 locale，设置 `LC_ALL='C.UTF-8'`。
- 不删除原 `LANG=C`，但 `LC_ALL` 优先级最高，可确保 tmux spawn 使用 UTF-8。

Run:

```bash
bun test apps/gateway/src/tmux/local-shell-path.test.ts
```

Expected: PASS。

## Task 7：runTmux 错误日志补上下文

**Files:**

- Modify: `apps/gateway/src/tmux-client/local-external-connection.ts:1018-1045`
- Modify: `apps/gateway/src/tmux-client/ssh-external-connection.ts:1074-1108`

**Step 1：实现最小日志增强**

在非 target-missing 错误路径中，`console.warn` 或传入 `notifyRuntimeError` 的上下文至少包含：

- connection type：`local` / `ssh`
- `deviceId`
- `sessionName`
- `argv`
- 原始 `exitCode`

不要把敏感 env 或凭证打入日志。

**Step 2：测试**

如果现有测试难以稳定断言 console 输出，可只做小范围单测 mock `console.warn`；否则保留为实现验证项，不要为了日志重构大块代码。

## 总验证

运行：

```bash
bun test apps/gateway/src/tmux-client/snapshot-format.test.ts \
  apps/gateway/src/tmux-client/local-external-connection.test.ts \
  apps/gateway/src/tmux-client/ssh-external-connection.test.ts \
  apps/gateway/src/ws/index.test.ts \
  apps/gateway/src/tmux/local-shell-path.test.ts
```

若上述通过，再运行 gateway 全量测试：

```bash
cd apps/gateway && bun test
```

可选手工验证（只在仓库临时实例或远端只读命令中做，不碰本机生产服务）：

```bash
LANG=C tmux list-windows -t <test-session> -F '#{window_id}|#{window_index}|#{window_name}|#{window_active}'
```

期望即使在 `LANG=C` 下也输出 pipe-delimited，parser 得到的 window id 仍是 `@<数字>`。

## 验收标准

- local snapshot 命令不再包含 `\t` 字段分隔。
- 任何 `@0_0_bash_1` 形态的 window id 都不会进入下发 snapshot。
- WS 入站收到非法 window/pane id 时不执行 tmux 写命令。
- 合法但过期的 `@N` select-window 不触发 `[conn-alert]`/`[push]`，只刷新 snapshot。
- `LANG=C`/`LC_ALL=C` 输入环境下，`buildLocalTmuxEnv` 给 tmux spawn 提供 UTF-8 locale。
- 生产修复只通过正式发版 + `tmex upgrade` 落地。

## 风险

- `|` 可能出现在窗口名或 pane title 中；必须使用 `splitSnapshotFields` 的“中间字段回填”逻辑，不能简单 `line.split('|')` 后按固定下标。
- parser fail closed 可能在异常 tmux 输出时让前端短暂看到 session disconnected/empty；这是可接受的，优先级高于下发半坏拓扑。
- 只改 `buildLocalTmuxEnv` 不足以根治；不同系统的 locale 可用性不同，分隔符与校验必须保留。
- 只加 WS 正则也不够；合法但过期的 `@N` 仍需 `allowTargetMissing=true`。
