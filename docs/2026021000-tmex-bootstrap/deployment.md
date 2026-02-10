# tmex 部署指南

## 环境要求

- **Docker**: 20.10+（推荐 Docker Compose 方式部署）
- **Bun**: 1.0+（开发环境）
- **Node.js**: 18+（仅前端开发需要）
- **tmux**: 3.0+（如果使用本地设备）

## 快速开始（Docker Compose）

### 1. 克隆仓库

```bash
git clone <repository-url>
cd tmex
```

### 2. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 编辑 .env 文件，设置以下必需项
vim .env
```

必需配置项：

```bash
# 主密钥（用于加密敏感数据，生产环境必须设置）
# 生成方式：head -c 32 /dev/urandom | base64
TMEX_MASTER_KEY=YOUR_BASE64_ENCODED_32BYTE_KEY

# 管理员密码
TMEX_ADMIN_PASSWORD=your-secure-password

# JWT 密钥
JWT_SECRET=your-jwt-secret-min-32-characters-long
```

可选配置项：

```bash
# 服务端口（默认 3000）
TMEX_PORT=3000

# Telegram Bot Token（可选，用于推送通知）
TELEGRAM_BOT_TOKEN=your-bot-token

# 基础 URL（用于生成 Webhook 回调地址）
TMEX_BASE_URL=https://tmex.your-domain.com
```

### 3. 启动服务

```bash
# 构建并启动
docker-compose up --build -d

# 查看日志
docker-compose logs -f

# 等待服务就绪（约 10 秒）
sleep 10
```

### 4. 验证部署

```bash
# 健康检查
curl http://localhost:3000/healthz

# 预期输出：{"status":"ok"}
```

访问 `http://localhost:3000`，使用 `.env` 中设置的密码登录。

## 开发环境部署

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

### 2. 安装依赖

```bash
cd tmex
bun install
```

### 3. 配置环境变量

```bash
export TMEX_MASTER_KEY=$(head -c 32 /dev/urandom | base64)
export TMEX_ADMIN_PASSWORD=dev-password
export JWT_SECRET=dev-jwt-secret
export NODE_ENV=development
export GATEWAY_PORT=8080
export DATABASE_URL=/tmp/tmex.db
```

### 4. 启动 Gateway

```bash
cd apps/gateway
bun dev

# 服务运行在 http://0.0.0.0:8080
```

### 5. 启动 Frontend（新终端）

```bash
cd apps/fe
bun dev --host

# 服务运行在 http://0.0.0.0:3000
# 本地访问: http://localhost:3000
# 远程访问: http://<服务器IP>:3000
```

### 远程访问说明

如果需要在其他机器访问：

1. **确保服务绑定所有接口**（已默认配置）
2. **开放防火墙端口**：
   ```bash
   # Ubuntu/Debian
   sudo ufw allow 3000/tcp
   sudo ufw allow 8080/tcp  # 如需直接访问 Gateway
   
   # CentOS/RHEL
   sudo firewall-cmd --permanent --add-port=3000/tcp
   sudo firewall-cmd --reload
   ```
3. **云服务器安全组**：在控制台添加 3000 端口入站规则

## 生产环境部署

### 使用 Docker Compose（推荐）

#### 1. 准备服务器

- 确保 Docker 和 Docker Compose 已安装
- 开放所需端口（默认 3000）

#### 2. 配置生产环境变量

```bash
# 生成强密钥
export TMEX_MASTER_KEY=$(openssl rand -base64 32)
export JWT_SECRET=$(openssl rand -base64 32)

# 创建 .env 文件
cat > .env << EOF
NODE_ENV=production
TMEX_MASTER_KEY=$TMEX_MASTER_KEY
TMEX_ADMIN_PASSWORD=your-strong-admin-password
TMEX_BASE_URL=https://tmex.your-domain.com
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=24h
TMEX_PORT=3000
EOF
```

#### 3. 使用 HTTPS（推荐）

方式一：使用反向代理（nginx/traefik）

```yaml
# docker-compose.override.yml
version: '3.8'
services:
  fe:
    expose:
      - "80"
    networks:
      - tmex-network
      - traefik-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.tmex.rule=Host(\`tmex.your-domain.com\`)"
      - "traefik.http.routers.tmex.tls.certresolver=letsencrypt"

networks:
  traefik-network:
    external: true
```

方式二：使用 Cloudflare Tunnel

```bash
# 安装 cloudflared
docker run --rm -v /tmp/cloudflared:/home/nonroot/.cloudflared \
  cloudflare/cloudflared:latest tunnel login

# 创建隧道
docker run --rm -v /tmp/cloudflared:/home/nonroot/.cloudflared \
  cloudflare/cloudflared:latest tunnel create tmex

# 运行隧道
docker run -d --name cloudflared \
  --network tmex-network \
  -v /tmp/cloudflared:/home/nonroot/.cloudflared \
  cloudflare/cloudflared:latest tunnel run tmex
```

#### 4. 启动服务

```bash
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

### 手动部署（无 Docker）

#### 1. 安装依赖

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y tmux curl

# 安装 Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

#### 2. 构建项目

```bash
cd tmex
bun install

# 构建 Gateway
cd apps/gateway
bun run build

# 构建 Frontend
cd ../fe
bun run build
```

#### 3. 配置 systemd 服务

Gateway 服务：

```bash
sudo tee /etc/systemd/system/tmex-gateway.service << 'EOF'
[Unit]
Description=tmex Gateway
After=network.target

[Service]
Type=simple
User=tmex
WorkingDirectory=/opt/tmex/apps/gateway
Environment=NODE_ENV=production
Environment=TMEX_MASTER_KEY=your-master-key
Environment=TMEX_ADMIN_PASSWORD=your-password
Environment=JWT_SECRET=your-jwt-secret
Environment=GATEWAY_PORT=8080
Environment=DATABASE_URL=/var/lib/tmex/tmex.db
ExecStart=/root/.bun/bin/bun dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Frontend 服务（使用 nginx）：

```bash
sudo tee /etc/nginx/sites-available/tmex << 'EOF'
server {
    listen 80;
    server_name tmex.your-domain.com;
    
    root /opt/tmex/apps/fe/dist;
    index index.html;

    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/tmex /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

启动服务：

```bash
sudo systemctl enable tmex-gateway
sudo systemctl start tmex-gateway
```

## SSH 设备配置

### 密码认证

1. 在设备管理页面点击「添加设备」
2. 选择类型：SSH 远程设备
3. 填写主机、端口、用户名
4. 认证方式选择：密码
5. 输入密码并保存

### 私钥认证

1. 生成 SSH 密钥对（如无）：
   ```bash
   ssh-keygen -t ed25519 -C "tmex"
   ```

2. 将公钥添加到远程服务器：
   ```bash
   ssh-copy-id -i ~/.ssh/id_ed25519.pub user@remote-host
   ```

3. 在 tmex 中添加设备：
   - 认证方式选择：私钥
   - 复制私钥内容（`~/.ssh/id_ed25519`）粘贴到私钥字段

### SSH Agent（推荐）

适用于开发环境或密钥有密码的情况。

**Docker Compose 方式**：

```yaml
# docker-compose.yml
services:
  gateway:
    volumes:
      - ${SSH_AUTH_SOCK}:/tmp/ssh-agent.sock
    environment:
      - SSH_AUTH_SOCK=/tmp/ssh-agent.sock
```

**本地运行方式**：

```bash
# 确保 ssh-agent 已启动并添加了密钥
ssh-add -l

# 启动 gateway（自动读取 SSH_AUTH_SOCK）
bun dev
```

### SSH Config 引用

1. 确保 `~/.ssh/config` 已配置：
   ```
   Host myserver
       HostName 192.168.1.100
       User admin
       IdentityFile ~/.ssh/id_ed25519
   ```

2. Docker 方式需要挂载 SSH 目录：
   ```yaml
   volumes:
     - ~/.ssh:/home/bunuser/.ssh:ro
   ```

3. 在 tmex 中添加设备：
   - 认证方式选择：SSH Config
   - SSH Config 引用填写：myserver

## 备份与恢复

### 备份数据库

```bash
# Docker 方式
docker exec tmex-gateway sqlite3 /data/tmex.db ".backup /data/tmex-backup.db"
docker cp tmex-gateway:/data/tmex-backup.db ./tmex-backup-$(date +%Y%m%d).db

# 本地方式
sqlite3 /var/lib/tmex/tmex.db ".backup tmex-backup.db"
```

### 恢复数据库

```bash
# 停止服务
docker-compose stop

# 恢复数据
docker cp ./tmex-backup.db tmex-gateway:/data/tmex.db

# 重启服务
docker-compose start
```

## 监控与日志

### 查看日志

```bash
# Docker Compose
docker-compose logs -f gateway
docker-compose logs -f fe

# 本地运行
journalctl -u tmex-gateway -f
```

### 健康检查

```bash
# Gateway 健康检查
curl http://localhost:8080/healthz

# 完整功能检查
./scripts/health-check.sh
```

## 更新升级

### Docker Compose 方式

```bash
# 拉取最新代码
git pull origin main

# 重新构建并启动
docker-compose down
docker-compose up --build -d

# 验证
sleep 5
curl http://localhost:3000/healthz
```

### 本地方式

```bash
# 拉取最新代码
git pull origin main

# 更新依赖
bun install

# 重新构建
cd apps/gateway && bun run build
cd ../fe && bun run build

# 重启服务
sudo systemctl restart tmex-gateway
sudo systemctl restart nginx
```

## 故障排查

### 服务无法启动

```bash
# 检查日志
docker-compose logs gateway

# 检查环境变量
docker-compose exec gateway env | grep TMEX

# 检查数据库权限
docker-compose exec gateway ls -la /data/
```

### WebSocket 连接失败

1. 检查防火墙是否放行端口
2. 检查 nginx 配置中的 WebSocket 代理设置
3. 检查 JWT 是否过期（重新登录）

### SSH 连接失败

```bash
# 测试 SSH 连通性
docker-compose exec gateway ssh -v user@host

# 检查密钥权限
docker-compose exec gateway ls -la ~/.ssh/
```

### tmux 不可用

```bash
# 进入容器检查
docker-compose exec gateway which tmux
docker-compose exec gateway tmux -V
```

## 安全建议

1. **强密码**: 使用至少 16 位的随机密码作为管理员密码
2. **密钥管理**: 生产环境必须使用 TMEX_MASTER_KEY 加密敏感数据
3. **HTTPS**: 生产环境强制使用 HTTPS
4. **防火墙**: 仅开放必要的端口（80/443）
5. **定期备份**: 设置定时任务备份数据库
6. **更新**: 定期更新依赖和基础镜像

## 参考

- [tmux 文档](https://github.com/tmux/tmux/wiki)
- [Bun 文档](https://bun.sh/docs)
- [Docker Compose 文档](https://docs.docker.com/compose/)
