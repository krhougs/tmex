# tmex 支持 OSC 9/777/1337 通知与全 pane 捕获

## Context

tmex 当前只捕获 pane 输出流中的裸 `BEL (0x07)` 触发 `terminal_bell` 事件，并存在三个限制：

1. `apps/gateway/src/tmux-client/local-external-connection.ts:653` 直接在原始字节里扫 `0x07`，**OSC 序列里作为 ST 的 BEL 也被误触发**（比如 `\033]2;title\007`）。
2. `pipe-pane` 只对当前 active pane 建立（`currentPipePaneId` 单值切换），**后台 pane 的通知看不见**。
3. 完全不解析 OSC 9 / OSC 777 / OSC 1337，而 Claude Code、Codex、OpenCode 等主流 Coding Agent 都用这些序列发桌面通知（iTerm2: OSC 9 / OSC 1337 RequestAttention；VSCode/urxvt/kitty: OSC 777），BEL 能到但拿不到标题和内容。

附带发现：`apps/fe/src/stores/tmux.ts:216,297` 发 `tmex:sonner` CustomEvent 但全工程没有监听器——**现有 bell 浏览器 toast 从来没真正弹出来过**，本次顺带修复为直接 `toast()`。

### 目标

让 gateway 在 pipe-pane 字节流里识别 `BEL / OSC 9 / OSC 777 / OSC 1337`，生成两类事件（`bell` 和 `notification`），按"BEL 开关 / 通知开关 × 网页 / Telegram / Webhook"四象限独立分发，覆盖所有窗口和 pane。

---

## 架构变更总览

```
tmux session
 ├─ pane A ─┐
 ├─ pane B ─┼─ pipe-pane -O ─> FIFO_per_pane ─> bun cat ─> pane-stream-parser
 └─ pane C ─┘                                            │
                                                         ├─ onTitle  -> snapshot.title
                                                         ├─ onBell   -> dedup(200ms) -> event:bell
                                                         └─ onNotification(source,title?,body)
                                                                             -> event:notification
 alert-bell hook (session 级) ───────────────────────────┘ 并入同一 dedup

gateway  event -> push/supervisor -> events/EventNotifier
                                        ├─ shouldPassBellThrottle          (独立)
                                        ├─ shouldPassNotificationThrottle  (独立)
                                        ├─ webhook[eventMask includes …]
                                        └─ telegram[enableTelegram{Bell,Notification}Push]
         event -> ws/index broadcastTmuxEvent
                    ├─ bell 分支 (既有, sonner + console.log)
                    └─ notification 分支 (新增, sonner + console.log)
```

两个根本变化：

- **多 pipe-pane 同时激活**：把 `currentPipePaneId: string | null` 换成 `paneReaders: Map<paneId, PaneReaderHandle>`，每次 snapshot 变化后 `syncPipeReaders()` 对齐"期望 pane 集合"和"已开读取器集合"。`selectPane` 不再触发 pipe 切换。前端 terminal 渲染继续只拿 active pane 的输出——在 `ws/index.ts:broadcastTerminalOutput` 里已有 `selectedPanes[deviceId] === paneId` 过滤，保留即可。
- **解析集中在 parser**：裸 BEL 检测从连接层移入 parser，保证 OSC 状态下的 BEL 作为 ST 被消费、不触发 bell。`resolveBellContext` 改名为 `resolvePaneContext`，bell 和 notification 共用同一个 pane 上下文解析函数（代码库规则禁止兼容层，直接改所有调用方，不留 re-export）。

---

## Parser 设计（`pane-stream-parser.ts`，替换旧 `pane-title-parser.ts`）

### 状态机

`normal | esc | osc-params | osc-body | osc-st | screen-title | screen-title-st`

- **normal**
  - `ESC (0x1b)` → `esc`
  - `BEL (0x07)` → `onBell()`，不入输出
  - 其他 → 入输出
- **esc**
  - `]` → `osc-params`，重置 `oscKind=''` / `oscPayloadBuf=[]`
  - `k` → `screen-title`（保留旧功能）
  - 其他 → 把 `ESC` + 当前字节回刷到输出，回 `normal`
- **osc-params**（分号前的 kind 数字）
  - `;` → 若 `oscKind ∈ {'0','1','2','9','777','1337'}` 进 `osc-body`；否则进 `osc-body-ignore`（消费到 ST，不 emit，不回刷字节）
  - `BEL / ESC\\` → 空 payload 结束，按 kind 派发（kind 是 title 时 body 空即丢弃）
  - `ESC` → `osc-st`
  - 其他字节 → 累加到 `oscKind`（上限 16 字节，超长转 ignore）
- **osc-body**
  - `BEL` → 派发 emit，回 `normal`（**关键：不触发 onBell**）
  - `ESC` → `osc-st`
  - 其他 → 累加到 `oscPayloadBuf`（上限 8KB，超长转 ignore 模式继续吞到 ST，`console.warn` 去重后报一次）
- **osc-st**
  - `\\ (0x5c)` → 派发 emit，回 `normal`
  - 其他 → `payload.push(0x1b, byte)`，回 `osc-body`
- **screen-title / screen-title-st**：保留现有行为（BEL / ESC\\ 均触发 title emit，**BEL 不触发 onBell**）

### 派发规则

```ts
dispatchOsc(kind, payload):
  '0'|'1'|'2' -> onTitle(payload.trim())
  '9'         -> if /^4(;|$)/.test(payload) return    // OSC 9;4;st;pr 是 iTerm2 进度条，丢弃
                 onNotification({source:'osc9', title: undefined, body: payload})
  '777'       -> let [verb, rest] = payload.split(';', 2 个分隔位置)
                 if verb !== 'notify' return
                 let [title, body] = rest.split(第一个 ';') // body 保留后续分号
                 onNotification({source:'osc777', title, body})
  '1337'      -> if /^RequestAttention=(yes|once|fireworks|true)$/i.test(payload)
                   onNotification({source:'osc1337', title: undefined, body:'RequestAttention'})
                 其他 iTerm2 子命令（SetMark/CurrentDir/File/…）一律丢弃
```

### 边界

- 跨 `push()` 调用状态保留（`osc-st`/`screen-title-st` 等尾态持久化）。
- 空 body 且空 title 的通知在 gateway 层丢弃（见 supervisor 补齐后）。
- OSC 9 payload 含分号视为普通字符（规范没切分语义）。
- 未知 OSC kind 整段吞掉，**不回刷字节**（否则用户会看到残留 OSC 文本）。

### 回调接口

```ts
interface PaneStreamParserOptions {
  onTitle: (title: string) => void;
  onBell: () => void;
  onNotification: (n: { source: 'osc9'|'osc777'|'osc1337'; title?: string; body: string }) => void;
}
```

---

## 多 pipe-pane 生命周期

`LocalExternalTmuxConnection`（SSH 对称同构）：

- 字段：删 `currentPipePaneId / pipeReadAbort`；新 `paneReaders: Map<string, PaneReaderHandle>`，`PaneReaderHandle = { paneId, fifoPath, parser, readerProcess, stopReader }`。
- 新方法：
  - `startPipeForPaneNow(paneId)`：建 FIFO → `mkfifo` → `Bun.spawn cat fifo` → 建 parser → `pipe-pane -O -t paneId`
  - `stopPipeForPaneNow(paneId)`：`pipe-pane -t paneId`（空参停止）→ `stopReader()` → `rm fifo`
  - `syncPipeReaders()`：对齐 expected vs current。全过 `queuePipeTransition` 串行。
  - `stopAllPipeReaders()`：遍历并停。
- 触发点：
  - 初次 `connect` 结束后的首次 snapshot
  - `parseSnapshotPanes()` 结束后调一次（新 pane 自动 start，消失的 pane 自动 stop）
  - `disconnect()`：先 `stopAllPipeReaders()`、再 `stopHooks()`、再 `rm -rf rootDir`
- `selectPaneInternal()` 去掉对 pipe 的任何操作。
- **BEL dedup 统一入口**：把 hook 分支和 parser 分支都走 `recordBell(paneId)`，共用 `bellDedup: Map<string,number>` 和 `BELL_DEDUP_WINDOW_MS = 200`（`local-external-connection.ts:29,89,356`）。

### Terminal output 路由

所有 pane 字节都进 parser，parser 剥掉 OSC / BEL 后的字节通过 `onTerminalOutput(paneId, bytes)` 交给连接层。现有 `ws/index.ts:broadcastTerminalOutput` 已经按 `selectedPanes[deviceId]` 过滤到 active pane，非 active pane 的 output 在 WS 层静默丢弃。此策略保持不变。

### SSH MaxSessions 风险

SSH 侧每 pane 一个 channel（加上 command/hook channel），openssh 默认 `MaxSessions=10`，pane 多于 ~7 个会报错。**v1 按每 pane 一 channel 直白实现**，在 README 加一句"SSH 目标机请将 `MaxSessions` 调到 `>= pane 数 + 3`"。日后需要的话再做 remote dispatcher（单 channel 多路复用）。

---

## 事件与数据模型

### `packages/shared/src/index.ts`

```ts
export type TmuxEventType = ... | 'bell' | 'notification' | 'output';   // 新增 notification
export type NotificationSource = 'osc9' | 'osc777' | 'osc1337';

export interface TmuxNotificationEventData {
  source: NotificationSource;
  title?: string;
  body: string;
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  paneUrl?: string;
}

export type EventType = 'terminal_bell' | 'terminal_notification' | ...;   // 新增

export interface SiteSettings {
  ...
  enableBrowserBellToast: boolean;
  enableBrowserNotificationToast: boolean;       // 新增
  enableTelegramBellPush: boolean;
  enableTelegramNotificationPush: boolean;       // 新增
  bellThrottleSeconds: number;
  notificationThrottleSeconds: number;           // 新增，默认 3
}
```

### Borsh Schema (`packages/shared/src/ws-borsh/{schema,convert}.ts`)

- `schema.ts`：新增 `NotificationEventSchema`（source `u8` + title `Option<string>` + body `string` + 既有位置字段）；`NotificationSourceU8 = { osc9:1, osc777:2, osc1337:3 }`。
- `convert.ts`：
  - `encodeTmuxEventPayload` 的 `eventTypeMap` 加 `notification: 11`
  - `encodeEventData` / `decodeEventData` 加 `case 'notification'`
  - `decodeTmuxEventPayload` 反向 map 里加 `11: 'notification'`
- **不做老前端兼容**：gateway 和 fe 同属本仓库同版本发布，前后端同步升级；不留 fallback 分支、不加 capability 协商、不写 `?? 'output'` 这类兜底。老客户端连接新 gateway 拿到未知 tag 直接异常即可，由版本号控制。

### DB schema (`apps/gateway/src/db/schema.ts` + migration)

新增三列，全部 `NOT NULL DEFAULT ...`：
```sql
ALTER TABLE site_settings ADD COLUMN enable_browser_notification_toast INTEGER NOT NULL DEFAULT 1;
ALTER TABLE site_settings ADD COLUMN enable_telegram_notification_push INTEGER NOT NULL DEFAULT 1;
ALTER TABLE site_settings ADD COLUMN notification_throttle_seconds INTEGER NOT NULL DEFAULT 3;
```
`apps/gateway/src/db/index.ts` 的 `toSiteSettings` / `ensureSiteSettingsInitialized` / `updateSiteSettings` 同步加字段。`apps/gateway/src/config.ts` 加 `notificationThrottleSecondsDefault` 环境变量兜底。

---

## Gateway 路由

### `apps/gateway/src/push/supervisor.ts`

- `BellNotificationContext` 旁增 `NotificationEventContext`；`PushSupervisorDeps` 加 `notifyNotification`
- `handleTmuxEvent` 新增 `event.type === 'notification'` 分支：复用 `resolvePaneContext` 补齐 window/pane/paneUrl，body+title 全空则直接 return（丢弃空通知），否则调 `deps.notifyNotification`
- `defaultDeps.notifyNotification` 调 `eventNotifier.notify('terminal_notification', { ..., payload: { source, title, message: body } })`

### `apps/gateway/src/events/index.ts`

- `EventNotifier` 加 `notificationThrottleMap` 和 `shouldPassNotificationThrottle(event)`（与 bell 同构，throttle key = `${deviceId}:${paneId}:notification:${source}`，读 `settings.notificationThrottleSeconds`）
- `notify()` 分流：`terminal_bell` 走 bell throttle，`terminal_notification` 走 notification throttle
- `sendTelegramNotifications` 加 `terminal_notification` 分支：
  - 先读 `settings.enableTelegramNotificationPush`，false 直接 return
  - 新 `formatTelegramNotificationMessage(event)`：HTML 格式，包含 source tag、title（若有）、body、paneUrl 链接
- `formatTelegramMessage` 的 `emojiMap: Record<EventType, string>` 追加 `terminal_notification: '🔔'`（TS 强制需要）
- `sendWebhooks` 不用改，只要 webhook endpoint 的 `eventMask` 里订阅了新类型即可——前端 webhook 编辑 UI 的 event mask checkbox 列表加一项

### `apps/gateway/src/ws/index.ts`

- `broadcastTmuxEvent` 加 `notification` 分支，调用 `enrichNotification(deviceId, data)`（内部复用 `resolvePaneContext`）补全，编码后广播
- `ws/borsh/session-state.ts` 加 `notificationThrottles: Map<string, BellThrottleContext>` 和 `shouldAllowNotification()`（结构对称 `shouldAllowBell`），`cleanup(deviceId)` 同步清理

### `apps/gateway/src/tmux/bell-context.ts`

- `resolveBellContext` 改名 `resolvePaneContext`，return type 改为 `PaneLocationContext`（字段与 `TmuxBellEventData` 同形）。**删除旧函数名**，同步改所有调用方。

---

## 前端（`apps/fe/src/stores/tmux.ts`）

- 文件顶 `import { toast } from 'sonner';`
- `handleTmuxEvent` 的 `bell` 分支：
  - 无条件 `console.log('[tmex] bell', data)` 作为 debug 备份
  - 若 `settings?.enableBrowserBellToast !== false`：直接 `toast('Terminal Bell', { description, action: paneUrl ? { label:'Open', onClick:()=>location.href=paneUrl } : undefined })`
  - 删除 `window.dispatchEvent(new CustomEvent('tmex:sonner', ...))`
- 新增 `notification` 分支：
  - 无条件 `console.log('[tmex] notification', data)`
  - 若 `settings?.enableBrowserNotificationToast !== false`：`toast(data.title || 'Terminal Notification', { description: data.body || `From ${data.source}`, action: paneUrl ? {...} : undefined })`
- WS error 的 `tmex:sonner` 调用同步改 `toast.error('WebSocket Connection Error', { description: 'Please check Gateway status' })`

**`SettingsPage.tsx`** 新增三个字段的 state、useEffect 初始化、PATCH body 和 UI 控件（沿用既有 bell 控件样式）。

**i18n**（`packages/shared/src/i18n/locales/*.json` 的 **源文件** — `zh_CN.json` / `en_US.json` / `ja_JP.json`）新增 keys：`settings.enableBrowserNotificationToast`、`settings.enableTelegramNotificationPush`、`settings.notificationThrottle`、`notification.eventType.terminal_notification`、`notification.telegramNotification.*`。**不要手工改 `resources.ts` 和 `types.ts`**（AGENTS.md 禁止 lint/format 生成文件），改完跑 `bun run build:i18n`。

---

## tmux 选项（用户需求 #2）

`local-external-connection.ts` 和 `ssh-external-connection.ts` 在 `ensureSession()` 之后、`startHooks()` 之前插入 `configureSessionOptions()`：

```ts
private async configureSessionOptions(): Promise<void> {
  await this.runTmuxAllowFailure(['set-option','-t',this.sessionName,'-s','allow-passthrough','on']);
  await this.runTmuxAllowFailure(['set-option','-t',this.sessionName,'-g','extended-keys','on']);
  await this.runTmuxAllowFailure(['set-option','-t',this.sessionName,'-s','extended-keys-format','csi-u']);
  await this.runTmuxAllowFailure(['set-option','-t',this.sessionName,'-g','focus-events','on']);
}
```

`runTmuxAllowFailure` 容错老版本 tmux（3.3 以下无 `allow-passthrough`、3.2 以下无 `extended-keys`、3.4 以下无 `extended-keys-format`）。

**说明**：`pipe-pane` 抓的是 pane 进程的原始 pty 字节，OSC 9/777/1337 的可达性**不依赖** `allow-passthrough`（parser 无论如何都能拿到）。开 `allow-passthrough` 的目的是让用户在宿主终端（比如 iTerm2 通过 `tmux attach`）也能原样收到 OSC，方便本地桌面通知联动。`extended-keys` 让 CSI u 修饰键序列能正确穿透 tmux，和通知解耦但属于合理的一次性配置。

---

## 关键文件修改清单

### 新增
- `apps/gateway/src/tmux-client/pane-stream-parser.ts`
- `apps/gateway/src/tmux-client/pane-stream-parser.test.ts`
- `apps/gateway/src/db/migrations/NNNN_notification_settings.sql`（drizzle-kit 生成）

### 删除
- `apps/gateway/src/tmux-client/pane-title-parser.ts` + 其 test（场景全数迁到 pane-stream-parser.test.ts）

### 修改
- `packages/shared/src/index.ts` — 事件类型、`SiteSettings`、`UpdateSiteSettingsRequest`
- `packages/shared/src/ws-borsh/schema.ts` — `NotificationEventSchema`
- `packages/shared/src/ws-borsh/convert.ts` — tag `11` 与 encode/decode
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — 新 keys；用 `bun run build:i18n` 重建产物
- `apps/gateway/src/db/schema.ts` — 三列
- `apps/gateway/src/db/index.ts` — `toSiteSettings` / `ensureSiteSettingsInitialized` / `updateSiteSettings`
- `apps/gateway/src/config.ts` — `notificationThrottleSecondsDefault`
- `apps/gateway/src/tmux/bell-context.ts` — `resolveBellContext` → `resolvePaneContext`
- `apps/gateway/src/tmux-client/local-external-connection.ts` — `paneReaders` Map、`configureSessionOptions`、parser 接入、BEL dedup 合并入口、去除 selectPane 的 pipe 启停
- `apps/gateway/src/tmux-client/ssh-external-connection.ts` — 对称
- `apps/gateway/src/push/supervisor.ts` — notification 分支 + `notifyNotification`
- `apps/gateway/src/events/index.ts` — notification throttle、Telegram 格式、emojiMap
- `apps/gateway/src/ws/index.ts` + `ws/borsh/session-state.ts` — notification 广播 + throttle
- `apps/gateway/src/api/index.ts` — settings PATCH body 校验加三字段
- `apps/fe/src/stores/tmux.ts` — 双分支 + console.log + 直接 toast
- `apps/fe/src/pages/SettingsPage.tsx` — 三个新 UI 控件

### 测试更新
- `apps/gateway/src/tmux-client/local-external-connection.test.ts` / `ssh-external-connection.test.ts` — 新增 `set-option` 调用的 mock 返回；多 pane 并发 bell 集成 case；selectPane 不再启动 pipe
- `apps/gateway/src/events/index.test.ts` — notification throttle / toggle / format
- `apps/gateway/src/push/supervisor.test.ts` — notification 路由

---

## 验证方案

### 手工字节触发（在任一被管 pane 内）

```bash
printf '\a'                                     # 裸 BEL -> bell
printf '\033]9;hello from tmex\007'             # OSC 9 notification
printf '\033]9;hello\033\\'                     # OSC 9 with ESC \ terminator
printf '\033]9;4;1;42\007'                      # OSC 9 progress -> 忽略
printf '\033]777;notify;Build finished;All 42 tests passed\007'   # OSC 777 完整
printf '\033]777;notify;title;body;with;semicolons\007'            # body 保留分号
printf '\033]1337;RequestAttention=yes\007'     # OSC 1337 -> notification
printf '\033]1337;SetMark\007'                  # OSC 1337 非通知 -> 忽略
printf '\033]2;new title\007'                   # 标题；验证 0x07 不被当 bell
```

### 测试矩阵

| 场景 | 期望 |
|---|---|
| 裸 BEL | emit bell；toast + console.log + Telegram（按开关） |
| OSC 9 消息 | emit notification source=osc9；不 emit bell |
| OSC 9 进度条 | 无事件；字节不泄漏到前端 |
| OSC 777 title+body | emit notification，字段完整 |
| OSC 777 body 含 `;` | 只劈前两段 |
| OSC 1337 RequestAttention=yes | emit notification source=osc1337 |
| OSC 1337 其他子命令 | 无事件 |
| OSC 0/2 标题 | 只更新标题；**不 emit bell（关键回归）** |
| 多 pane 并发 | 每 pane 独立 emit，source pane 正确 |
| 后台 pane 发 bell | emit，paneId 为源 pane 而非 active pane |
| bell toast 关 + tg 开 | console.log 打；前端无 toast；tg 有推送 |
| 通知 toast 关 + tg 开 | 同上，独立 |
| 全关 | 仅 console.log；无任何推送 |
| throttle 生效 | 3s 内同 source 同 pane 只弹一次 |

### 回归

- `pane-title-parser` 原有 5 个 case 全部在 `pane-stream-parser.test.ts` 覆盖并通过
- `resolveBellContext`（改名后）单测通过
- bell Telegram HTML 格式不变
- `selectPane` 不再启动 pipe 的前提下，前端 terminal 仍能渲染 active pane 输出、历史、resize

### 端到端（Playwright 或手工）

1. `bun run dev` 起 gateway + fe；新建一个 local device
2. pane A `printf '\a'` → 右上角 sonner `Terminal Bell`；DevTools Console 有 `[tmex] bell`
3. pane A `printf '\033]777;notify;Build finished;OK\007'` → sonner 标题 `Build finished` 描述 `OK`；console 有 `[tmex] notification`
4. Settings 关通知 toast → console 仍打，sonner 不弹
5. `tmux split-window -h` 分屏，在后台 pane 触发 BEL + OSC 9 → 两个事件都到前端，paneId 指向后台 pane
6. 配置 Telegram bot + 授权 chat，重复 2-3，手机收消息，HTML 链接可点

---

## 风险与未决

1. **SSH MaxSessions**：每 pane 一个 channel，pane 多于 7 可能触顶。v1 直白实现 + README 提示；v2 做单 channel 多路复用 dispatcher。
2. **OSC 777 格式变体**：各 agent 可能额外塞 urgency / app-id 字段。先按 `notify;title;body` 最小协议走，待真实数据出现再扩展。
3. **OSC 1337 子命令覆盖**：只认 `RequestAttention`；其他命令（SetMark/File 等）与通知无关。
4. **OSC 9 vs OSC 9;4**：严格正则 `/^4(;|$)/`，避免把 `"40% done"` 当进度条。
5. **allow-passthrough 在 nested tmux**：外层开启不影响内层；pipe-pane 拿的是外层 tmux 看到的最终 pty 字节，无需内层配合（除非 agent 用 `DCS tmux;` 包，目前主流 agent 不用）。
6. **前端 sonner 旧 bug 顺带修复**：现有 bell toast 因缺监听器从未弹出，改成直接 `toast()` 调用后即修。
7. **前后端版本绑定**：本次变更是 breaking，需要在 gateway 和 fe 同时发布的版本里同步升级，不能只更新一侧。

---

## 实施步骤 0：归档（AGENTS.md 强制，批准后立刻执行，先于任何代码改动）

1. `mkdir -p prompt-archives/2026041700-osc-notification-support/`
2. 写 `plan-prompt.md`：
   - 第一段：用户原始问题（Coding Agents 通知机制调研）
   - 第二段：用户的 9 条需求（"支持OSC9/777 ... 保证所有窗口和 pane 内的消息都能同时被收到"）
   - 第三段：追加说明（"不用兼容老前端"）
3. `cp` 本文件到 `prompt-archives/2026041700-osc-notification-support/plan-00.md`（或直接写同内容）
4. 实现完成后再追加 `plan-00-result.md` 记录执行结果

**先存档，再干活**。任何一次后续对话 prompt 也追加写进 `plan-prompt.md`。

---

## 关键文件路径速查

- 新 parser：`apps/gateway/src/tmux-client/pane-stream-parser.ts`
- 多 pane 连接：`apps/gateway/src/tmux-client/local-external-connection.ts:29,89,310,356-359,620-675` 和 SSH 对称
- Pane 上下文：`apps/gateway/src/tmux/bell-context.ts`
- Gateway 路由：`apps/gateway/src/push/supervisor.ts` + `apps/gateway/src/events/index.ts`
- WS 广播 + throttle：`apps/gateway/src/ws/index.ts` + `apps/gateway/src/ws/borsh/session-state.ts`
- Borsh schema：`packages/shared/src/ws-borsh/{schema,convert}.ts`
- 共享类型：`packages/shared/src/index.ts`
- DB：`apps/gateway/src/db/{schema,index}.ts` + 新 migration
- 前端：`apps/fe/src/stores/tmux.ts` + `apps/fe/src/pages/SettingsPage.tsx`
- i18n 源：`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（**不要**手改 `resources.ts` / `types.ts`）
