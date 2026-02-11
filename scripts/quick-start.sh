#!/bin/bash
# tmex quick-start script (Bun)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════╗"
echo "║           tmex quick start             ║"
echo "║     Web Terminal Management            ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

cd "$PROJECT_DIR"

# --- 检查 bun ---
if ! command -v bun &> /dev/null; then
    echo -e "${RED}错误: Bun 未安装 / Error: Bun is not installed${NC}"
    echo "请访问 https://bun.sh 安装 Bun / Visit https://bun.sh to install Bun"
    exit 1
fi

echo -e "${GREEN}Bun $(bun --version)${NC}"
echo ""

# --- 检查 tmux ---
if ! command -v tmux &> /dev/null; then
    echo -e "${YELLOW}警告: tmux 未安装，本地设备功能将不可用${NC}"
    echo -e "${YELLOW}Warning: tmux not installed, local device features will be unavailable${NC}"
    echo ""
fi

# --- 检查 .env ---
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}未找到 .env 文件，正在从模板创建...${NC}"
    echo -e "${YELLOW}.env not found, creating from template...${NC}"

    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${GREEN}已从 .env.example 创建 .env / Created .env from .env.example${NC}"
    else
        MASTER_KEY=$(head -c 32 /dev/urandom | base64)

        cat > .env << EOF
# tmex configuration
# Generated at: $(date)

TMEX_MASTER_KEY=$MASTER_KEY
TMEX_BASE_URL=http://127.0.0.1:9883
TMEX_SITE_NAME=tmex
GATEWAY_PORT=9663
DATABASE_URL=/tmp/tmex.db
TMEX_GATEWAY_URL=http://localhost:9663
FE_PORT=9883
NODE_ENV=development
EOF
        echo -e "${GREEN}已生成 .env 文件 / Generated .env file${NC}"
    fi
    echo ""
fi

# 读取端口配置
GATEWAY_PORT=$(grep -E '^GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2 || echo "9663")
FE_PORT=$(grep -E '^FE_PORT=' .env 2>/dev/null | cut -d= -f2 || echo "9883")
GATEWAY_PORT="${GATEWAY_PORT:-9663}"
FE_PORT="${FE_PORT:-9883}"

# --- 检查端口占用 ---
check_port() {
    local port=$1
    if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

for port_name in "Gateway:$GATEWAY_PORT" "Frontend:$FE_PORT"; do
    name="${port_name%%:*}"
    port="${port_name##*:}"
    if check_port "$port"; then
        echo -e "${YELLOW}警告: ${name} 端口 ${port} 已被占用 / Warning: ${name} port ${port} is in use${NC}"
        read -p "是否尝试释放? / Try to free it? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            kill "$(lsof -t -i:"$port")" 2>/dev/null || true
            sleep 1
        else
            echo -e "${RED}请手动释放端口后重试 / Please free the port and try again${NC}"
            exit 1
        fi
    fi
done

# --- 安装依赖 ---
echo -e "${BLUE}正在安装依赖... / Installing dependencies...${NC}"
bun install
echo ""

# --- 启动服务 ---
echo -e "${BLUE}正在启动服务... / Starting services...${NC}"
echo ""

GATEWAY_PID=""
FE_PID=""

cleanup() {
    echo ""
    echo -e "${YELLOW}正在停止服务... / Stopping services...${NC}"
    [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
    [ -n "$FE_PID" ] && kill "$FE_PID" 2>/dev/null || true
    wait 2>/dev/null
    echo -e "${GREEN}已停止 / Stopped${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 启动 Gateway
echo -e "${BLUE}[1/2] 启动 Gateway (port ${GATEWAY_PORT})...${NC}"
cd "$PROJECT_DIR/apps/gateway"
bun run dev &
GATEWAY_PID=$!
cd "$PROJECT_DIR"

# 等待 Gateway 就绪
echo -n "      等待 Gateway 就绪 / Waiting for Gateway"
for i in {1..30}; do
    if curl -sf "http://localhost:${GATEWAY_PORT}/healthz" >/dev/null 2>&1; then
        echo ""
        echo -e "      ${GREEN}Gateway 已就绪 / Gateway ready${NC}"
        break
    fi
    echo -n "."
    sleep 1
    if [ "$i" -eq 30 ]; then
        echo ""
        echo -e "      ${YELLOW}Gateway 未在 30 秒内响应健康检查，继续启动前端...${NC}"
        echo -e "      ${YELLOW}Gateway did not respond to healthcheck within 30s, proceeding...${NC}"
    fi
done

# 启动 Frontend
echo -e "${BLUE}[2/2] 启动 Frontend (port ${FE_PORT})...${NC}"
cd "$PROJECT_DIR/apps/fe"
bun dev --host &
FE_PID=$!
cd "$PROJECT_DIR"

sleep 2

echo ""
echo "════════════════════════════════════════"
echo ""
echo -e "${GREEN}✓ tmex 已启动 / tmex is running${NC}"
echo ""
echo "  Gateway:  http://localhost:${GATEWAY_PORT}"
echo "  Frontend: http://localhost:${FE_PORT}"
echo ""
echo -e "  在浏览器中访问 / Open in browser: ${GREEN}http://localhost:${FE_PORT}${NC}"
echo ""
echo -e "${YELLOW}按 Ctrl+C 停止所有服务 / Press Ctrl+C to stop all services${NC}"
echo ""

wait
