import { expect, test, type Page } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';
import { KIND, decodeEnvelope, decodeTermInput } from './helpers/ws-borsh';

function launchVimWithMouse(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'clear'`);
  tmux(`send-keys -t ${paneId} C-m`);
  tmux(`send-keys -t ${paneId} -l 'vim -Nu NONE -n -c "set mouse=a"'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

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
      lines.push(line ? line.translateToString(false) : '');
    }
    return lines.join('\n');
  });
}

test('desktop: sidebar new-window click does not inject SGR mouse sequences into pty', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-sidebar-no-inject-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const vimPaneId = paneIds[1] ?? paneIds[0];
  expect(vimPaneId).toBeTruthy();
  launchVimWithMouse(vimPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-sidebar-no-inject-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const vimPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(vimPaneId ?? '')}`;

  const sgrInjections: string[] = [];
  let createWindowSent = 0;

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TERM_INPUT) {
        try {
          const decoded = decodeTermInput(envelope.payload);
          const text = decoded.data.toString('binary');
          if (text.includes('\x1b[<')) {
            sgrInjections.push(text);
          }
        } catch {
          // ignore malformed frames
        }
      }
      if (envelope.kind === KIND.TMUX_CREATE_WINDOW) {
        createWindowSent += 1;
      }
    });
  });

  try {
    await page.goto(vimPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');

    await page.waitForTimeout(500);
    sgrInjections.length = 0;

    const createButton = page.locator(`[data-testid="window-create-${deviceId}"]`);
    await expect(createButton).toBeVisible();
    await createButton.click();

    await expect.poll(() => createWindowSent, { timeout: 5_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(300);

    expect(sgrInjections, `unexpected SGR injections: ${JSON.stringify(sgrInjections)}`).toEqual([]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
