import { type APIRequestContext, expect, test, type Page } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

const PASTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

async function createDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<string> {
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
  return created.device.id;
}

async function waitForCanvasTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => Boolean(document.querySelector('.xterm canvas'))),
      { timeout: 20_000 }
    )
    .toBe(true);
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) {
      return '';
    }

    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(false) : '');
    }

    return lines.join('\n');
  });
}

async function focusTerminal(page: Page): Promise<void> {
  await page.locator('.xterm').first().click();
}

test('desktop: paste shortcut should deliver clipboard text to the terminal', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-clipboard-paste-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName, `e2e-clipboard-paste-${Date.now()}`);

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('echo paste_marker_123');
    });

    await focusTerminal(page);
    await page.keyboard.press(PASTE_SHORTCUT);

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 15_000 }).toContain(
      'echo paste_marker_123'
    );
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: Ctrl+C should interrupt the foreground process', async ({ page, request }) => {
  const sessionName = `tmex-e2e-clipboard-sigint-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName, `e2e-clipboard-sigint-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    tmux(`send-keys -t ${sessionName}.0 "sleep 60" C-m`);
    await page.waitForTimeout(500);

    await focusTerminal(page);
    await page.keyboard.press('Control+C');

    await focusTerminal(page);
    await page.keyboard.type('echo intr_done_456');
    await page.keyboard.press('Enter');

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 15_000 }).toContain(
      'intr_done_456'
    );
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: Ctrl+B inside terminal should not toggle the sidebar', async ({ page, request }) => {
  const sessionName = `tmex-e2e-clipboard-prefix-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName, `e2e-clipboard-prefix-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
    const stateBefore = await sidebar.getAttribute('data-state');
    expect(stateBefore).toBeTruthy();

    await focusTerminal(page);
    await page.keyboard.press('Control+B');
    await page.waitForTimeout(300);

    expect(await sidebar.getAttribute('data-state')).toBe(stateBefore);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
