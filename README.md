# tmex

Web 接入多设备 tmux 的终端控制平台。

通过浏览器管理本地或 SSH 远程设备的 tmux 会话，像 VS Code 终端一样管理窗口和分屏，特别优化了移动端 CKJ（中日韩）输入体验。

## 特性

- 🖥️ **多设备管理** - 支持本地和 SSH 远程设备
- 🔄 **实时同步** - WebSocket 实时推送终端输出和状态变化
- 📱 **移动端优化** - 组合态输入保护 + 编辑器模式，解决手机输入痛点
- 🔔 **事件通知** - Webhook + Telegram Bot 推送终端事件
- ⚙️ **设置中心** - 站点名、站点 URL、Bell 频控、SSH 自动重连、Telegram 多 Bot 授权审批
- 🔐 **安全加密** - AES-256-GCM 加密敏感数据
- 🐳 **易于部署** - Docker Compose 一键启动

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 克隆仓库
git clone <repository-url>
cd tmex

# 一键启动
chmod +x scripts/quick-start.sh
./scripts/quick-start.sh
```

访问 http://localhost:3000。

### 方式二：手动启动

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，设置 TMEX_MASTER_KEY

# 3. 启动 Gateway
cd apps/gateway && bun dev

# 4. 启动 Frontend（新终端）
cd apps/fe && bun dev --host

# 访问 http://localhost:3000
# 远程访问：http://<服务器IP>:3000
```

## 使用指南

### 鉴权说明

- 默认面向受控内网环境部署，应用内不启用登录鉴权。
- 建议通过反向代理、内网 ACL 或 VPN 进行访问边界控制。

### 添加设备

1. 点击「管理设备」→「添加设备」
2. 选择设备类型：
   - **本地设备**: 直接使用宿主机的 tmux
   - **SSH 设备**: 通过 SSH 连接远程服务器
3. 配置认证方式：
   - **密码**: 直接输入 SSH 密码
   - **私钥**: 粘贴私钥内容（支持加密私钥）
   - **SSH Agent**: 使用本地 ssh-agent（推荐）
   - **SSH Config**: 引用 `~/.ssh/config` 中的配置

### 连接终端

1. 在侧边栏点击设备名称展开
2. 点击「连接」按钮
3. 在终端区域输入命令

### 移动端输入

- **直接输入模式**（默认）: 自动保护输入组合态，避免拼音候选被拆开发送
- **编辑器模式**: 点击输入框进入，适合长文本输入，支持整段发送或逐行发送

### 系统设置

1. 侧边栏点击「设置」进入设置页。
2. 可配置站点名称、站点访问 URL、Bell 频控与 SSH 自动重连参数。
3. 可管理多个 Telegram Bot，审批待授权 chat、测试消息、撤销授权。
4. 配置调整后可在设置页触发「重启 Gateway」。

## 文档

- [部署指南](docs/2026021000-tmex-bootstrap/deployment.md) - 详细部署说明
- [架构文档](docs/2026021000-tmex-bootstrap/architecture.md) - 技术架构说明

## 开发

```bash
# 安装依赖
bun install

# 代码检查
bun run lint

# 格式化
bun run format

# 健康检查
chmod +x scripts/health-check.sh
./scripts/health-check.sh
```

## 项目结构

```
tmex/
├── apps/
│   ├── gateway/     # Bun.js 网关服务
│   └── fe/          # React 前端
├── packages/
│   └── shared/      # 共享类型定义
├── scripts/         # 实用脚本
├── docs/            # 文档
└── docker-compose.yml
```

## 技术栈

- **Backend**: Bun.js, SQLite, ssh2, Web Crypto API
- **Frontend**: React 19, TypeScript, Vite, xterm.js, Tailwind CSS
- **Protocol**: tmux -CC (Control Mode), WebSocket

## 安全

- 敏感数据（密码、私钥）使用 AES-256-GCM 加密存储
- 生产环境强制要求配置 `TMEX_MASTER_KEY`
- Webhook 使用 HMAC-SHA256 签名验证
- 建议结合内网访问策略或反向代理安全能力

## License

MIT
