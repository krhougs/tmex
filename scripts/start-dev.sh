#!/bin/bash
# tmex 开发环境启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}未找到 .env 文件，正在创建...${NC}"
    cat > .env << 'EOF'
# tmex 开发环境配置
NODE_ENV=development
TMEX_MASTER_KEY=dev-key-not-for-production
TMEX_ADMIN_PASSWORD=admin123
JWT_SECRET=dev-jwt-secret-not-for-production
GATEWAY_PORT=8080
DATABASE_URL=/tmp/tmex.db
TMEX_BASE_URL=http://localhost:8080
EOF
    echo -e "${GREEN}已创建 .env 文件${NC}"
fi

# 加载环境变量
export $(grep -v '^#' .env | grep -v '^$' | xargs)

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}      tmex 开发环境启动        ${NC}"
echo -e "${BLUE}================================${NC}"
echo ""
echo -e "${GREEN}Gateway:${NC} http://localhost:$GATEWAY_PORT"
echo -e "${GREEN}Frontend:${NC} http://localhost:3000"
echo -e "${GREEN}Admin Password:${NC} $TMEX_ADMIN_PASSWORD"
echo ""

# 清理之前的进程
cleanup() {
    echo ""
    echo "正在停止服务..."
    kill $GATEWAY_PID $FE_PID 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM

# 启动 Gateway
echo "启动 Gateway..."
cd apps/gateway
bun run dev &
GATEWAY_PID=$!
cd ../..

# 等待 Gateway 启动
sleep 2
if ! kill -0 $GATEWAY_PID 2>/dev/null; then
    echo "Gateway 启动失败，请检查错误日志"
    exit 1
fi
echo -e "${GREEN}✓ Gateway 已启动${NC}"

# 启动 Frontend
echo "启动 Frontend..."
cd apps/fe
bun dev --host &
FE_PID=$!
cd ../..

# 等待 Frontend 启动
sleep 3
if ! kill -0 $FE_PID 2>/dev/null; then
    echo "Frontend 启动失败，请检查错误日志"
    kill $GATEWAY_PID 2>/dev/null || true
    exit 1
fi
echo -e "${GREEN}✓ Frontend 已启动${NC}"

echo ""
echo -e "${BLUE}================================${NC}"
echo "按 Ctrl+C 停止所有服务"
echo -e "${BLUE}================================${NC}"

# 等待进程
wait
