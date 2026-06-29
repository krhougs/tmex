# Issue #41 修复：终端输出卡死 — stdin 心跳 + %pause 处理 + pump 自恢复

## Context

tmex gateway 通过 `tmux -C attach-session` 控制模式订阅终端输出。运行一段时间后（7-15 个 busy pane 持续高输出），**所有客户端的终端输出同时停止**，输入正常，刷新无解，必须重启 gateway 才能恢复。

根因是三层叠加的防御缺失：
1. **无卡死检测**：控制客户端因任何原因停止输出（Bun ReadableStream 挂起、tmux 缓冲异常等），gateway 无法感知也无法自我恢复
2. **`%pause` 流控未处理**：parser 识别了 `%pause`/`%continue`，但 subscription 层完全忽略，stdin 也被设计为"永不写入"无法回应
3. **`pumpControlStdout` 无恢复**：pump 循环异常退出后进程仍活着但没人再读 stdout，变成僵尸

核心修复是给控制客户端添加 stdin 写入能力，实现 stdin 心跳探测（判定通路畅通与否）、`%pause` 即时恢复、pump 异常自恢复。本地连接和 SSH 连接两侧同步修改。

---

## 任务 1：为控制客户端添加 stdin 写入能力

### 本地连接 (`local-external-connection.ts`)

`ControlClientProcess` 接口（line 42-48）新增 `write`：

```typescript
export interface ControlClientProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
  write: (data: string) => void;  // 新增
}
```

`defaultSpawnControlClient`（line 132-155）实现：现有的 `stdin` 引用已经持有（防 GC 关闭）。添加 `write` 方法调用 `stdin.write(data)`，`try/catch` 容忍进程已退出。更新 line 135 注释（去掉"永不写入"）。

### SSH 连接 (`ssh-external-connection.ts`)

`ControlChannelHandle` 接口（line 60-62）新增 `write`：

```typescript
interface ControlChannelHandle {
  stop: () => void;
  write: (data: string) => void;  // 新增
}
```

`openReaderChannel`（line 1254）返回类型从 `() => void` 改为 `{ stop: () => void; write: (data: string) => void }`。把 `stream` 引用通过返回值暴露。只有 `openControlChannel` 调用了 `openReaderChannel`，改动安全。

`openControlChannel`（line 651）中初始化 handle 时设 `write: () => {}`，然后从 reader 结果桥接：`handle.write = reader.write`。

---

## 任务 2：`%pause`/`%continue` 通知处理

### `control-mode-subscription.ts`

`ControlModeSubscriptionCallbacks`（line 30-40）新增：

```typescript
onPause?: (paneId: string) => void;
onContinue?: (paneId: string) => void;
```

`handleNotification`（line 100-104）添加分支：

```typescript
if (notification.type === 'pause') {
  callbacks.onPause?.(notification.args.trim());
} else if (notification.type === 'continue') {
  callbacks.onContinue?.(notification.args.trim());
}
```

### 两侧 connection

subscription 回调中添加 `onPause`，收到后通过 stdin 发：

```
refresh-client -A '<paneId>:continue'\n
```

`onContinue` 仅做日志记录（diagnostics）。

> 注：plan-00.md 明确说"不传 `-f pause-after`，默认无 `%pause`"。此处理是防御性措施，覆盖用户手动设置 `pause-after` 或 tmux 版本行为差异的边缘场景。

---

## 任务 3：stdin 心跳探测

### 常量

```typescript
const HEARTBEAT_INTERVAL_MS = 30_000;   // 30 秒一次
const HEARTBEAT_TIMEOUT_MS = 10_000;    // 10 秒无回复判定卡死
```

### 心跳模型

采用 `heartbeatPending` 标志 + 单次超时模型：发一个心跳命令，设超时定时器。收到回复则清标志+清定时器。超时未回复则杀进程触发重连。

字段：
```typescript
private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
private heartbeatPending = false;
private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
```

方法：

- `startHeartbeat()`：`startControlClient` 成功后调用。`setInterval(HEARTBEAT_INTERVAL_MS)` 定期调 `sendHeartbeat()`
- `stopHeartbeat()`：清理所有心跳相关定时器。在 `stopControlClient()` 中调用
- `sendHeartbeat()`：
  1. 守卫：`!proc || heartbeatPending || !connected || manualDisconnect` → return
  2. 设 `heartbeatPending = true`
  3. 通过 stdin 发 `display-message -p "tmex-hb"\n`
  4. 设 `heartbeatTimeoutTimer = setTimeout(HEARTBEAT_TIMEOUT_MS)` → 超时则 warn + 杀进程
- `onHeartbeatResponse()`：清 `heartbeatPending` + 清 `heartbeatTimeoutTimer`

### 回复检测

`onBlockEnd` 回调中追加逻辑：

```typescript
onBlockEnd: (block) => {
  onAttachReady();
  if (!block.isError && block.lines.length === 1 && block.lines[0] === 'tmex-hb') {
    this.onHeartbeatResponse();
  }
},
```

首次 `%begin/%end` 用于 attach ready（`onAttachReady` 只执行一次后失效），心跳回复通过 block 内容精确匹配 `tmex-hb`。`refresh-client -A` 的回复 block 内容为空字符串或错误信息，不会误匹配。

### 心跳杀进程与现有重连的交互

心跳触发的 kill 走已有的 `handleControlClientExit` → `reconnectControlClient` 路径，受 `CONTROL_MAX_RESTARTS`（3次）和 `CONTROL_STABLE_RESET_MS`（10s）约束。如果控制客户端不可恢复，会耗尽重连预算后干净关闭。

### SSH 侧

逻辑完全一致，通过 `this.controlChannel?.write(...)` 发命令，杀掉方式是 `handle.stop()` 触发 `handleControlChannelClose` → `reconnectControlClient`。

---

## 任务 4：pump 循环异常自恢复

### `pumpControlStdout` 修复 (`local-external-connection.ts`, line 667-686)

在循环退出后追加检查——如果 pump 退出但进程还是当前控制客户端，强制杀掉以触发重连：

```typescript
subscription.end();
if (this.controlProcess === proc) {
  console.warn(`[local] control client stdout ended unexpectedly, killing process`);
  proc.kill();
}
```

SSH 侧对应位置在 `onClose` 回调中已有 `handleControlChannelClose`，无需额外修改。

---

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `local-external-connection.ts` | `ControlClientProcess` 加 `write`；心跳机制（start/stop/send/onResponse）；pump 修复；`onPause` 处理 |
| `ssh-external-connection.ts` | `ControlChannelHandle` 加 `write`；`openReaderChannel` 返回 `{stop, write}`；心跳机制；`onPause` 处理 |
| `control-mode-subscription.ts` | `onPause`/`onContinue` 回调 + `handleNotification` 分发 |

（均在 `apps/gateway/src/tmux-client/` 下）

## 边缘情况处理

- **写入已关闭的 stdin/channel**：所有 `write` 方法 try-catch，进程退出后写入不会 crash
- **重连期间心跳**：`stopControlClient` 调用 `stopHeartbeat`，新的控制客户端启动后重新 `startHeartbeat`
- **多个 `%pause` 事件**：连续 `%pause` 只是连续发 continue，无状态累积，无害
- **`%pause` 与心跳并发**：`heartbeatPending` 守卫防止同时发多个心跳命令；`%pause` 的 continue 是独立命令，不与心跳冲突
- **空闲会话**：`display-message` 命令的 `%begin/%end` 回复不依赖终端活动，空闲会话的心跳不会误判

## 测试策略

### 单测

- `control-mode-subscription.test.ts`：`%pause` 触发 `onPause`；`%continue` 触发 `onContinue`；两者不触发结构变更
- `local-external-connection.test.ts`：扩展 `FakeControlProcess` 加 `writtenData` 跟踪；心跳发送/回复/超时；`%pause` 触发 continue；pump 退出杀进程；disconnect 清理定时器
- `ssh-external-connection.test.ts`：通过 `FakeChannel.onWrite` 拦截写入；同样的心跳/pause/超时测试

### 验证命令

```bash
bun test apps/gateway/src/tmux-client/control-mode-subscription.test.ts
bun test apps/gateway/src/tmux-client/local-external-connection.test.ts
bun test apps/gateway/src/tmux-client/ssh-external-connection.test.ts
bun test  # 全量
```

### 手动验证

dev 环境起 gateway（worktree 内 `bun run dev`），开多个 busy pane（`yes`/`find /`），观察 console 心跳日志，确认 30s 间隔正常回复。

## 执行顺序

1. **并行**：任务 1（本地 write）、任务 1（SSH write）、任务 2（subscription onPause）
2. **依赖 1+2**：任务 3（两侧心跳）+ 任务 4（pump 修复）
3. **依赖全部**：测试
