import { expect, test } from '@playwright/test';

test('device: terminal ui renders and editor input toggles', async ({ page, request }) => {
  const name = `e2e-terminal-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: 'tmex',
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };

  await page.goto(`/devices/${created.device.id}`);
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          return (window as any).__tmexE2eTerminalEngine ?? null;
        }),
      { timeout: 20_000 }
    )
    .toBe('ghostty-official');
  await expect(page.locator('[data-terminal-engine="ghostty-official"]')).toBeVisible();

  await page.getByTestId('terminal-input-mode-toggle').click();
  await expect(page.getByTestId('editor-input')).toBeVisible();

  // Cleanup.
  await request.delete(`/api/devices/${created.device.id}`);
});
