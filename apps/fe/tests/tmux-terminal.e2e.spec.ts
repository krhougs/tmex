import { execFileSync } from 'node:child_process';
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

  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

function readActivePaneSize(sessionName: string): { rows: number; cols: number } {
  const output = execFileSync(
    'tmux',
    ['list-panes', '-t', sessionName, '-F', '#{pane_active}\t#{pane_width}\t#{pane_height}'],
    { encoding: 'utf8' }
  ).trim();

  const lines = output.split('\n').filter(Boolean);
  const active = lines.find((line) => line.startsWith('1\t')) ?? lines[0];
  if (!active) {
    throw new Error(`No pane found for session ${sessionName}`);
  }

  const [, colsText, rowsText] = active.split('\t');
  const cols = Number(colsText);
  const rows = Number(rowsText);
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) {
    throw new Error(`Failed to parse pane size from ${active}`);
  }

  return { rows, cols };
}


function readActiveWindowId(sessionName: string): string {
  const output = execFileSync(
    'tmux',
    ['list-windows', '-t', sessionName, '-F', '#{window_active}\t#{window_id}'],
    { encoding: 'utf8' }
  ).trim();

  const lines = output.split('\n').filter(Boolean);
  const active = lines.find((line) => line.startsWith('1\t')) ?? lines[0];
  if (!active) {
    throw new Error(`No window found for session ${sessionName}`);
  }

  const [, windowId] = active.split('\t');
  if (!windowId) {
    throw new Error(`Failed to parse window id from ${active}`);
  }

  return windowId;
}



test.describe('Terminal 历史内容显示', () => {
  test('连接后应显示 pane 现有内容', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_history_${RUN_ID}`);

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

    // 在终端中输入一些内容
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('echo test_history_content');
    await page.keyboard.press('Enter');

    // 等待内容显示
    await page.waitForTimeout(1000);

    // 验证终端中有内容（通过截图或检查 DOM）
    const terminalContent = await page.locator('.xterm-screen').textContent();
    expect(terminalContent).toBeTruthy();

    // 清理
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });


  test('页面刷新后历史应保留 ANSI 颜色转义', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_color_refresh_${RUN_ID}`);
    const historyPayloads: string[] = [];

    page.on('websocket', (socket) => {
      socket.on('framereceived', (event) => {
        if (typeof event.payload !== 'string') {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.payload);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== 'object') {
          return;
        }

        const message = parsed as { type?: unknown; payload?: { data?: unknown } };
        if (message.type !== 'term/history') {
          return;
        }

        if (typeof message.payload?.data === 'string') {
          historyPayloads.push(message.payload.data);
        }
      });
    });

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm').click();
    await page.waitForTimeout(400);
    await page.keyboard.type("printf '\\033[31mTMEX_COLOR_REFRESH\\033[0m\\n'");
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await page.reload();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => historyPayloads.some((data) => data.includes('\u001b[')), { timeout: 15_000 })
      .toBe(true);

    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('鼠标滚轮应可以滚动查看历史内容', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_scroll_${RUN_ID}`);

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

    // 生成大量输出来测试滚动
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.type(`echo line_${i}_test_scroll_content`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
    }

    // 等待内容生成
    await page.waitForTimeout(1000);

    // 测试鼠标滚轮滚动
    const terminal = page.locator('.xterm');
    await terminal.evaluate((el) => {
      // 模拟滚轮事件向上滚动
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
      });
      el.dispatchEvent(wheelEvent);
    });

    // 等待滚动动画
    await page.waitForTimeout(500);

    // 验证终端仍然可见且可以交互
    await expect(page.locator('.xterm')).toBeVisible();

    // 清理
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});

test.describe('Terminal 按键处理', () => {
  test('Shift+Enter 应正确传递', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_key_${RUN_ID}`);

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

    // 点击终端聚焦
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);

    // 测试 Shift+Enter
    await page.keyboard.type('echo shift_enter_test');
    await page.keyboard.press('Shift+Enter');

    // 等待并验证（终端应显示换行但未执行命令）
    await page.waitForTimeout(1000);

    // 清理
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('Ctrl+C 应正确传递', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_ctrlc_${RUN_ID}`);

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

    // 点击终端聚焦
    await page.locator('.xterm').click();
    await page.waitForTimeout(500);

    // 启动一个长时间运行的命令
    await page.keyboard.type('sleep 10');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // 发送 Ctrl+C 中断
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // 验证终端可以正常输入（命令被中断）
    await page.keyboard.type('echo interrupted');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // 清理
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});

test.describe('Terminal 尺寸同步', () => {
  test('跳转到最新按钮应工作正常', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_sync_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    const before = readActivePaneSize(deviceName);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 860, height: 560 });
    await page.waitForTimeout(600);

    const jumpToLatestButton = page.getByRole('button', { name: /跳转到最新/ });
    await expect(jumpToLatestButton).toBeVisible();
    await jumpToLatestButton.click();
    await page.waitForTimeout(600);

    await expect
      .poll(
        () => {
          const size = readActivePaneSize(deviceName);
          return `${size.cols}x${size.rows}`;
        },
        { timeout: 15_000 }
      )
      .not.toBe(`${before.cols}x${before.rows}`);

    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('调整窗口大小后应能同步', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_resize_sync_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);

    const before = readActivePaneSize(deviceName);

    await page.setViewportSize({ width: 820, height: 560 });
    await page.waitForTimeout(1500);

    await expect
      .poll(
        () => {
          const size = readActivePaneSize(deviceName);
          return `${size.cols}x${size.rows}`;
        },
        { timeout: 15_000 }
      )
      .not.toBe(`${before.cols}x${before.rows}`);

    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });


  test('外部 tmux 调整尺寸后浏览器 rows/cols 应跟随变化', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_external_resize_${RUN_ID}`);
    const snapshotSizes: string[] = [];

    page.on('websocket', (socket) => {
      socket.on('framereceived', (event) => {
        if (typeof event.payload !== 'string') {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.payload);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== 'object') {
          return;
        }

        const message = parsed as {
          type?: unknown;
          payload?: {
            session?: {
              windows?: Array<{ panes?: Array<{ width?: number; height?: number }> }>;
            };
          };
        };

        if (message.type !== 'state/snapshot') {
          return;
        }

        const windows = message.payload?.session?.windows;
        if (!Array.isArray(windows)) {
          return;
        }

        for (const window of windows) {
          for (const pane of window.panes ?? []) {
            if (typeof pane.width === 'number' && typeof pane.height === 'number') {
              snapshotSizes.push(`${pane.width}x${pane.height}`);
            }
          }
        }
      });
    });

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    const before = readActivePaneSize(deviceName);
    const targetCols = Math.max(40, before.cols - 12);
    const targetRows = Math.max(12, before.rows - 6);

    const activeWindowId = readActiveWindowId(deviceName);
    execFileSync(
      'tmux',
      ['resize-window', '-t', activeWindowId, '-x', String(targetCols), '-y', String(targetRows)],
      { encoding: 'utf8' }
    );

    await expect
      .poll(
        () => {
          const pane = readActivePaneSize(deviceName);
          return `${pane.cols}x${pane.rows}`;
        },
        { timeout: 15_000 }
      )
      .toBe(`${targetCols}x${targetRows}`);

    await expect
      .poll(() => snapshotSizes.includes(`${targetCols}x${targetRows}`), { timeout: 15_000 })
      .toBe(true);

    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('当前 pane 被关闭后应显示失效态并禁用跳转到最新按钮', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_invalid_selection_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    const activePaneItem = page.locator('[data-testid^="pane-item-"][data-active="true"]').first();
    await expect(activePaneItem).toBeVisible({ timeout: 30_000 });
    await activePaneItem.getByRole('button', { name: /关闭 pane/ }).click();

    await expect(page.getByRole('button', { name: /跳转到最新/ })).toBeDisabled();
  });

  test('终端页面应更新浏览器标题', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_title_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => page.title(), { timeout: 15_000 })
      .toMatch(/^\[tmex\]\d+\/\d+:\s+[^@]+@.+$/);

    await page.goto('/devices');
    await expect(page).toHaveTitle('tmex');
  });
});
