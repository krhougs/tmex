import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile: single pane view with pane switcher and stacked layout', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-split-mobile-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-split-mobile-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);
    await expect(page.locator('[data-terminal-engine]')).toBeVisible({ timeout: 20000 });

    // 移动端不渲染分屏
    await expect(page.getByTestId('split-terminal-area')).toHaveCount(0);

    // 标题栏出现切换按钮
    const switcher = page.getByTestId('pane-switcher-button');
    await expect(switcher).toBeVisible({ timeout: 10000 });

    // 拼接布局：window 宽 = N*cols+(N-1)，各 pane 等宽、高度 = rows
    await expect
      .poll(
        () => {
          const rows = tmux(`list-panes -t ${sessionName} -F '#{pane_width}'`)
            .split(/\r?\n/)
            .map((value) => Number(value.trim()));
          const winW = Number(tmux(`display-message -p -t ${sessionName} '#{window_width}'`));
          const allEqual = rows.every((width) => width === rows[0]);
          return allEqual && winW === rows.length * (rows[0] ?? 0) + (rows.length - 1);
        },
        { timeout: 20000 }
      )
      .toBe(true);

    // 弹出列表并切换到另一个 pane
    await switcher.click();
    const items = page.getByTestId('pane-switcher-item');
    await expect(items).toHaveCount(2);

    const currentPaneId = decodeURIComponent(page.url().split('/panes/')[1] ?? '');
    const targetItem = page.locator(
      `[data-testid="pane-switcher-item"]:not([data-pane-id="${currentPaneId}"])`
    );
    const targetPaneId = await targetItem.getAttribute('data-pane-id');
    await targetItem.click();
    await page.waitForURL((url) => url.pathname.includes(encodeURIComponent(targetPaneId ?? '')), {
      timeout: 10000,
    });

    // 切换后 tmux active 同步
    await expect
      .poll(() => tmux(`display-message -p -t ${sessionName} '#{pane_id}'`), { timeout: 8000 })
      .toBe(targetPaneId ?? '');
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
