# Herdr Device 可行性评估

> 研究日期：2026-07-10  
> tmex 基线：`main`，`af0666b`，tmex-cli 0.17.0  
> Herdr 基线：0.7.3，`b137c7b`

## 背景

tmex 当前以 tmux 作为终端复用器，通过一次性 tmux CLI 执行结构操作，并通过 Control Mode 接收实时输出和结构通知。为评估后续替换 tmux 的可能性，本次研究对 Herdr 的公开控制接口、Agent 状态检测、可复用产品能力和引入风险进行了只读分析。

Herdr 是自己持有 PTY、终端状态和工作区结构的独立终端复用器，不是 tmux 的控制层或兼容前端。因此，引入 Herdr 等同于增加一套新的终端后端，不能通过替换若干 tmux 命令完成。

## 评估目标

1. 判断 Herdr 是否提供类似 tmux Control Mode 的机器控制接口。
2. 对照 tmex 当前依赖的 tmux 能力，确认完整、部分和缺失的覆盖范围。
3. 理解 Herdr 对不同 Agent、Shell、操作系统和外层终端的状态检测机制。
4. 识别可增强 tmex 体验的 Herdr 能力。
5. 评估许可证、协议稳定性、安全、分发、远程访问和迁移风险。

## 总体结论

Herdr 已提供较完整的公开机器控制面，技术上可以为 tmex 实现独立 provider，但目前不能无损替换 tmux。

主要结论如下：

- Workspace、Tab、Pane 的结构管理、输入、读屏、事件、进程信息和 Agent 状态覆盖较完整。
- `herdr terminal session observe/control` 是最接近 tmux Control Mode 的实时终端桥接接口。
- Herdr 输出的是渲染后的 ANSI 差分帧，不是原始 PTY 字节流；tmex 当前依赖的 OSC 52、OSC 133、BEL、主题订阅等副通道没有完整的公开等价接口。
- Herdr 的尺寸、历史、焦点、多客户端和服务端恢复语义与 tmux 不同。
- 如果目标是增强 Agent 体验，优先借鉴 Herdr 的状态权威、`done/seen`、Explain、元数据和通知模型，风险低于引入第二套终端运行时。
- 如果目标是最终淘汰 tmux，应先把 tmex 重构为中立的 backend 架构，再增加实验性 Herdr provider。

## tmex 当前后端契约

### Device 模型

当前 `DeviceType` 为：

```text
local | ssh
```

这个字段表达的是连接方式，而不是终端后端。运行时工厂中，`local` 创建 `LocalExternalTmuxConnection`，其他类型直接进入 `SshExternalTmuxConnection`。

因此，直接新增 `type: herdr` 会同时产生两个问题：

- 无法表达远程 Herdr。
- 未重构工厂时会被错误地当成 SSH tmux 设备。

更合理的数据模型是：

```text
transport: local | ssh
terminalBackend: tmux | herdr
```

相关实现：

- `packages/shared/src/index.ts`
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/src/tmux-client/device-session-runtime.ts`

### 运行时接口

`DeviceSessionRuntimeConnection` 已形成事实上的后端契约，包含：

- 连接、断开和全量快照。
- Window/Pane 创建、关闭、聚焦、分屏、移动和调整大小。
- 实时输入、实时输出和历史恢复。
- 纯文本读屏及 Pane 进程、尺寸、光标、alternate screen 信息。
- Prompt Marker、剪贴板写入、错误和关闭事件。

同一个 runtime 会被 WebSocket、Push、Agent 和 Watch 共享，后端不能假定只有页面打开时才需要连接。

### tmux 特有泄漏

当前上层协议和 UI 仍包含以下 tmux 专有约束：

1. Session、Window、Pane ID 使用 `$N`、`@N`、`%N`。
2. 多 Pane 布局使用 tmux `window_layout` 字符串。
3. History 与 Live Output 之间有严格的切换屏障。
4. History 携带 alternate screen、光标和鼠标模式。
5. `tmuxAvailable`、`TmuxEventType` 等命名进入共享 API。
6. 当前没有 per-device capability 协商。

在接入 Herdr 前，至少需要解决 ID、布局和能力协商问题。

## Herdr 控制接口

### 公开接口

Herdr 提供三层公开控制面：

1. CLI Wrapper：适合短命令和人工调试。
2. NDJSON Socket API：适合请求响应、快照和长期事件订阅。
3. Terminal Session Bridge：适合第三方程序观察或控制实时终端。

Socket API 在 Unix 上使用 Unix Domain Socket，在 Windows 上使用 Named Pipe。未发现 HTTP、REST、WebSocket 或 TCP 控制服务。

主要文档和实现：

- `website/src/content/docs/socket-api.mdx`
- `website/src/content/docs/cli-reference.mdx`
- `src/api/server.rs`
- `src/client/mod.rs`

### 不应依赖的内部接口

Herdr 的 TUI 客户端使用另一套基于 `bincode` 的二进制协议，当前协议版本为 16。该协议用于客户端渲染、直接附加和远程桥接，版本升级时可以拒绝旧客户端。

tmex 不应自行实现该私有协议。实时终端接入应使用公开的：

```text
herdr terminal session observe
herdr terminal session control
```

### 结构快照与事件

`session.snapshot` 可返回：

- 版本和协议元数据。
- 当前聚焦的 Workspace、Tab 和 Pane。
- Workspace、Tab、Pane 和 Agent 记录。
- Tab 布局快照。

增量更新可通过 `events.subscribe` 获取，覆盖：

- Workspace 创建、更新、移动、关闭和聚焦。
- Tab 创建、重命名、移动、关闭和聚焦。
- Pane 创建、移动、关闭、退出和聚焦。
- Agent 检测和状态变化。
- Pane 滚动变化。
- Layout 更新。
- Worktree 生命周期。

推荐的客户端缓存模型是：

```text
session.snapshot → events.subscribe → revision 校验 → 断线后重新 snapshot
```

### 实时终端桥接

只读观察：

```text
herdr terminal session observe <target> --cols N --rows N
```

可写控制：

```text
herdr terminal session control <target> --takeover --cols N --rows N
```

两者都输出 NDJSON：

- `terminal.frame`
- `terminal.closed`

`terminal.frame` 包含：

- 序号。
- 宽高。
- 是否为完整帧。
- Base64 编码的 ANSI 字节。

控制模式还接受：

- `terminal.input`
- `terminal.resize`
- `terminal.scroll`
- `terminal.release`

限制是一个 Terminal 同时只能有一个可写控制者；多个 Observer 可以共存。

## 能力对照

| tmex 能力 | Herdr 对应能力 | 结论 |
| --- | --- | --- |
| 绑定一个持久会话 | 命名 Session | 基本匹配 |
| 全量结构快照 | `session.snapshot` | 完整 |
| Window 创建、关闭、聚焦、重命名 | Tab API | 完整 |
| Pane 创建、关闭、聚焦、分屏 | Pane API | 完整 |
| Pane 移动、交换、拆为新窗口 | `pane.move/swap` | 基本完整 |
| 输入文本和按键 | `pane.send_*`、Terminal Control | 完整 |
| 实时画面 | Terminal Observe/Control | 部分匹配 |
| 结构事件 | `events.subscribe` | 完整 |
| 当前和近期文本 | `pane.read` | 完整 |
| 输出匹配和等待 | `pane.wait_for_output`、`events.wait` | 完整 |
| 进程、命令和 cwd | `pane.process_info` | 较强 |
| 精确 Pane cols/rows | Controller viewport resize | 语义不同 |
| `even-horizontal` | 布局查询和比例调整 | 需适配算法 |
| History 恢复 | recent、ANSI read、首次完整帧 | 部分匹配 |
| Cursor、alternate screen、鼠标模式元数据 | 无完整公共字段 | 缺口 |
| Prompt Marker | 无公开等价事件 | 缺口 |
| OSC 52 剪贴板 | Herdr 内部消费，未公开 | 缺口 |
| BEL 和原始终端通知 | 无完整公开等价事件 | 缺口 |
| CSI 2031 和主题传播 | Terminal Control 无主题命令 | 缺口 |
| HTTP/WebSocket | 无 | 需要 Gateway Adapter |

## 实时流语义风险

tmux Control Mode 向 tmex 提供 Pane 原始输出。tmex 会从该字节流解析：

- BEL。
- OSC 0、1、2 标题。
- OSC 9、99、777、1337 通知。
- OSC 52 剪贴板。
- OSC 133 Shell 生命周期。
- CSI `?2031h/l` 主题订阅。
- DCS tmux passthrough。

Herdr 的公开实时流则是由其 Ghostty 终端模型生成的 ANSI 画面差分。原始控制序列可能已经被消费，不能假定会出现在桥接帧中。

这会直接影响：

- 浏览器剪贴板同步。
- Agent `run_command` 的 Prompt Marker 完成判断。
- Bell 和 OSC Push 通知。
- Pane 标题即时更新。
- TUI 主题同步。

这些能力必须逐项实测；无法补齐时应通过 capability 明确降级。

## Agent 状态检测

### 状态模型

底层语义状态只有：

```text
idle | working | blocked | unknown
```

`done` 不是第五个底层状态，而是：

```text
idle + 未查看
```

用户查看对应 Pane 后，展示状态从 `done` 变为 `idle`。

### 检测链路

Herdr 使用组合信号：

```text
前台进程识别
→ 内部 PTY/Ghostty 屏幕
→ 底部实时缓冲区和 OSC
→ Agent 专属 TOML Manifest
→ Hook/Plugin 权威仲裁
→ Pane/Tab/Workspace 聚合
→ API 事件和通知
```

它不依赖 Agent 日志、Transcript 数据库或私有会话数据库持续判断状态。集成上报的会话 ID 主要用于恢复。

### 不同操作系统

- macOS：使用 `proc_pidinfo`、`tcgetpgrp` 和 `sysctl(KERN_PROCARGS2)`。
- Linux：使用 `/proc/<pid>/stat`、`cmdline`、`cwd` 和前台进程组。
- Windows：扫描 Pane Shell 的后代进程树，属于启发式实现。

Linux 还支持进程级 `HERDR_AGENT=<agent>`，用于处理 VM、Bubblewrap 等隐藏真实进程的包装器。

### Shell 和外层终端

Agent 状态不依赖 bash、zsh、fish 的 Prompt Hook。Shell 适配主要用于识别包装命令的 argv。

Herdr 自己持有 PTY 并维护终端屏幕，因此检测原则上与 Ghostty、iTerm2、Kitty、WezTerm 等外层终端品牌无关。外层终端差异主要影响输入、通知和渲染，不决定 Agent 状态。

如果在 Herdr Pane 内再进入 tmux，Herdr 只能看到 tmux，无法穿透识别内部 Agent。

### 不同 Agent

- Claude Code、Codex、Cursor：屏幕 Manifest 决定状态；Hook 主要提供会话 ID。
- Pi、OMP、Kimi、OpenCode、Kilo、Hermes、MastraCode：安装完整集成后可由 Hook 或 Plugin 作为生命周期权威。
- Gemini、Cline：可检测，但官方标记为测试较少。
- 未知 Agent：作为普通终端运行，状态通常为 `unknown`。

已知 Agent 没有 Manifest 规则命中时通常回退为 `idle`。这是保守避免误报 blocked 的策略，但会增加 blocked 漏报风险。

### 检测稳定措施

Herdr 包含以下防抖和仲裁机制：

- 已识别 Agent 约 300ms 检测一次，未识别约 500ms。
- 已识别进程每 5 秒进行安全复查。
- Working 转普通 Idle 时进行多次确认，最长约 700ms。
- Agent 启动有 3 秒宽限期。
- 连续多次进程识别失败后才清除 Agent。
- Transcript Viewer 和 Model Picker 可跳过状态更新。
- Hook 上报支持来源和序号，抑制乱序或过期状态。
- `agent.explain` 可展示命中规则、证据和回退原因。

## 可借鉴的产品能力

### 高优先级

1. Agent Attention 模型
   - 统一 `blocked/working/done/idle/unknown`。
   - 按 Pane、Window、Device 向上汇总。
   - 提供 blocked 和 done 快速导航。

2. 可解释状态
   - 展示状态来源、规则、证据和回退原因。
   - 将启发式状态与显式 Hook 状态区分。

3. 展示型 Pane 元数据
   - `source`
   - `seq`
   - `ttl`
   - `appliesToSource`
   - `title`
   - `displayAgent`
   - `customStatus`

   展示元数据不得改变语义状态、触发输入或控制恢复。

4. 通知语义
   - 状态持续一定时间后再通知。
   - 当前 Pane 可见时抑制通知。
   - 通知携带可验证的导航目标。
   - 返回 disabled、rate-limited、busy 等未展示原因。

5. 全局导航
   - 搜索 Device、Window、Pane 和 Agent。
   - Last Pane。
   - blocked/done 轮转。

### 中优先级

- 有界 `recent-unwrapped`。
- `wait_for_output`。
- Worktree 工作区。
- 布局导出和模板。
- Agent 原生 Session ID 采集。
- Observer 与单写者 Lease。

### 暂不建议

- 全量持久化终端输出或 SQLite FTS。
- 自动恢复 Agent 并重放命令。
- 无鉴权的跨 Pane 全局控制 API。
- 任意代码插件和插件市场。
- 复制 Herdr Manifest、测试夹具或源码。

## 风险评估

### 高风险

#### 终端协议不等价

实时输出、History、尺寸和 OSC 副通道均不是 tmux Control Mode 的透明替代。

#### 多客户端控制权

单 Terminal 只有一个可写 Controller，需要定义 Gateway、浏览器和 Herdr TUI 之间的所有权、Takeover 和 Resize 规则。

#### 许可证

Herdr 使用 AGPL-3.0-or-later / 商业双许可证。

- 调用用户独立安装的 Herdr 进程，技术耦合相对较低。
- 捆绑、修改、链接或复制源码及 Manifest，需要完成正式法律评审。
- 不能仅凭“进程外 IPC”自行断言不存在衍生作品问题。

#### 上游稳定性

Herdr 仓库建立时间较短，当前版本低于 1.0，近期协议和功能演进较快。接入时必须锁定最低版本、进行 Schema 和能力探测，并准备兼容矩阵。

### 中风险

- Agent UI 文案变化导致 Manifest 漏报。
- 远程 Manifest 自动更新带来的供应链和可重复性问题。
- Socket 虽为 `0600`，但同用户进程可执行输入、关闭 Pane 等高权限操作。
- Pane History 和状态快照可能包含提示词、令牌及命令输出。
- 大量 Pane 下的 300–500ms 检测循环和进程扫描资源占用。
- 远程 SSH 需要在目标主机安装并维护 Herdr。
- Herdr Server 完整重启后普通进程不会无条件存活。
- Windows 仍为 Beta。

### 迁移限制

- 不能接管现有 tmux Pane 或 PTY。
- 不能与 iTerm2 等 tmux 客户端共享同一会话。
- tmux 与 Herdr 嵌套会产生两套快捷键、焦点、尺寸和恢复语义。
- 从 tmux 切换到 Herdr 应视为创建新的 Device/Session，而不是在线迁移。

## 推荐路线

### 路线 A：只吸收产品模型

保留 tmux 作为唯一终端运行时，在 tmex 内原生实现：

- Agent 状态权威和 Attention 聚合。
- `done/seen`。
- 状态 Explain。
- 展示型元数据。
- 通知延迟与前台抑制。
- 全局 Goto 和 Last Pane。
- 有界输出等待。

这是当前风险最低、收益最明确的路线。

### 路线 B：实验性 Herdr Provider

如果目标是验证最终替代 tmux，应限定为：

- macOS/Linux。
- 本地设备优先。
- Herdr 0.7.2 或更高并锁定兼容版本。
- 保留 tmux Provider。
- 使用公开 JSON Socket API 和 Terminal Session Bridge。
- 不实现私有 `bincode` 协议。
- 对 OSC、History、主题和多客户端能力进行显式降级。

推荐适配结构：

```text
Herdr JSON Socket
├── session.snapshot
├── events.subscribe
└── Workspace/Tab/Pane 控制

Herdr Terminal Session Bridge
├── ANSI Frame
├── Input
├── Resize
└── Scroll

tmex Gateway Adapter
├── 中立 ID 和 Layout
├── Capability
├── History/Live 屏障
└── Borsh WebSocket
```

## 验证性 Spike

### 终端正确性

- 首次完整帧和后续差分帧。
- Claude Code、Codex、Vim、Neovim、Less。
- Main/Alternate Screen 切换。
- 鼠标模式、宽字符、软折行和 Resize。
- 断线重连和首次 History。

### 副通道

- OSC 52 剪贴板。
- OSC 133 Prompt Marker。
- BEL 和 OSC 通知。
- OSC 0/2 标题。
- CSI 2031 和 OSC 10/11 主题。

### 多客户端

- 两个浏览器。
- Herdr TUI 与 tmex 同时连接。
- 两个 Gateway。
- Observer、Controller、Takeover、Resize 和 Focus。

### 结构同步

- Snapshot 后订阅事件。
- 外部创建、关闭、移动和调整 Pane。
- Layout Revision 丢失后的恢复。
- ID 在重连和跨 Workspace Move 后的稳定性。

### 远程和生命周期

- macOS、Linux 和高延迟 SSH。
- Herdr 未安装、版本不兼容和 Server 未启动。
- SSH 断线、Gateway 重启、Herdr Server 重启。
- 远端 PATH、Named Session 和多 SSH Channel。

### 性能

- 1、10、50 个空闲 Pane。
- 多个持续输出 Pane。
- CPU、RSS、帧吞吐、检测延迟和 SSH 流量。

### Agent 准确率

- Claude Code、Codex、Cursor、OpenCode 和 Gemini。
- Working、Blocked、Esc 中断、审批结束、后台 Agent 和 Transcript Viewer。
- 统计 blocked 漏报、误报和 stale 状态。

## 验收标准

实验性 Provider 至少应满足：

1. 不影响现有 tmux Provider。
2. Gateway 重启后可以重新获取一致快照。
3. 终端切换不出现 History 覆盖 Live Output。
4. 常见 TUI 的光标、Alternate Screen、鼠标和 Resize 正常。
5. 多客户端控制权不会静默抢占或丢失输入。
6. 不支持的能力通过 Capability 明确禁用。
7. 不读取或复制 tmux/Herdr 生产会话数据完成测试。
8. 许可证和分发方式通过正式评审。

## 参考文件

### tmex

- `packages/shared/src/index.ts`
- `packages/shared/src/tmux-layout.ts`
- `apps/gateway/src/tmux-client/device-session-runtime.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/control-mode-subscription.ts`
- `apps/gateway/src/tmux-client/pane-stream-parser.ts`
- `apps/gateway/src/tmux-client/capture-history.ts`
- `apps/gateway/src/ws/index.ts`
- `apps/gateway/src/agent/tools/terminal.ts`
- `apps/gateway/src/watch/service.ts`
- `apps/fe/src/components/terminal/SplitTerminalArea.tsx`

### Herdr

- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `website/src/content/docs/socket-api.mdx`
- `website/src/content/docs/cli-reference.mdx`
- `website/src/content/docs/agents.mdx`
- `website/src/content/docs/integrations.mdx`
- `website/src/content/docs/session-state.mdx`
- `website/src/content/docs/plugins.mdx`
- `src/api/schema.rs`
- `src/client/mod.rs`
- `src/protocol/wire.rs`
- `src/detect/mod.rs`
- `src/detect/manifest.rs`
- `src/detect/manifests/`
- `src/pane.rs`
- `src/pane/agent_detection.rs`
- `src/pane/osc.rs`
- `src/terminal/state.rs`
- `src/platform/macos.rs`
- `src/platform/linux.rs`
- `src/platform/windows.rs`
