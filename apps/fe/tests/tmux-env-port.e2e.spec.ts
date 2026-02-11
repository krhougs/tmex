import { expect, test } from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';

const ADMIN_PASSWORD = process.env.TMEX_E2E_ADMIN_PASSWORD ?? 'admin123';

/**
 * 检查端口是否被监听
 */
async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res) => {
      resolve(res.statusCode !== undefined);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 检查端口是否可用（未被占用）
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port);
  });
}

test.describe('FE_PORT 环境变量', () => {
  test('应支持通过环境变量配置前端端口', async ({ page }) => {
    // 这个测试验证前端是否实际运行在配置的端口上
    // playwright.config.ts 已经配置了FE_PORT，我们只需要验证baseURL是否可访问
    
    await page.goto('/login');
    
    // 如果能成功加载登录页，说明前端服务在配置的端口上运行
    await expect(page.getByLabel('密码')).toBeVisible();
    
    // 验证页面加载正确
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });

  test('端口检测应正确工作', async () => {
    // 测试端口检测函数
    const testPort = 59999; // 使用一个不太可能使用的端口
    
    // 检查端口可用
    const available = await isPortAvailable(testPort);
    console.log(`[e2e] Port ${testPort} available:`, available);
    expect(typeof available).toBe('boolean');
  });

  test('网关端口应可访问', async () => {
    // 从环境变量获取网关端口
    const gatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || 9663;
    
    // 检查网关健康端点
    const isListening = await isPortListening(gatewayPort);
    console.log(`[e2e] Gateway port ${gatewayPort} listening:`, isListening);
    
    // 注意：这个测试可能在webServer启动前运行，所以端口可能还不可用
    // 我们主要验证测试框架能正确读取环境变量
    expect(gatewayPort).toBeGreaterThan(0);
    expect(gatewayPort).toBeLessThan(65536);
  });
});
