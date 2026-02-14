import { expect, test } from '@playwright/test';
import { KIND, decodeEnvelope } from './helpers/ws-borsh';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

test('ws-borsh: resize does not spam TERM_RESIZE frames', async ({ page, request }) => {
  const sessionName = `tmex-e2e-resize-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  let resizeCount = 0;

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TERM_RESIZE) {
        resizeCount += 1;
      }
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();

    resizeCount = 0;

    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(800);

    expect(resizeCount <= 3).toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

