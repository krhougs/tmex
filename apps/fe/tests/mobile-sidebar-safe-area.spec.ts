import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile: sidebar hides scrollbar and covers safe area', async ({ page, request }) => {
  const deviceIds: string[] = [];
  const batchKey = `e2e-sidebar-scroll-${Date.now()}`;

  for (let i = 0; i < 32; i += 1) {
    const createRes = await request.post('/api/devices', {
      data: {
        name: `${batchKey}-${String(i).padStart(2, '0')}`,
        type: 'local',
        session: 'tmex',
        authMode: 'auto',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { device: { id: string } };
    deviceIds.push(created.device.id);
  }

  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible();

  const coarsePointer = await page.evaluate(() => window.matchMedia('(any-pointer: coarse)').matches);
  expect(coarsePointer).toBeTruthy();

  await page.getByTestId('mobile-sidebar-open').click();
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByTestId(`device-item-${deviceIds[0]}`)).toBeVisible();

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--tmex-safe-area-bottom', '24px');
  });
  const paddingBottom = await sidebar.evaluate((el) => getComputedStyle(el).paddingBottom);
  expect(paddingBottom).toBe('24px');

  const scrollBar = sidebar.locator(
    '[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]'
  );
  await expect(scrollBar).toHaveCount(1);
  await expect(scrollBar).toHaveClass(/\[@media\(any-pointer:coarse\)\]:hidden/);
  await expect(scrollBar).toBeHidden();

  await Promise.all(deviceIds.map((id) => request.delete(`/api/devices/${id}`)));
});
