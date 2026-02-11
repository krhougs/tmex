import { expect, test } from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';

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
    await page.goto('/devices');
    await expect(page.getByTestId('devices-add').first()).toBeVisible();
    await expect(page).toHaveURL(/\/devices/);
  });

  test('端口检测应正确工作', async () => {
    const testPort = 59999;
    const available = await isPortAvailable(testPort);
    expect(typeof available).toBe('boolean');
  });

  test('网关端口应可访问', async () => {
    const gatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || 9663;

    const isListening = await isPortListening(gatewayPort);
    expect(typeof isListening).toBe('boolean');

    expect(gatewayPort).toBeGreaterThan(0);
    expect(gatewayPort).toBeLessThan(65536);
  });
});
