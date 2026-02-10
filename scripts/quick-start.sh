#!/bin/bash
# tmex 快速启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════╗"
echo "║           tmex 快速启动               ║"
echo "║     Web 终端管理平台                   ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

cd "$PROJECT_DIR"

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}错误: Docker 未安装${NC}"
    echo "请访问 https://docs.docker.com/get-docker/ 安装 Docker"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}错误: Docker Compose 未安装${NC}"
    exit 1
fi

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}未找到 .env 文件，正在创建...${NC}"
    
    # 生成密钥
    MASTER_KEY=$(head -c 32 /dev/urandom | base64)
    JWT_SECRET=$(head -c 32 /dev/urandom | base64)
    
    cat > .env << EOF
# tmex 配置文件
# 生成时间: $(date)

NODE_ENV=production
TMEX_MASTER_KEY=$MASTER_KEY
TMEX_ADMIN_PASSWORD=admin123
JWT_SECRET=$JWT_SECRET
TMEX_PORT=3000
TMEX_BASE_URL=http://localhost:3000
EOF
    
    echo -e "${GREEN}已创建 .env 文件${NC}"
    echo ""
    echo -e "${YELLOW}默认管理员密码: admin123${NC}"
    echo -e "${YELLOW}建议修改 .env 文件中的 TMEX_ADMIN_PASSWORD${NC}"
    echo ""
    read -p "按 Enter 键继续..."
fi

# 检查端口占用
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 || netstat -tuln 2>/dev/null | grep -q ":$port "; then
        return 0
    else
        return 1
    fi
}

PORT=$(grep TMEX_PORT .env | cut -d= -f2 || echo "3000")
if check_port $PORT; then
    echo -e "${YELLOW}警告: 端口 $PORT 已被占用${NC}"
    read -p "是否停止占用该端口的服务? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # 尝试停止现有的 tmex 容器
        docker-compose down 2>/dev/null || true
        
        # 如果端口仍被占用，尝试杀死进程
        if check_port $PORT; then
            echo "尝试释放端口 $PORT..."
            if command -v lsof &> /dev/null; then
                kill $(lsof -t -i:$PORT) 2>/dev/null || true
            fi
            sleep 2
        fi
    fi
fi

# 构建并启动
echo ""
echo -e "${BLUE}正在构建和启动服务...${NC}"
echo ""

docker-compose down 2>/dev/null || true
docker-compose pull 2>/dev/null || true
docker-compose up --build -d

# 等待服务就绪
echo ""
echo -e "${BLUE}等待服务就绪...${NC}"
for i in {1..30}; do
    if curl -sf http://localhost:$PORT/healthz >/dev/null 2>&1; then
        echo -e "${GREEN}服务已就绪！${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

echo ""
echo "=================================="
echo ""

# 验证启动
if curl -sf http://localhost:$PORT/healthz >/dev/null 2>&1; then
    echo -e "${GREEN}✓ tmex 启动成功！${NC}"
    echo ""
    echo "访问地址:"
    echo "  - 本地访问: http://localhost:$PORT"
    echo ""
    echo "默认登录信息:"
    echo "  - 密码: $(grep TMEX_ADMIN_PASSWORD .env | cut -d= -f2)"
    echo ""
    echo "常用命令:"
    echo "  查看日志: docker-compose logs -f"
    echo "  停止服务: docker-compose down"
    echo "  重启服务: docker-compose restart"
    echo ""
    echo -e "${YELLOW}提示: 首次启动后建议修改默认密码${NC}"
else
    echo -e "${RED}✗ 服务启动可能失败${NC}"
    echo ""
    echo "查看日志排查问题:"
    echo "  docker-compose logs"
    exit 1
fi
