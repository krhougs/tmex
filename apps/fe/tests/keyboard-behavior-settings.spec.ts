import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

// 大屏（触屏 PC / iPad 形态）：设置入口必须在所有屏幕可见，底部 Sheet 需居中限宽不变形。
test.use({ viewport: { width: 1024, height: 768 } });

test('keyboard behavior settings: entry visible on large screens, sheet selects + persists', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-kb-ui-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const name = `e2e-kb-ui-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    // 入口在大屏（非移动端）也可见
    const entry = page.getByTestId('keyboard-behavior-open-button');
    await expect(entry).toBeVisible();

    await entry.click();
    const sheet = page.getByTestId('keyboard-behavior-sheet');
    await expect(sheet).toBeVisible();

    // 三个模式都在；默认 follow 被选中
    const liftOption = page.getByTestId('keyboard-behavior-option-lift');
    const resizeOption = page.getByTestId('keyboard-behavior-option-resize');
    const followOption = page.getByTestId('keyboard-behavior-option-follow');
    await expect(liftOption).toBeVisible();
    await expect(resizeOption).toBeVisible();
    await expect(followOption).toBeVisible();
    await expect(followOption).toHaveAttribute('aria-pressed', 'true');

    await page.screenshot({ path: '/tmp/kb-sheet-large.png' });

    // 选「终端缩放」即时生效：选中态切换 + 持久化到 localStorage
    await resizeOption.click();
    await expect(resizeOption).toHaveAttribute('aria-pressed', 'true');
    await expect(followOption).toHaveAttribute('aria-pressed', 'false');

    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('tmex-ui');
      return raw ? (JSON.parse(raw).state?.keyboardBehaviorMode ?? null) : null;
    });
    expect(persisted).toBe('resize');

    // 大屏 Sheet 居中限宽：宽度远小于视口、左右大致对称居中
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeLessThan(700);
      const leftGap = box.x;
      const rightGap = 1024 - (box.x + box.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThan(24);
    }
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
