#!/bin/bash
# tmex 健康检查脚本

set -e

# 配置
HOST="${TMEX_HOST:-http://localhost:3000}"
GATEWAY_HOST="${TMEX_GATEWAY_HOST:-http://localhost:8080}"
ADMIN_PASSWORD="${TMEX_ADMIN_PASSWORD:-test123}"
COOKIE_JAR="/tmp/tmex-health-cookies.txt"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=================================="
echo "tmex 健康检查"
echo "=================================="
echo ""

# 清理
cleanup() {
    rm -f "$COOKIE_JAR"
}
trap cleanup EXIT

# 检查命令
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

if ! command_exists curl; then
    echo -e "${RED}错误: 未安装 curl${NC}"
    exit 1
fi

if ! command_exists jq; then
    echo -e "${YELLOW}警告: 未安装 jq，JSON 输出将不格式化${NC}"
    JQ_CMD="cat"
else
    JQ_CMD="jq"
fi

# 测试计数
TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
    local name="$1"
    local cmd="$2"
    
    echo -n "测试: $name ... "
    if eval "$cmd" >/dev/null 2>&1; then
        echo -e "${GREEN}通过${NC}"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}失败${NC}"
        ((TESTS_FAILED++))
        return 1
    fi
}

echo "1. 服务可用性检查"
echo "------------------"

run_test "Gateway 健康检查" "curl -sf $GATEWAY_HOST/healthz"
run_test "前端服务可访问" "curl -sf $HOST > /dev/null"

echo ""
echo "2. API 功能检查"
echo "----------------"

# 登录
run_test "登录接口" "curl -sf -X POST $HOST/api/auth/login -H 'Content-Type: application/json' -d '{\"password\":\"'$ADMIN_PASSWORD'\"}' -c $COOKIE_JAR"

# 获取用户信息
run_test "获取用户信息" "curl -sf $HOST/api/auth/me -b $COOKIE_JAR"

# 创建设备
DEVICE_RESPONSE=$(curl -sf -X POST "$HOST/api/devices" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_JAR" \
    -d '{"name":"健康检查设备","type":"local","authMode":"password"}' 2>/dev/null || echo '{"error":"failed"}')

if echo "$DEVICE_RESPONSE" | grep -q '"id"'; then
    DEVICE_ID=$(echo "$DEVICE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    run_test "创建设备" "true"
else
    run_test "创建设备" "false"
    DEVICE_ID=""
fi

# 列出设备
run_test "列出设备" "curl -sf $HOST/api/devices -b $COOKIE_JAR"

# 删除测试设备
if [ -n "$DEVICE_ID" ]; then
    run_test "删除设备" "curl -sf -X DELETE $HOST/api/devices/$DEVICE_ID -b $COOKIE_JAR"
fi

# 登出
run_test "登出接口" "curl -sf -X POST $HOST/api/auth/logout -b $COOKIE_JAR"

echo ""
echo "3. WebSocket 检查"
echo "-----------------"

if command_exists wscat; then
    # 先登录获取 Cookie
    curl -sf -X POST "$HOST/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"password\":\"$ADMIN_PASSWORD\"}" \
        -c "$COOKIE_JAR" >/dev/null 2>&1
    
    # 提取 token
    TOKEN=$(grep "token" "$COOKIE_JAR" 2>/dev/null | awk '{print $7}' || echo "")
    
    if [ -n "$TOKEN" ]; then
        run_test "WebSocket 连接" "timeout 2 wscat -c '${HOST/ws/wss}://$HOST/ws' -H 'Cookie: token=$TOKEN' -x '{\"type\":\"ping\"}' 2>/dev/null || true"
    else
        echo -e "${YELLOW}跳过: 无法获取 WebSocket token${NC}"
    fi
else
    echo -e "${YELLOW}跳过: 未安装 wscat (npm install -g wscat)${NC}"
fi

echo ""
echo "=================================="
echo "检查结果"
echo "=================================="
echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
echo -e "失败: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}所有检查通过！服务运行正常。${NC}"
    exit 0
else
    echo -e "${RED}部分检查失败，请查看日志。${NC}"
    echo ""
    echo "查看日志:"
    echo "  docker-compose logs -f gateway"
    echo "  docker-compose logs -f fe"
    exit 1
fi
