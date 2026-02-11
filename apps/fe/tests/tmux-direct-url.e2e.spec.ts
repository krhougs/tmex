import { expect, test } from '@playwright/test';

const RUN_ID = process.env.TMEX_E2E_RUN_ID ?? `${Date.now()}`;

function sanitizeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function openDevices(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/devices');
  await page.waitForURL(/\/devices/);
}

async function addLocalDevice(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<void> {
  await page.goto('/devices');
  await page.getByTestId('devices-add').first().click();

  await page.getByTestId('device-name-input').fill(deviceName);
  await page.getByLabel('类型').selectOption('local');
  await page.getByLabel('Tmux 会话名称').fill(deviceName);
  await page.getByTestId('device-dialog-save').click();

  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

async function connectDeviceAndGetPaneUrl(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<string> {
  await page.goto('/devices');
  const deviceCardHeader = page
    .getByRole('heading', { name: deviceName })
    .locator('xpath=..')
    .locator('xpath=..');
  await page.getByTestId(`device-connect-${deviceId}`).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  return page.url();
}

test.describe('直接URL访问 - 白屏检测', () => {
  test('从设备页URL直接访问应显示终端内容', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_direct_${RUN_ID}`);

    // 先打开设备页并创建设备
    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 连接设备获取窗口和pane信息
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    // 等待URL中包含窗口和pane信息
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待终端可见
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    
    // 获取当前URL
    const currentUrl = page.url();
    console.log('[e2e] Current URL:', currentUrl);

    // 在终端中输入一些内容，确保有历史记录
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('echo direct_url_test_content');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // 记住窗口和pane信息
    const urlMatch = currentUrl.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(urlMatch).not.toBeNull();
    
    const [, deviceId, windowId, paneId] = urlMatch!;
    console.log('[e2e] Device:', deviceId, 'Window:', windowId, 'Pane:', paneId);

    // 直接访问URL（模拟从外部链接进入）
    await page.goto(currentUrl);
    
    // 关键验证：页面不应白屏
    // 1. 终端应在3秒内可见
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 3_000 });
    
    // 2. 不应显示纯白色屏幕（检查body背景色）
    const bodyBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    expect(bodyBg).not.toBe('rgb(255, 255, 255)'); // 不应是纯白色
    console.log('[e2e] Body background:', bodyBg);

    // 3. 终端区域应有内容（通过检查xterm的DOM）
    const xtermContent = await page.locator('.xterm-screen').textContent();
    console.log('[e2e] Terminal content length:', xtermContent?.length ?? 0);
    
    // 4. 检查是否显示加载状态而不是白屏
    const loadingText = await page.getByText('初始化终端...').isVisible().catch(() => false);
    const connectingText = await page.getByText('连接设备...').isVisible().catch(() => false);
    
    // 如果显示了加载状态，等待它消失
    if (loadingText || connectingText) {
      await page.waitForSelector('.xterm', { timeout: 10_000 });
    }

    // 5. 最终验证终端可见且可交互
    await expect(page.locator('.xterm')).toBeVisible();
    await page.locator('.xterm').click();
    await page.keyboard.type('echo still_working');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // 清理
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('直接访问应正确解码双重编码的pane ID', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_decode_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    // 获取原始URL
    const originalUrl = page.url();
    const urlMatch = originalUrl.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(urlMatch).not.toBeNull();
    
    const [, deviceId, windowId, originalPaneId] = urlMatch!;
    
    // 测试双重编码的pane ID（模拟某些浏览器的行为）
    const doubleEncodedPaneId = encodeURIComponent(encodeURIComponent(originalPaneId));
    const doubleEncodedUrl = `${page.url().split('/panes/')[0]}/panes/${doubleEncodedPaneId}`;
    
    console.log('[e2e] Original pane ID:', originalPaneId);
    console.log('[e2e] Double encoded pane ID:', doubleEncodedPaneId);
    console.log('[e2e] Double encoded URL:', doubleEncodedUrl);

    // 访问双重编码的URL
    await page.goto(doubleEncodedUrl);
    
    // 应该能正确解码并显示终端
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });
    
    // 验证页面没有报错
    const errorAlert = await page.locator('[role="alert"]').isVisible().catch(() => false);
    expect(errorAlert).toBe(false);

    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('直接访问无pane ID的设备页应自动选择第一个pane', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_autoselect_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 直接访问设备页（不带window/pane）
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 获取完整URL
    const fullUrl = page.url();
    console.log('[e2e] Auto-selected URL:', fullUrl);

    // 直接访问基础设备页（不带window/pane）
    const baseUrl = fullUrl.split('/windows/')[0];
    await page.goto(baseUrl);

    // 应该自动重定向到包含window和pane的URL
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 10_000 });
    
    // 终端应该可见
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('冷启动直链不应连接到其他设备', async ({ page, browser }) => {
    const deviceAName = sanitizeSessionName(`e2e_direct_a_${RUN_ID}`);
    const deviceBName = sanitizeSessionName(`e2e_direct_b_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceAName);
    await addLocalDevice(page, deviceBName);

    const directUrlA = await connectDeviceAndGetPaneUrl(page, deviceAName);
    const directUrlB = await connectDeviceAndGetPaneUrl(page, deviceBName);

    const matchA = directUrlA.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    const matchB = directUrlB.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(matchA).not.toBeNull();
    expect(matchB).not.toBeNull();

    const [, deviceAId] = matchA!;
    const [, deviceBId] = matchB!;

    const coldPage = await browser.newPage();
    const connectDeviceIds: string[] = [];

    coldPage.on('websocket', (ws) => {
      ws.on('framesent', (event) => {
        const raw =
          typeof event.payload === 'string' ? event.payload : event.payload.toString();
        try {
          const msg = JSON.parse(raw) as {
            type?: string;
            payload?: { deviceId?: string };
          };
          if (msg.type === 'device/connect' && msg.payload?.deviceId) {
            connectDeviceIds.push(msg.payload.deviceId);
          }
        } catch {
          // ignore non-json frames
        }
      });
    });

    await coldPage.goto(directUrlA);
    await coldPage.waitForURL(
      new RegExp(`/devices/${deviceAId}/windows/[^/]+/panes/[^/]+$`),
      { timeout: 30_000 }
    );
    await expect(coldPage.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await coldPage.waitForTimeout(1_200);

    expect(connectDeviceIds.includes(deviceAId)).toBe(true);
    expect(connectDeviceIds.includes(deviceBId)).toBe(false);

    await coldPage.close();

    await page.goto(directUrlA);
    await page.locator('.xterm').click();
    await page.waitForTimeout(300);
    await page.keyboard.type(`tmux kill-session -t ${deviceAName} || true`);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`tmux kill-session -t ${deviceBName} || true`);
    await page.keyboard.press('Enter');
  });
});
