# tmex：Web 接入多设备 tmux -CC 的终端控制平台（Gateway + FE）落地计划

## 0. 背景与注意事项（给“无上下文重新开启任务”的人看的）

- 仓库现状：当前 tmex/ 目录仅有 AGENTS.md，属于从零搭建（2026-02-10）。
- 目标：通过网页接入多个设备（本地或 SSH）的 tmux -CC，在浏览器里像 VS Code 终端一样管理设备/窗口/分屏，并重点优化移动端（手机/平板）Code Agent 场景下 CKJ（中日韩）输入体验。
- 关键约束：
  - 必须严格使用 tmux -CC（按你的要求），并“忽略 Windows Position 等 iTerm2 相关窗口定位信息”，避免影响同一 tmux server 上 iTerm2 连接的行为。
  - Gateway：Bun.js；FE：React + Tailwind + Base UI；SQLite 做 CRUD；Webhook + Telegram Bot 推送；最终 Docker + docker-compose 自部署。
  - 按 AGENTS.md：先存档，再干活（在执行阶段的第一步完成存档；本回复处于 Plan Mode，只产出可执行计划，不改仓库文件）。

## 1. 已锁定的产品/技术决策（来自你的选择）

- 传输协议：前端与 Gateway 采用 WebSocket 作为主实时通道。
- 设备范围：首版支持 本地 + SSH 并行。
- 认证：首版 单用户（本地管理员）密码登录。
- Webhook 安全：采用 HMAC 签名头。
- Telegram：支持 多订阅（chat_id 列表）。
- 移动端输入：实现“输入缓冲 + 组合态保护”，并额外提供“编辑器模式”兜底。

## 2. Skills 管理（执行阶段会做）

你希望安装：

- playwright：用于 FE 的关键交互/E2E（尤其移动端输入与树状侧栏交互）。
- security-threat-model：用于把 SSH 凭据、Webhook、Telegram 等链路做威胁建模并落地必要防护。

执行阶段第 2 步会用 skill-installer 安装这两个 skill；安装后需 重启 Codex 才会生效（按 skill-installer 规则）。

## 3. 项目总体结构（单仓库 monorepo）

采用 Bun workspaces（统一包管理、脚本）：

- apps/gateway/：Bun + TypeScript 的网关服务
- apps/fe/：Vite + React + TS + Tailwind + Base UI + xterm.js 的 SPA
- packages/shared/：前后端共享的 TypeScript 类型（WS 消息、事件 schema、DTO）
- docs/：技术文档（按模块建子目录）
- prompt-archives/：Plan/Prompt/Result 存档（按 AGENTS.md 规则）

> 备注：Base UI 具体 npm 包名在执行阶段必须先查官方文档/仓库确认（按 AGENTS.md“禁止猜测”原则），再落到 apps/fe/ 依赖中。

## 4. Gateway 设计（Bun + SQLite + tmux -CC + WebSocket）

### 4.1 进程与连接模型

- “设备（Device）”抽象：
  - local：在 Gateway 容器/宿主机本地启动 tmux
  - ssh：通过 SSH 连接远端并启动 tmux
- “连接（DeviceConnection）”抽象：每个 deviceId 对应一个长期存在的连接管理器，负责：
  - 运行/保持 tmux -CC 会话
  - 解析 tmux 控制模式事件（窗口/分屏增删、bell 等）
  - 将事件广播给多个浏览器客户端
  - 为“当前被某个客户端激活的 pane”转发终端字节流

### 4.2 SSH 认证策略（按你要求：多方式并存）

Gateway 对 SSH 设备提供以下配置项（UI + API）：

- 基础：host、port、username
- 认证方式（可选其一或多兜底）：
  1. password（存 SQLite，需加密）
  2. sshKey（私钥内容：存 SQLite，需加密；可带 passphrase）
  3. sshAgent（走本地 ssh-agent：通过挂载 SSH_AUTH_SOCK 或等效方式；容器部署需在 compose 中显式配置）
  4. sshConfigRef（直接引用 ~/.ssh/config 的 host alias；compose 中挂载 ~/.ssh 只读）
- 实现建议（决策已定，执行时照此实现）：
  - SSH 通道使用 ssh2（支持 password/privateKey/agent/pty），避免依赖 sshpass。
  - tmux -CC 通过 SSH shell({ pty: ... }) 启动，确保控制模式能产生事件与交互输出。

### 4.3 tmux -CC 协议处理（关键风险点，需结构化实现）

目标：在浏览器中“像 VS Code 终端一样”展示树状结构并可切换 pane，同时不影响 iTerm2。

实现策略（决策已定）：

- 建立 字节流解析器（state machine）把 tmux -CC 输出拆成两类：
  1. 控制事件（window/pane/session 变化、bell、exit、layout 变化等）
  2. 终端输出字节（发给 xterm.js 渲染）
- iTerm2 相关“窗口位置/定位”信息处理：
  - 识别并丢弃 iTerm2 专用序列（例如可能出现的 OSC 1337 系列或 tmux -CC 扩展字段）中的 Window Position 类指令；
  - 绝不根据这些信息在 tmex 内做窗口移动/重排/定位；
  - UI 的排序与树状结构仅依据 tmux 的 window_id / pane_id 与 index（如果有）构建。
- 关闭与异常：
  - tmux 退出/窗口关闭/ pane 关闭：更新内存状态并持久化必要快照；触发 webhook/telegram。
  - tmux 未安装：在 “preflight” 阶段就能探测并标记设备状态，同时触发 webhook/telegram（可配置是否推送）。

> 验证要求：执行阶段必须在本地用真实 tmux 生成最小可复现日志/fixture，用单元测试锁住解析器行为；否则不要进入 UI 联调。

### 4.4 SQLite（CRUD 数据库）与加密

SQLite 文件通过 Docker volume 持久化（例如 /data/tmex.db）。

表设计（建议拆表，便于扩展）：

- devices
  - id（uuid）、name、type（local/ssh）
  - ssh 相关：host、port、username、sshConfigRef
  - 认证：authMode（password/key/agent/configRef/auto）
  - 密文：passwordEnc、privateKeyEnc、privateKeyPassphraseEnc（可为空）
  - createdAt、updatedAt
- device_runtime_status
  - deviceId、lastSeenAt、tmuxAvailable、lastError
- webhook_endpoints
  - id、enabled、url、secret（用于 HMAC）、eventMask（订阅哪些事件）
- telegram_subscriptions
  - id、enabled、botTokenEnc（或全局配置）、chatId、eventMask

加密方案（决策已定）：

- 使用 TMEX_MASTER_KEY（32 bytes base64）作为主密钥。
- 采用 AES-256-GCM（或 libsodium secretbox，二选一但必须固定一种）对敏感字段加密后入库。
- 所有加解密集中在 apps/gateway/src/crypto/，禁止散落在业务逻辑里。

### 4.5 Gateway API（REST + WebSocket）

#### REST（示例，执行时按此落地）

- POST /api/auth/login、POST /api/auth/logout、GET /api/auth/me
- GET/POST /api/devices、GET/PATCH/DELETE /api/devices/:id
- POST /api/devices/:id/test-connection（含 tmux preflight）
- GET/POST /api/webhooks、PATCH/DELETE /api/webhooks/:id
- GET/POST /api/telegram/subscriptions、PATCH/DELETE /api/telegram/subscriptions/:id
- POST /api/notify/test（测试 webhook/telegram 推送）

认证与会话（决策已定）：

- 使用 HTTP-only cookie（签名 JWT 或 session-id + SQLite session 表二选一；建议 JWT+短 TTL + 刷新接口）。
- WebSocket 握手必须校验 cookie/session。

#### WebSocket（统一消息 envelope）

- 路径：GET /ws
- 客户端 -> 服务端消息（JSON）：
  - auth/hello（可选，服务端也可仅靠 cookie）
  - device/connect：请求连接某设备（触发 preflight + 启动 tmux -CC）
  - device/disconnect
  - tmux/select：选择 windowId/paneId
  - term/input：用户输入（按字节或字符串；含 isComposing 标志位）
  - term/resize：cols/rows
  - term/paste
- 服务端 -> 客户端消息（JSON + 二进制输出）：
  - state/snapshot：设备树、窗口树、pane 树的完整快照
  - event/tmux：增量事件（window-add/pane-close/bell/layout-change 等）
  - event/device：tmux missing、连接断开、错误等
  - term/output：建议用 binary frame 直接推终端字节（避免 base64 开销）

Webhook 事件 schema（会影响外部集成，必须稳定）：

- eventType：terminal_bell | tmux_window_close | tmux_pane_close | device_tmux_missing | device_disconnect | ...
- timestamp（ISO8601）
- device：id、name、type、host?
- tmux：sessionName?、windowId?、paneId?
- payload：扩展字段（例如 bell 次数、退出码、错误摘要）

HMAC 签名：

- 请求头：X-Tmex-Signature: sha256=<hex>
- signature = HMAC_SHA256(secret, rawBodyBytes)

Telegram 推送：

- 文本模板：一行摘要 + 关键字段（device/window/pane/eventType/time）
- 支持 chat_id 列表（来自 telegram_subscriptions），按订阅过滤 eventMask。

## 5. FE（React + Tailwind + Base UI + xterm.js）设计

### 5.1 交互框架与状态管理

- SPA：React Router（你选的“按设备/会话路径路由”）
- 数据层：TanStack Query（REST）+ 自研 useTmexWs()（WS）
- 全局状态：Zustand（保存“当前选中 device/window/pane”、sidebar 折叠状态、移动端模式开关等）
- 终端渲染：xterm.js + fit addon（窗口尺寸变化适配）

### 5.2 路由设计（可刷新恢复定位）

- /login
- /devices（设备列表/新增入口）
- /devices/:deviceId（默认选择最近一次的 window/pane）
- /devices/:deviceId/windows/:windowId/panes/:paneId（深链接直达）

### 5.3 左侧可收起边栏（树状列表，VS Code 终端风格）

- 一级：设备（在线/离线、错误徽标、bell 徽标）
- 二级：tmux windows
- 三级：tmux panes（分屏）
- 交互细节（决策已定，执行时照做）：
  - 单击：激活节点（切换到对应 pane）
  - 双击：重命名（设备名/window 名称，若 tmux 支持）
  - 右键/长按：上下文菜单（新建 window、关闭 pane、断开设备等）
  - 键盘导航：上下键移动、左右键折叠展开、Enter 激活
  - 移动端：sidebar 默认抽屉式 overlay；激活 pane 后自动收起

### 5.4 移动端 CKJ 输入优化（重点）

提供两种输入模式，用户可切换（默认终端直输）：

1. 终端直输模式（默认）：输入缓冲 + 组合态保护

- 监听 compositionstart/compositionupdate/compositionend
- 组合态期间：
  - 不把中间态发往 gateway（避免拼音候选被拆发）
  - 仅在 compositionend 后把最终文本一次性发送（或按策略拆分）
- 对软键盘 Enter/Done 做兼容映射（发送 \r 或触发提交）
- 提供“粘贴”优化：长按 -> 粘贴，按 chunk 发送并做节流

2. 编辑器模式（兜底）：底部弹出编辑框（Base UI Dialog/Sheet）

- 用户在文本框中稳定编辑（CKJ 体验最好）
- 支持：
  - “发送”按钮：整段发送
  - “逐行发送”：按换行拆分逐行发送（用于 shell/agent）
  - 历史记录（最近 N 条输入，存在 localStorage）
- 适用场景：某些移动浏览器对 xterm 的输入焦点/IME 支持较差时切换

### 5.5 错误态与引导

- 设备 tmux 未安装：在主视图显示引导卡片（建议安装命令、重试按钮）
- SSH 认证失败：显示明确原因（超时/拒绝/密钥错误），并给“编辑设备配置”入口
- WebSocket 断线：自动重连（指数退避），并展示状态条

## 6. Docker / docker-compose 部署

### 6.1 容器与网络

- gateway：
  - 基于 oven/bun（或等效镜像）
  - 挂载：
    - SQLite：tmex-data:/data
    - 可选：~/.ssh:/home/bun/.ssh:ro
    - 可选：ssh-agent：SSH_AUTH_SOCK（按宿主机情况配置）
- fe：
  - 多阶段构建：Vite build -> nginx:alpine 静态托管
  - 反代 /api 与 /ws 到 gateway（nginx 配置）
- docker-compose.yml：
  - 环境变量：TMEX_MASTER_KEY、TMEX_ADMIN_PASSWORD_HASH（或明文初次启动自动 hash）、TMEX_BASE_URL、Telegram/Webhook 默认配置等
  - healthcheck：gateway /healthz

### 6.2 配置与密钥管理

- 强制要求 TMEX_MASTER_KEY（否则拒绝启动或仅允许开发模式）
- 提供 .env.example（执行阶段创建）

## 7. 测试与验收标准

### 7.1 Gateway（Bun test）

- tmux -CC 解析器：
  - 能稳定识别 window/pane 增删、layout change、bell、close
  - 能过滤/忽略 Window Position 等 iTerm2 定位信息（不会传给前端，也不会影响状态）
- SSH 连接：
  - password/key/agent/configRef 至少覆盖 2 种方式的集成测试（本地可通过 mock server 或条件跳过）
- Webhook：
  - HMAC 签名正确；重试/超时策略生效
- Telegram：
  - 多 chat_id 推送与 eventMask 过滤正确（可用 dry-run 模式测试）

### 7.2 FE（Playwright）

- 侧栏树：
  - 折叠/展开、激活 pane、右键菜单（桌面）/长按菜单（移动）可用
- 路由：
  - 刷新后能恢复到 /devices/:deviceId/windows/:windowId/panes/:paneId
- 移动端输入：
  - 组合输入（拼音）不会出现“中间态乱入终端”
  - 编辑器模式可整段发送且不会破坏焦点

### 7.3 验收标准（首版）

- 可添加/编辑/删除设备（本地 + SSH）
- 设备 tmux 未安装：前端明确提示 + 事件可推 webhook/telegram
- 浏览器中可查看设备->window->pane 树，并切换 pane 操作终端
- terminal bell、window/pane close：均触发 webhook + telegram（按配置）
- docker-compose 一键启动，数据持久化

## 8. 执行步骤（严格按 AGENTS：先存档，再干活）

> 下面是“实现阶段”要做的顺序；实现开始前必须照做，不得跳步。

1. Prompt/Plan 存档（必须先做）

- 创建：prompt-archives/2026021000-tmex-bootstrap/
- 写入：
  - prompt-archives/2026021000-tmex-bootstrap/plan-prompt.md：存本次对话 prompt（含后续新增 prompt）
  - prompt-archives/2026021000-tmex-bootstrap/plan-00.md：存本计划全文

2. 安装 skills（playwright + security-threat-model）

- 使用 skill-installer 安装两项 skill
- 安装后重启 Codex

3. 仓库脚手架初始化（monorepo）

- 初始化 bun workspaces、TypeScript 配置、统一 lint/format（建议 Biome）
- 建立 apps/gateway、apps/fe、packages/shared、docs 目录结构

4. Gateway：SQLite schema + 加密层 + 认证

- 先落数据库与加密、再做设备 CRUD
- 完成 REST API 与 cookie/session

5. Gateway：tmux -CC 连接与解析器（先本地后 SSH）

- 本地 tmux：启动、attach、解析事件、输出转发
- 过滤 Window Position 等 iTerm2 定位信息
- SSH tmux：基于 ssh2 + pty 启动 tmux -CC
- 完成 WS 协议与多客户端广播

6. 事件系统：Webhook + Telegram

- 事件统一建模（shared package）
- Webhook HMAC、重试策略、超时
- Telegram 多订阅 + eventMask

7. FE：路由、布局、侧栏树、终端

- xterm.js 终端与 WS 对接
- 侧栏树 VS Code 风格交互
- 移动端适配与输入优化（组合态保护 + 编辑器模式）

8. Docker 化与 compose

- gateway/fe Dockerfile 多阶段构建
- nginx 反代 /api、/ws
- compose：volume、env、healthcheck

9. 文档与结果归档

- docs/<module>/2026021000-tmex-bootstrap.md：架构与部署说明（中文）
- prompt-archives/2026021000-tmex-bootstrap/plan-00-result.md：执行总结、已知风险、后续建议

## 9. 明确假设（避免实现时再做决定）

- Base UI、xterm.js、ssh2、SQLite ORM/迁移工具在执行阶段会先查官方文档确认 API 后再落地依赖与封装（不猜）。
- SSH 私钥/密码等敏感数据一律加密后入库；若未提供 TMEX_MASTER_KEY，生产模式拒绝启动。
- tmex 的 UI 排序不依据 iTerm2 Window Position；仅依据 tmux window/pane 标识与 index。
