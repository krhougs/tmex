import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 1280, height: 800 } });

function paneWidths(sessionName: string): Record<string, number> {
  return tmux(`list-panes -t ${sessionName} -F '#{pane_id}:#{pane_width}'`)
    .split(/\r?\n/)
    .map((line) => line.trim().split(':'))
    .reduce<Record<string, number>>((acc, [id, width]) => {
      if (id) acc[id] = Number(width);
      return acc;
    }, {});
}

async function waitForStablePaneWidths(sessionName: string): Promise<Record<string, number>> {
  let current = paneWidths(sessionName);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const next = paneWidths(sessionName);
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    current = next;
  }
  return current;
}

test('desktop: multi-pane window renders split view with focus indicator and drag resize', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-split-desktop-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-split-desktop-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);

    // 打开即分屏：两 pane、一条垂直 gutter、恰好一个 active 标题栏（背景透明度区分焦点）
    await expect(page.getByTestId('split-terminal-area')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('split-pane')).toHaveCount(2);
    await expect(page.getByTestId('split-gutter')).toHaveCount(1);
    await expect(page.getByTestId('split-pane-titlebar')).toHaveCount(2);
    await expect(
      page.locator('[data-testid="split-pane-titlebar"][data-active]')
    ).toHaveCount(1);

    // 点击非焦点 pane：角标切换 + tmux active 同步
    const focusedBefore = await page
      .locator('[data-testid="split-pane"][data-focused]')
      .getAttribute('data-pane-id');
    const other = page.locator('[data-testid="split-pane"]:not([data-focused])').first();
    const otherPaneId = await other.getAttribute('data-pane-id');
    await other.click();
    await expect(
      page.locator(`[data-testid="split-pane"][data-focused][data-pane-id="${otherPaneId}"]`)
    ).toBeVisible({ timeout: 8000 });
    await expect
      .poll(() => tmux(`display-message -p -t ${sessionName} '#{pane_id}'`), { timeout: 8000 })
      .toBe(otherPaneId ?? '');
    expect(otherPaneId).not.toBe(focusedBefore);

    // 拖拽 gutter：两侧宽度互补变化
    const before = await waitForStablePaneWidths(sessionName);
    const gutter = page.locator('[data-testid="split-gutter"][data-axis="x"]').first();
    const box = await gutter.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 120, startY, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        () => {
          const after = paneWidths(sessionName);
          const shrunk = paneIds.some((id) => (after[id] ?? 0) < (before[id] ?? 0));
          const grown = paneIds.some((id) => (after[id] ?? 0) > (before[id] ?? 0));
          return shrunk && grown;
        },
        { timeout: 10000 }
      )
      .toBe(true);

    // 标题栏 split down：第三个 pane 出现且布局出现垂直排列
    await page.getByTestId('split-down-button').click();
    await expect(page.getByTestId('split-pane')).toHaveCount(3, { timeout: 15000 });
    await expect
      .poll(() => tmux(`display-message -p -t ${sessionName} '#{window_layout}'`))
      .toContain('[');
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
