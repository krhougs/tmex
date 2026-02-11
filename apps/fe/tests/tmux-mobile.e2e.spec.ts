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
  await page.getByRole('button', { name: '添加设备' }).first().click();

  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('类型').selectOption('local');
  await page.getByLabel('Tmux 会话名称').fill(deviceName);
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

test.describe('移动端布局', () => {
  test('iPhone 尺寸下顶栏不应挤在一起', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_mobile_header_${RUN_ID}`);

    // 设置 iPhone 尺寸
    await page.setViewportSize({ width: 390, height: 844 });

    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    // 验证顶栏元素不重叠
    const header = page.locator('header').first();
    const headerBox = await header.boundingBox();
    expect(headerBox).toBeTruthy();

    // 验证汉堡菜单按钮可见
    const menuButton = header.getByRole('button', { name: '打开侧边栏' });
    await expect(menuButton).toBeVisible();

    // 验证标题可见
    const title = page.getByTestId('mobile-topbar-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText(/\d+\/\d+:\s+[^@]+@.+/);

    // 验证只存在一行固定顶栏，且包含两个操作按钮
    await expect(page.locator('header')).toHaveCount(1);
    await expect(header.getByRole('button', { name: /切换到编辑器输入|切换到直接输入/ })).toBeVisible();
    await expect(header.getByRole('button', { name: '跳转到最新' })).toBeVisible();

    // 顶栏固定在视口顶部
    await expect(header).toHaveCSS('position', 'fixed');

    // 点击终端验证可以输入
    await page.locator('.xterm').click();
    await page.keyboard.type('echo mobile_test');
    await page.keyboard.press('Enter');

    // 清理
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('iPad 尺寸下布局应正常', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_ipad_${RUN_ID}`);

    // 设置 iPad 尺寸
    await page.setViewportSize({ width: 768, height: 1024 });

    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    // 验证侧边栏可见（iPad 尺寸下应该是可见的）
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();

    // 点击终端验证可以输入
    await page.locator('.xterm').click();
    await page.keyboard.type('echo ipad_test');
    await page.keyboard.press('Enter');

    // 清理
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('折叠的 Sidebar 图标应清晰可见', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_sidebar_${RUN_ID}`);

    // 使用桌面尺寸以便测试折叠 sidebar
    await page.setViewportSize({ width: 1280, height: 720 });

    await openDevices(page);
    await addLocalDevice(page, deviceName);

    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });

    // 点击折叠 sidebar 按钮
    const collapseButton = page.locator('aside button').first();
    await collapseButton.click();
    await page.waitForTimeout(500);

    // 验证折叠后的 sidebar 中的图标可见且清晰
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();

    // 验证设备图标可见
    const deviceIcon = sidebar.locator('.text-\\[var\\(--color-text\\)\\]').first();
    await expect(deviceIcon).toBeVisible();

    // 展开 sidebar
    await collapseButton.click();
    await page.waitForTimeout(500);

    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});
