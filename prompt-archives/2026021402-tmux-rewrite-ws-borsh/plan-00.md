# Plan-00：Tmux 控制层重写（WS 全二进制 Borsh 协议 + 状态机 + 文档）

## 摘要

本计划对 tmux 控制链路做“重写级”改造，目标是把 window/pane 同步、切换、resize、历史合并、复杂控制字符（含 Vim 鼠标）、bell 与终端事件处理做成可验证、可回归的系统。

关键决策：

- tmux 侧继续使用 `tmux -CC`（Control Mode）。
- 同一 `deviceId` 下网页端默认“始终自动跟随” tmux 外部 active window/pane。
- WebSocket 协议升级为**全二进制**，使用 `@zorsh/zorsh`（Borsh）实现，定义稳定 schema。
- 在 `@tmex/shared` 提供统一的 borsh schema、codec 与 wire/domain 转换层，业务层不直接处理二进制细节。

## 交付物

- 协议规范：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`
- 状态机设计：`docs/ws-protocol/2026021403-ws-state-machines.md`
- 切换屏障设计：`docs/terminal/2026021404-terminal-switch-barrier-design.md`
- Shared 协议实现：`packages/shared/src/ws-borsh/`
- Gateway 新协议接入（完全重写，弃用旧代码）：`apps/gateway/src/ws/`（新增 borsh codec + session state）
- FE 新协议接入：`apps/fe/src/ws-borsh/`（新增 borsh client + 状态机）

## 目标与验收标准（对齐 6 点）

1. window/pane 状态同步与切换正常：

- 外部切换（iTerm2/其他 tmux 客户端/快捷键）会自动跟随到对应 window/pane。
- 网页内手动切换稳定，输出与订阅不丢失。

1. pty 尺寸变化正确：

- 初始化、切换、resize 以“浏览器终端视口”为源，Gateway 同步 tmux client/pty，SSH 与本地一致。

1. 复杂控制字符与鼠标：

- Vim/Neovim 的鼠标序列（SGR/VT200 等）在链路上不被破坏，能正常工作。

1. 历史与实时输出合并：

- 切换后严格按屏障顺序：`SWITCH_ACK -> (HISTORY) -> LIVE_RESUME`。
- history 必先于 live 显示，期间 live 缓冲，保证顺序确定。

1. bell：

- 不重复、频控一致（Gateway 统一）、上下文尽量准确。

1. 终端特殊字符与事件：

- title/OSC 等不被误处理；关键路径可回归测试覆盖。

## WS 协议（tmex-ws-borsh-v1）设计摘要

完整协议见：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`。

要点：

- 所有 WS 二进制消息是一个 borsh `Envelope`：`magic(2)+version+kind+flags+seq+payload(bytes)`。
- `kind` 使用显式 `u16` 编号表，不依赖 `b.enum` 的变体顺序。
- 大消息通过 `CHUNK` 统一分片。
- `TMUX_SELECT` 携带 `selectToken(16 bytes)` 与可选 `cols/rows`，作为切换事务标识。
- Gateway 对每个客户端做 token 层的输出屏障与缓冲，确保 history/live 合并顺序确定。

## 状态机设计摘要

完整状态机见：`docs/ws-protocol/2026021403-ws-state-machines.md`。

必须实现的状态机：

- 连接状态机：WS open -> HELLO 协商 -> READY -> 断线 backoff。
- 设备状态机：DETACHED/CONNECTING/CONNECTED/FAILED。
- 选择事务状态机（每 deviceId）：SELECTING/ACKED/HISTORY_APPLIED/LIVE。
- 输出门控状态机：LIVE_RESUME 前 BUFFERING，之后 FLOWING。
- resize 状态机：debounce + 去重，避免 resize 风暴。
- bell 状态机：Gateway 侧统一频控与去重。

## 模块拆分（实现约束）

### Shared（协议与转换）

新增：`packages/shared/src/ws-borsh/`

- `kind.ts`：kind 常量与编号
- `schema.ts`：zorsh schemas（Envelope + payloads + 子结构）
- `codec.ts`：`encodeEnvelope/decodeEnvelope/decodePayload`
- `chunk.ts`：分片重组
- `convert.ts`：wire <-> domain 转换
- `errors.ts`：错误码

`packages/shared/src/index.ts` 增加协议模块导出。

### Gateway

- `apps/gateway/src/ws/index.ts`：完全重写，弃用旧代码
- `apps/gateway/src/ws/codec-borsh.ts`：borsh 编解码与发送工具
- `apps/gateway/src/ws/session-state.ts`：连接/设备/select 状态机存储
- `apps/gateway/src/ws/switch-barrier.ts`：SELECT 屏障实现（ACK/HISTORY/RESUME + 缓冲）

tmux 控制层：

- 按需重写 parser/dispatcher，减少 FIFO 假设，确保命令回复绑定稳定。
- bell 来源统一（%bell + 0x07 去重），频控在 Gateway。

### FE

- `apps/fe/src/ws-borsh/client.ts`：WS borsh 客户端（HELLO、seq、chunk 重组）
- `apps/fe/src/ws-borsh/state-machine.ts`：selectToken 驱动的 history/live 合并状态机
- `apps/fe/src/stores/tmux.ts`：改为消费语义消息，不直接处理二进制 framing
- `apps/fe/src/components/terminal/Terminal.tsx`：
  - 以 token 状态机应用 history/live
  - 使用 ResizeObserver + FitAddon 上报 cols/rows（debounce）

## 实施步骤（严格顺序，可回滚）

### Phase 0：归档（已完成）

- plan 与文档先入库，确保后续实现遵循“先存档再干活”。

### Phase 1：落地 shared 协议实现（不动业务）

- 在 `@tmex/shared` 增加 `ws-borsh` 模块与单测。
- 只保证 codec 正确、分片正确、wire/domain 转换正确。

### Phase 2：Gateway 双栈接入（最小 kind 集）

- Gateway 支持 `HELLO/ERROR/PING/PONG`、`DEVICE_CONNECT`、`STATE_SNAPSHOT`、`TERM_OUTPUT`（新协议）。

### Phase 3：FE 新协议接入（功能等价）

- 新增 borsh client，能连上、展示 snapshot、输出正常。

### Phase 4：切换屏障上线（关键）

- 上线 `TMUX_SELECT + SWITCH_ACK + TERM_HISTORY + LIVE_RESUME`。
- Gateway per-client 缓冲，FE 按 token 合并，移除旧 ref 拼接竞态。

### Phase 5：resize、bell、事件统一

- resize 完整链路统一。
- bell 去重与频控统一在 Gateway。
- TMUX_EVENT 子 schema 完整化。

## 测试计划

- Shared：codec roundtrip、未知 kind、防御性校验、chunk 重组。
- Gateway：select 屏障顺序、bell 去重/频控、snapshot 编解码。
- FE（Playwright）：跟随 pane-active、切换不乱序、resize 不风暴。

## 风险与对策

- 大帧（history/output/snapshot）：`maxFrameBytes` + `CHUNK`。
- 迁移期复杂：magic 分流 + feature flag。
- SSH resize API 不确定：实现时必须以 ssh2 类型/源码验证可用方法，禁止猜测。
