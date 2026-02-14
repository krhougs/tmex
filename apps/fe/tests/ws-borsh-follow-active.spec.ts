import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

test('ws-borsh: follows tmux pane-active event to latest pane', async ({ page, request }) => {
  const sessionName = `tmex-e2e-follow-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const firstPane = paneIds[0];
  const secondPane = paneIds[1];

  const name = `e2e-borsh-follow-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect(page.getByTestId(`pane-item-${firstPane}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`pane-item-${secondPane}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId(`pane-item-${firstPane}`).click();
    await expect(page).toHaveURL(new RegExp(`/devices/${deviceId}/windows/.+/panes/${encodeURIComponent(firstPane)}$`));

    tmux(`select-pane -t ${secondPane}`);

    await expect(page).toHaveURL(
      new RegExp(`/devices/${deviceId}/windows/.+/panes/${encodeURIComponent(secondPane)}$`),
      { timeout: 20_000 }
    );
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

