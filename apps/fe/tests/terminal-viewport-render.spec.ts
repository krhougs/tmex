import { expect, test, type Page } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}

test('desktop: visible terminal should follow the latest viewport contents', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-viewport-render-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-viewport-render-${Date.now()}`;
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

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    tmux(
      `send-keys -t ${sessionName}.0 "for i in \\$(seq 1 120); do echo TMEX_VIEWPORT_LATEST_\\$i; done" C-m`
    );

    await expect
      .poll(() =>
        page.evaluate(() => {
          const term = (window as any).__tmexE2eXterm;
          return term?.buffer?.active?.baseY ?? 0;
        })
      )
      .toBeGreaterThan(50);

    await page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      term?.scrollToBottom();
    });

    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain('TMEX_VIEWPORT_LATEST_120');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: direct input should become visible in the current viewport', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-desktop-input-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-desktop-input-${Date.now()}`;
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
  const marker = `TMEX_DESKTOP_INPUT_${Date.now()}`;

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    await page.locator('.xterm').click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');

    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain(marker);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
