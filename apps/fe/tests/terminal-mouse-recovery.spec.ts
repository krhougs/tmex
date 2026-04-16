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
      lines.push(line ? line.translateToString(false) : '');
    }
    return lines.join('\n');
  });
}

function launchVimWithMouse(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'clear'`);
  tmux(`send-keys -t ${paneId} C-m`);
  tmux(`send-keys -t ${paneId} -l 'vim -Nu NONE -n -c "set mouse=a"'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function launchOpencode(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'clear'`);
  tmux(`send-keys -t ${paneId} C-m`);
  tmux(`send-keys -t ${paneId} -l 'opencode .'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

test('desktop: vim alternate screen survives page refresh with content and mouse modes restored', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-vim-refresh-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const vimPaneId = paneIds[1] ?? paneIds[0];
  expect(vimPaneId).toBeTruthy();
  launchVimWithMouse(vimPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-vim-refresh-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const vimPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(vimPaneId ?? '')}`;

  try {
    await page.goto(vimPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');

    await page.reload();

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: vim mouse modes survive pane round-trip navigation', async ({ page, request }) => {
  const sessionName = `tmex-e2e-vim-pane-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const shellPaneId = paneIds[0];
  const vimPaneId = paneIds[1] ?? paneIds[0];
  expect(shellPaneId).toBeTruthy();
  expect(vimPaneId).toBeTruthy();
  launchVimWithMouse(vimPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-vim-pane-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const vimPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(vimPaneId ?? '')}`;
  const shellPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(shellPaneId ?? '')}`;

    try {
      await page.goto(vimPath);
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');

      await page.goto(shellPath);
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('PANE0_READY');

      await page.goto(vimPath);
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');
    } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: opencode refresh should not render pre-launch normal screen', async ({ page, request }) => {
  const sessionName = `tmex-e2e-opencode-refresh-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(targetPaneId).toBeTruthy();
  launchOpencode(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-opencode-refresh-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const targetPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId ?? '')}`;

  try {
    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).not.toContain('sh-3.2$ opencode .');

    await page.reload();

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).not.toContain('sh-3.2$ opencode .');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: opencode pane round-trip should not render pre-launch normal screen', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-opencode-pane-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const shellPaneId = paneIds[0];
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(shellPaneId).toBeTruthy();
  expect(targetPaneId).toBeTruthy();
  launchOpencode(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-opencode-pane-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const targetPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId ?? '')}`;
  const shellPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(shellPaneId ?? '')}`;

  try {
    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).not.toContain('sh-3.2$ opencode .');

    await page.goto(shellPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('PANE0_READY');

    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).not.toContain('sh-3.2$ opencode .');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
