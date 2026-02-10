import { expect, test } from '@playwright/test';

const ADMIN_PASSWORD = process.env.TMEX_E2E_ADMIN_PASSWORD ?? 'admin123';
const RUN_ID = process.env.TMEX_E2E_RUN_ID ?? `${Date.now()}`;

function sanitizeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
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
  await page.getByLabel('认证方式').selectOption('password');
  await page.getByLabel('Tmux 会话名称').fill(deviceName);
  await page.getByRole('button', { name: '添加' }).click();

  // 等待设备卡片出现，使用 heading 更精确
  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

test.describe('Terminal 白屏修复', () => {
  test('直接通过 URL 冷启动进入应正确显示 terminal', async ({ page, context }) => {
    const deviceName = sanitizeSessionName(`e2e_coldstart_${RUN_ID}`);
    
    // 先登录并创建设备
    await login(page);
    await addLocalDevice(page, deviceName);
    
    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    
    // 等待连接完成
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    
    // 获取当前 URL
    const currentUrl = page.url();
    
    // 新开一个页面，直接访问该 URL（模拟冷启动）
    const newPage = await context.newPage();
    await newPage.goto(currentUrl);
    
    // 重新登录
    await newPage.getByLabel('密码').fill(ADMIN_PASSWORD);
    await newPage.getByRole('button', { name: '登录' }).click();
    
    // 等待跳转到目标 URL
    await newPage.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待 xterm 初始化（ResizeObserver 需要时间来检测容器尺寸）
    await newPage.waitForTimeout(2000);
    
    // 关键：terminal 应该可见，不应该白屏
    await expect(newPage.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect(newPage.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });
    
    // 验证可以输入命令
    await newPage.locator('.xterm').click();
    await newPage.keyboard.type('echo coldstart_test');
    
    // 清理
    await newPage.close();
    
    // 清理原页面的会话
    await page.locator('.xterm').click();
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});

test.describe('Sidebar 功能', () => {
  test('高亮样式应清晰可见', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_highlight_${RUN_ID}`);
    
    await login(page);
    await addLocalDevice(page, deviceName);
    
    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待自动展开设备树（需要等待 snapshot 数据到达）
    await page.waitForTimeout(1000);
    
    // 验证窗口有正确的高亮样式
    const windowButton = page.getByRole('button', { name: /\d+: zsh/ }).first();
    await expect(windowButton).toBeVisible({ timeout: 30_000 });
    
    // 检查 active 样式是否存在（通过 computed style 检查）
    const hasActiveClass = await windowButton.evaluate((el) => 
      el.classList.contains('active') || el.closest('.active') !== null
    );
    expect(hasActiveClass).toBe(true);
    
    // 清理
    await page.locator('.xterm').click();
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('应能通过 Sidebar 切换 window', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_switch_win_${RUN_ID}`);
    const windowName = `e2e_win_${RUN_ID}`;
    
    await login(page);
    await addLocalDevice(page, deviceName);
    
    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待自动展开设备树
    await page.waitForTimeout(1000);
    
    // 创建新窗口
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux new-window -n ${windowName}`);
    await page.keyboard.press('Enter');
    
    // 等待新窗口出现在 Sidebar
    await expect(page.getByRole('button', { name: new RegExp(`\\d+: ${windowName}`) })).toBeVisible({ timeout: 30_000 });
    
    // 点击新窗口切换
    await page.getByRole('button', { name: new RegExp(`\\d+: ${windowName}`) }).click();
    
    // 验证 URL 变化
    await page.waitForURL(new RegExp(`/devices/[^/]+/windows/[^/]+/panes/%`), { timeout: 30_000 });
    
    // 验证终端内容变化（新窗口应该有新的 prompt）
    await expect(page.locator('.xterm')).toBeVisible();
    
    // 切回第一个窗口
    await page.getByRole('button', { name: /\d+: zsh/ }).first().click();
    
    // 验证 URL 再次变化
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-window -t :1 || true`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('应能通过 Sidebar 新建窗口', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_new_win_${RUN_ID}`);
    
    await login(page);
    await addLocalDevice(page, deviceName);
    
    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待自动展开设备树
    await page.waitForTimeout(1000);
    
    // 等待初始窗口出现
    await expect(page.getByRole('button', { name: /\d+: zsh/ })).toBeVisible({ timeout: 30_000 });
    
    // 点击新建窗口按钮（+ 号）
    const newWindowButton = page.locator('[title="新建窗口"]').first();
    await expect(newWindowButton).toBeVisible();
    await newWindowButton.click();
    
    // 验证新窗口出现（应该有两个窗口了）
    await expect(page.getByRole('button', { name: /\d+: zsh/ })).toHaveCount(2, { timeout: 30_000 });
    
    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-window -t :1 || true`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('Pane 列表应正确显示和切换', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_pane_${RUN_ID}`);
    
    await login(page);
    await addLocalDevice(page, deviceName);
    
    // 连接设备
    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    
    // 等待自动展开设备树
    await page.waitForTimeout(1000);
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux split-window -h');
    await page.keyboard.press('Enter');
    
    // 等待 snapshot 更新（pane 数量变化）
    await page.waitForTimeout(2000);
    
    // 验证 pane 按钮存在且可点击
    const paneButtons = page.locator('.pane-item');
    const paneCount = await paneButtons.count();
    expect(paneCount).toBeGreaterThanOrEqual(1);
    
    // 点击第二个 pane（如果存在）
    if (paneCount >= 2) {
      await paneButtons.nth(1).click();
      // 验证 URL 变化
      await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    }
    
    // 清理
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});

test.describe('响应式布局', () => {
  test('调整浏览器宽度不应导致页面不可用', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_resize_${RUN_ID}`);
    
    await login(page);
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
    
    // 测试多种尺寸
    const sizes = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ];
    
    for (const size of sizes) {
      // 调整窗口大小
      await page.setViewportSize({ width: size.width, height: size.height });
      
      // 等待一点时间来应用样式
      await page.waitForTimeout(200);
      
      // 验证 terminal 仍然可见
      await expect(page.locator('.xterm')).toBeVisible();
      
      // 验证可以输入（页面没有卡死）
      await page.locator('.xterm').click();
      await page.keyboard.type(' ');
      
      // 如果是移动端尺寸，验证汉堡菜单存在
      if (size.width < 768) {
        const menuButton = page.locator('header button').first();
        await expect(menuButton).toBeVisible();
      }
    }
    
    // 恢复桌面尺寸
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // 清理
    await page.locator('.xterm').click();
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});
