import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
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

async function readViewportY(page: Page): Promise<number> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    return term?.buffer?.active?.viewportY ?? 0;
  });
}

async function readBaseY(page: Page): Promise<number> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    return term?.buffer?.active?.baseY ?? 0;
  });
}

async function scrollViewportToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    term?.scrollToTop?.();
  });
}

function launchVimWithMouse(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'clear'`);
  tmux(`send-keys -t ${paneId} C-m`);
  tmux(`send-keys -t ${paneId} -l 'vim -Nu NONE -n -c "set mouse=a"'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function exitVim(paneId: string): void {
  tmux(`send-keys -t ${paneId} Escape`);
  tmux(`send-keys -t ${paneId} -l ':qa!'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function emitScrollback(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'for i in $(seq 1 120); do echo TMEX_SSH_SCROLL_$i; done'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function launchOpencode(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'clear'`);
  tmux(`send-keys -t ${paneId} C-m`);
  tmux(`send-keys -t ${paneId} -l 'opencode .'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function normalizeTerminalText(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/\n/)
    .map((line) => line.replace(/\s+$/u, '').trim())
    .filter((line) => line.length >= 2 && line !== 'sh-3.2$ opencode .');
}

function captureVisiblePaneText(paneId: string): string {
  return tmux(`capture-pane -t ${paneId} -p -S - -E -`);
}

async function expectNoOpencodeLaunchPrompt(page: Page): Promise<void> {
  await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).not.toContain(
    'sh-3.2$ opencode .'
  );
}

async function createLocalhostSshDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<{ id: string }> {
  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'ssh',
      sshConfigRef: 'localhost',
      session: sessionName,
      authMode: 'configRef',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };

  const probeRes = await request.post(`/api/devices/${created.device.id}/test-connection`);
  expect(probeRes.ok()).toBeTruthy();
  const probe = (await probeRes.json()) as { success: boolean; tmuxAvailable: boolean; phase: string };
  expect(probe.success).toBe(true);
  expect(probe.tmuxAvailable).toBe(true);
  expect(probe.phase).toBe('ready');

  return created.device;
}

async function expectRenderedTextToTrackPane(page: Page, paneId: string): Promise<void> {
  await expect
    .poll(async () => {
      const rendered = normalizeTerminalText(await readVisibleTerminalText(page));
      const actual = normalizeTerminalText(captureVisiblePaneText(paneId));
      if (actual.length === 0) {
        return 1;
      }

      const renderedSet = new Set(rendered);
      const overlap = actual.filter((line) => renderedSet.has(line)).length;
      return overlap / actual.length;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0.6);
}

test('ssh: opencode refresh keeps restored TUI aligned with the live pane', async ({ page, request }) => {
  const sessionName = `tmex-e2e-ssh-opencode-refresh-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(targetPaneId).toBeTruthy();
  launchOpencode(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const device = await createLocalhostSshDevice(
    request,
    sessionName,
    `e2e-ssh-opencode-refresh-${Date.now()}`
  );
  const targetPath = `/devices/${device.id}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId ?? '')}`;

  try {
    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expectNoOpencodeLaunchPrompt(page);
    await expectRenderedTextToTrackPane(page, targetPaneId);

    await page.reload();

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expectNoOpencodeLaunchPrompt(page);
    await expectRenderedTextToTrackPane(page, targetPaneId);
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});

test('ssh: opencode pane round-trip keeps restored TUI aligned with the live pane', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-ssh-opencode-pane-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const shellPaneId = paneIds[0];
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(shellPaneId).toBeTruthy();
  expect(targetPaneId).toBeTruthy();
  launchOpencode(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const device = await createLocalhostSshDevice(
    request,
    sessionName,
    `e2e-ssh-opencode-pane-${Date.now()}`
  );
  const targetPath = `/devices/${device.id}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId ?? '')}`;
  const shellPath = `/devices/${device.id}/windows/${windowId}/panes/${encodeURIComponent(shellPaneId ?? '')}`;

  try {
    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expectNoOpencodeLaunchPrompt(page);
    await expectRenderedTextToTrackPane(page, targetPaneId);

    await page.goto(shellPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('PANE0_READY');

    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expectNoOpencodeLaunchPrompt(page);
    await expectRenderedTextToTrackPane(page, targetPaneId);
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});

test('ssh: vim exit restores wheel scrolling after refresh restore', async ({ page, request }) => {
  const sessionName = `tmex-e2e-ssh-vim-exit-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(targetPaneId).toBeTruthy();
  launchVimWithMouse(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const device = await createLocalhostSshDevice(
    request,
    sessionName,
    `e2e-ssh-vim-exit-${Date.now()}`
  );
  const targetPath = `/devices/${device.id}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId ?? '')}`;

  try {
    await page.goto(targetPath);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');

    await page.reload();

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('~');

    exitVim(targetPaneId);

    await expect
      .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
      .toBe('0');

    emitScrollback(targetPaneId);
    await expect.poll(() => readBaseY(page), { timeout: 20_000 }).toBeGreaterThan(20);

    await scrollViewportToTop(page);
    const before = await readViewportY(page);
    await page.locator('.xterm').hover();
    await page.mouse.wheel(0, 1200);

    await expect.poll(() => readViewportY(page), { timeout: 5_000 }).toBeGreaterThan(before);
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
