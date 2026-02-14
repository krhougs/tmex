import { expect, test } from '@playwright/test';
import { KIND, decodeEnvelope, decodeTermInput } from './helpers/ws-borsh';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile: editor interactions keep focus and send ws messages', async ({ page, request }) => {
  const sessionName = `tmex-e2e-mobile-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-term-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const sentInputs: Array<{ deviceId: string; data: string }> = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TERM_INPUT) return;
      const decoded = decodeTermInput(envelope.payload);
      sentInputs.push({ deviceId: decoded.deviceId, data: decoded.data.toString('utf8') });
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('mobile-topbar')).toBeVisible();

    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    await page.getByTestId('terminal-input-mode-toggle').click();
    const editorInput = page.getByTestId('editor-input');
    await expect(editorInput).toBeVisible();
    await editorInput.fill('echo hello');
    await expect(editorInput).toBeFocused();

    await page.getByTestId('editor-shortcut-ctrl-c').click();
    await expect(editorInput).toBeFocused();
    await expect.poll(() => {
      return sentInputs.some((msg) => msg.deviceId === deviceId && msg.data === '\u0003');
    }).toBeTruthy();

    await page.getByTestId('editor-send').click();
    await expect(editorInput).toBeFocused();
    await expect(editorInput).toHaveValue('');
    await expect.poll(() => {
      return sentInputs.some((msg) => msg.deviceId === deviceId && msg.data === 'echo hello\r');
    }).toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
