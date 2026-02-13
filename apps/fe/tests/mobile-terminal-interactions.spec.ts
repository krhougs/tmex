import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile: editor interactions keep focus and send ws messages', async ({ page, request }) => {
  const name = `e2e-mobile-term-${Date.now()}`;

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
  const deviceId = created.device.id;

  const sentMessages: Array<{ type?: string; payload?: Record<string, unknown> }> = [];

  await page.routeWebSocket('/ws', (ws) => {
    ws.onMessage((message) => {
      const raw = typeof message === 'string' ? message : message.toString();

      let parsed: { type?: string; payload?: Record<string, unknown> } | null = null;
      try {
        parsed = JSON.parse(raw) as { type?: string; payload?: Record<string, unknown> };
      } catch {
        parsed = null;
      }

      if (parsed) {
        sentMessages.push(parsed);

        if (parsed.type === 'device/connect' && parsed.payload?.deviceId) {
          ws.send(
            JSON.stringify({
              type: 'device/connected',
              payload: { deviceId: parsed.payload.deviceId },
              timestamp: new Date().toISOString(),
            })
          );
        }
      }
    });
  });

  await page.goto(`/devices/${deviceId}/windows/w0/panes/p0`);
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible();

  await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled();

  await page.getByTestId('terminal-input-mode-toggle').click();
  const editorInput = page.getByTestId('editor-input');
  await expect(editorInput).toBeVisible();
  await editorInput.fill('echo hello');
  await expect(editorInput).toBeFocused();

  await page.getByTestId('editor-shortcut-ctrl-c').click();
  await expect(editorInput).toBeFocused();
  await expect.poll(() => {
    return sentMessages.some((msg) => {
      if (msg.type !== 'term/input') return false;
      if (msg.payload?.deviceId !== deviceId) return false;
      return msg.payload?.data === '\u0003';
    });
  }).toBeTruthy();

  await page.getByTestId('editor-send').click();
  await expect(editorInput).toBeFocused();
  await expect(editorInput).toHaveValue('');
  await expect.poll(() => {
    return sentMessages.some((msg) => {
      if (msg.type !== 'term/input') return false;
      if (msg.payload?.deviceId !== deviceId) return false;
      return msg.payload?.data === 'echo hello\r';
    });
  }).toBeTruthy();

  await request.delete(`/api/devices/${deviceId}`);
});

