# tmex 架构与部署说明

## 项目概述

tmex 是一个通过网页接入多个设备（本地或 SSH）的 tmux -CC 终端控制平台。用户可以在浏览器中像 VS Code 终端一样管理设备、窗口和分屏，并特别优化了移动端 CKJ（中日韩）输入体验。

## 技术栈

### Gateway（后端）
- **运行时**: Bun.js
- **数据库**: SQLite（持久化存储）
- **SSH 连接**: ssh2 库
- **加密**: Web Crypto API (AES-256-GCM)
- **Bot 框架**: gramio（Telegram 多 Bot 管理）

### Frontend（前端）
- **框架**: React 19 + TypeScript
- **构建**: Vite
- **路由**: React Router v7
- **状态**: TanStack Query + Zustand
- **UI 组件**: Base UI + Tailwind CSS
- **终端**: xterm.js

## 项目结构

```
tmex/
├── apps/
│   ├── gateway/          # Bun.js 网关服务
│   │   ├── src/
│   │   │   ├── api/      # REST API 路由
│   │   │   ├── crypto/   # 加密/解密层
│   │   │   ├── db/       # SQLite 数据库
│   │   │   ├── events/   # Webhook + Telegram
│   │   │   ├── tmux/     # tmux -CC 连接与解析
│   │   │   ├── ws/       # WebSocket 服务器
│   │   │   ├── config.ts # 配置管理
│   │   │   └── index.ts  # 入口
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── fe/               # React 前端
│       ├── src/
│       │   ├── components/  # UI 组件
│       │   ├── hooks/       # 自定义 Hooks
│       │   ├── layouts/     # 布局组件
│       │   ├── pages/       # 页面组件
│       │   ├── stores/      # Zustand 状态
│       │   ├── main.tsx     # 入口
│       │   └── index.css    # 样式
│       ├── Dockerfile
│       ├── nginx.conf
│       └── package.json
│
├── packages/
│   └── shared/           # 前后端共享类型
│       └── src/
│           └── index.ts  # 类型定义
│
├── docs/                 # 技术文档
├── prompt-archives/      # Plan/Prompt 存档
├── docker-compose.yml
├── package.json          # Workspace 配置
└── biome.json            # 代码规范
```

## 核心功能

### 1. 设备管理
- 支持本地设备和 SSH 远程设备
- SSH 认证方式：密码、私钥、SSH Agent、SSH Config
- 设备状态监控（在线/离线、tmux 可用性）

### 2. tmux -CC 协议处理
- 状态机解析 tmux 控制模式输出
- 支持 window/pane 增删、layout 变化、bell 等事件
- **忽略 iTerm2 窗口位置信息**，避免影响其他客户端
- 终端输出通过 WebSocket 转发

#### WebSocket 协议（规划）

- legacy（当前）：JSON 控制消息 + 自定义二进制 output 帧（仅转发选中 pane 输出）
- 规划：`tmex-ws-borsh-v1`（全二进制，Borsh/@zorsh/zorsh）
  - 目标：统一控制/事件/snapshot/history/output 的编码与版本演进，并引入 `selectToken` 切换屏障保证顺序确定
  - 协议规范：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`
  - 状态机：`docs/ws-protocol/2026021403-ws-state-machines.md`
  - 切换屏障：`docs/terminal/2026021404-terminal-switch-barrier-design.md`

### 3. 移动端输入优化
- **直接输入模式**: compositionstart/end 保护，防止拼音候选被拆发
- **编辑器模式**: 底部弹出编辑框，整段或逐行发送
- 历史记录保存（localStorage）

### 4. 通知系统
- Webhook: HMAC-SHA256 签名，支持重试
- Telegram Bot: 多 Bot + chat 审批授权流（待授权/已授权）

### 5. 设置中心
- 站点名称、站点访问 URL
- Bell 频控参数
- SSH 自动重连参数
- Gateway 重启操作

## 部署

### 环境变量

复制 `.env.example` 为 `.env` 并修改：

```bash
# 必需
TMEX_MASTER_KEY=$(head -c 32 /dev/urandom | base64)

# 可选
TMEX_SITE_NAME=tmex
TMEX_BELL_THROTTLE_SECONDS=6
TMEX_SSH_RECONNECT_MAX_RETRIES=2
TMEX_SSH_RECONNECT_DELAY_SECONDS=10
TMEX_PORT=3000
```

### Docker Compose 部署

```bash
# 启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

### 开发环境

```bash
# 安装依赖
bun install

# 启动 Gateway
cd apps/gateway && bun dev

# 启动 Frontend（新终端）
cd apps/fe && bun dev
```

## 安全考虑

1. **加密**: 敏感数据（密码、私钥）使用 AES-256-GCM 加密存储
2. **访问控制**: 默认应用内无鉴权，建议通过反向代理/内网 ACL 控制访问
3. **Webhook**: HMAC-SHA256 签名验证
4. **生产环境**: 强制要求 TMEX_MASTER_KEY

## 已知限制

1. tmux -CC 解析器需要更多真实场景测试
2. 前端侧边栏树状结构目前为静态展示，需要接入 WebSocket 状态
3. SSH Agent 转发在容器环境需要额外配置
4. 缺少完善的错误处理和重连机制

## 后续建议

1. 添加单元测试（tmux 解析器、加密层）
2. 完善移动端触摸手势支持
3. 添加会话录制/回放功能
4. 支持更多通知渠道（Slack、Discord 等）
5. 多用户/权限系统
