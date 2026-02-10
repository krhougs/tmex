#!/bin/bash
# tmex 部署验证脚本

set -e

HOST="${1:-http://localhost:3000}"
ADMIN_PASSWORD="${TMEX_ADMIN_PASSWORD:-admin123}"
COOKIE_JAR="/tmp/tmex-verify-cookies.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔════════════════════════════════════════╗"
echo "║         tmex 部署验证                 ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo "目标地址: $HOST"
echo ""

# 清理函数
cleanup() {
    rm -f "$COOKIE_JAR"
}
trap cleanup EXIT

# 检查工具
if ! command -v curl &> /dev/null; then
    echo -e "${RED}需要安装 curl${NC}"
    exit 1
fi

# 测试计数
TESTS_PASSED=0
TESTS_FAILED=0

# 测试函数
test_step() {
    local name="$1"
    local expected="$2"
    local actual="$3"
    
    if [ "$expected" = "$actual" ] || [[ "$actual" == *"$expected"* ]]; then
        echo -e "  ${GREEN}✓${NC} $name"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}✗${NC} $name"
        echo "    预期: $expected"
        echo "    实际: $actual"
        ((TESTS_FAILED++))
    fi
}

echo "=================================="
echo "1. 基础连通性测试"
echo "=================================="

# 测试根路径
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$HOST" || echo "000")
test_step "前端服务可访问" "200" "$RESPONSE"

# 测试健康检查
RESPONSE=$(curl -s "$HOST/healthz" || echo "{}")
if echo "$RESPONSE" | grep -q "ok"; then
    test_step "健康检查接口" "ok" "$RESPONSE"
else
    test_step "健康检查接口" "ok" "failed"
fi

echo ""
echo "=================================="
echo "2. 认证流程测试"
echo "=================================="

# 登录
LOGIN_RESPONSE=$(curl -s -X POST "$HOST/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$ADMIN_PASSWORD\"}" \
    -c "$COOKIE_JAR" || echo "{}")

if echo "$LOGIN_RESPONSE" | grep -q "success.*true"; then
    test_step "管理员登录" "true" "success"
else
    test_step "管理员登录" "true" "failed"
fi

# 获取用户信息
ME_RESPONSE=$(curl -s "$HOST/api/auth/me" -b "$COOKIE_JAR" || echo "{}")
if echo "$ME_RESPONSE" | grep -q "admin"; then
    test_step "获取用户信息" "admin" "$ME_RESPONSE"
else
    test_step "获取用户信息" "admin" "failed"
fi

echo ""
echo "=================================="
echo "3. 设备管理测试"
echo "=================================="

# 创建设备
DEVICE_RESPONSE=$(curl -s -X POST "$HOST/api/devices" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_JAR" \
    -d '{"name":"验证设备","type":"local","authMode":"password"}' || echo "{}")

DEVICE_ID=$(echo "$DEVICE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

if [ -n "$DEVICE_ID" ]; then
    test_step "创建设备" "id" "$DEVICE_RESPONSE"
else
    test_step "创建设备" "id" "failed"
fi

# 列出设备
LIST_RESPONSE=$(curl -s "$HOST/api/devices" -b "$COOKIE_JAR" || echo "[]")
if echo "$LIST_RESPONSE" | grep -q "验证设备"; then
    test_step "列出设备" "验证设备" "$LIST_RESPONSE"
else
    test_step "列出设备" "验证设备" "not found"
fi

# 删除设备
if [ -n "$DEVICE_ID" ]; then
    DELETE_RESPONSE=$(curl -s -X DELETE "$HOST/api/devices/$DEVICE_ID" -b "$COOKIE_JAR" || echo "{}")
    if echo "$DELETE_RESPONSE" | grep -q "success.*true"; then
        test_step "删除设备" "true" "success"
    else
        test_step "删除设备" "true" "failed"
    fi
fi

echo ""
echo "=================================="
echo "4. WebSocket 测试"
echo "=================================="

# 检查 WebSocket 端口
WS_URL="${HOST/http/ws}"
if command -v nc &> /dev/null; then
    if nc -z -w 2 "${HOST#http://}" "${HOST##*:}" 2>/dev/null || nc -z -w 2 localhost 3000 2>/dev/null; then
        test_step "WebSocket 端口开放" "open" "open"
    else
        test_step "WebSocket 端口开放" "open" "closed"
    fi
else
    echo -e "  ${YELLOW}!${NC} WebSocket 测试跳过 (需要 nc)"
fi

echo ""
echo "=================================="
echo "5. Docker 容器检查（本地部署）"
echo "=================================="

if command -v docker &> /dev/null; then
    if docker ps | grep -q "tmex"; then
        test_step "tmex 容器运行中" "tmex" "running"
        
        # 检查容器健康状态
        HEALTH=$(docker inspect --format='{{.State.Health.Status}}' tmex-gateway 2>/dev/null || echo "unknown")
        if [ "$HEALTH" = "healthy" ] || [ "$HEALTH" = "unknown" ]; then
            test_step "Gateway 健康状态" "healthy" "$HEALTH"
        else
            test_step "Gateway 健康状态" "healthy" "$HEALTH"
        fi
    else
        echo -e "  ${YELLOW}!${NC} 未检测到 tmex Docker 容器"
    fi
else
    echo -e "  ${YELLOW}!${NC} Docker 未安装，跳过容器检查"
fi

echo ""
echo "=================================="
echo "验证结果汇总"
echo "=================================="
echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
echo -e "失败: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ 所有验证通过！部署成功。${NC}"
    echo ""
    echo "访问地址: $HOST"
    echo "默认密码: $ADMIN_PASSWORD"
    exit 0
else
    echo -e "${RED}✗ 部分验证失败，请检查以下项目：${NC}"
    echo ""
    echo "1. 确保服务已启动: docker-compose ps"
    echo "2. 查看日志: docker-compose logs -f"
    echo "3. 检查防火墙设置"
    echo "4. 验证 .env 配置是否正确"
    exit 1
fi
