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

async function readCanvasInkRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-terminal-engine] canvas') as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return 0;
    }

    const { width, height } = canvas;
    const sample = ctx.getImageData(0, 0, width, height).data;
    const bgR = sample[0] ?? 0;
    const bgG = sample[1] ?? 0;
    const bgB = sample[2] ?? 0;
    let painted = 0;
    let total = 0;

    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const r = sample[index] ?? 0;
        const g = sample[index + 1] ?? 0;
        const b = sample[index + 2] ?? 0;
        const a = sample[index + 3] ?? 0;
        const distance = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (a > 0 && distance > 24) {
          painted += 1;
        }
        total += 1;
      }
    }

    return total === 0 ? 0 : painted / total;
  });
}

async function clearTerminalCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-terminal-engine] canvas') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

function exitVim(paneId: string): void {
  tmux(`send-keys -t ${paneId} Escape`);
  tmux(`send-keys -t ${paneId} -l ':qa!'`);
  tmux(`send-keys -t ${paneId} C-m`);
}

function emitScrollback(paneId: string): void {
  tmux(`send-keys -t ${paneId} C-c`);
  tmux(`send-keys -t ${paneId} -l 'for i in $(seq 1 120); do echo TMEX_SCROLL_$i; done'`);
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

test('desktop: vim exit releases mouse wheel back to viewport scrolling after refresh restore', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-vim-exit-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const vimPaneId = paneIds[1] ?? paneIds[0];
  expect(vimPaneId).toBeTruthy();
  launchVimWithMouse(vimPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-vim-exit-${Date.now()}`;
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

    exitVim(vimPaneId);

    await expect
      .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
      .toBe('0');

    emitScrollback(vimPaneId);

    await expect.poll(() => readBaseY(page), { timeout: 20_000 }).toBeGreaterThan(20);

    await scrollViewportToTop(page);
    const before = await readViewportY(page);
    await page.locator('.xterm').hover();
    await page.mouse.wheel(0, 1200);

    await expect.poll(() => readViewportY(page), { timeout: 5_000 }).toBeGreaterThan(before);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: vim exit releases mouse wheel back to viewport scrolling without refresh', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-vim-exit-direct-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const vimPaneId = paneIds[1] ?? paneIds[0];
  expect(vimPaneId).toBeTruthy();
  launchVimWithMouse(vimPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-vim-exit-direct-${Date.now()}`;
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

    exitVim(vimPaneId);

    await expect
      .poll(() => tmux(`display-message -p -t ${vimPaneId} '#{alternate_on}'`), { timeout: 20_000 })
      .toBe('0');

    emitScrollback(vimPaneId);

    await expect.poll(() => readBaseY(page), { timeout: 20_000 }).toBeGreaterThan(20);

    await scrollViewportToTop(page);
    const before = await readViewportY(page);
    await page.locator('.xterm').hover();
    await page.mouse.wheel(0, 1200);

    await expect.poll(() => readViewportY(page), { timeout: 5_000 }).toBeGreaterThan(before);
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

test('desktop: focus restore repaints a cleared terminal canvas even when terminal size is unchanged', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-opencode-focus-repaint-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[1] ?? paneIds[0];
  expect(targetPaneId).toBeTruthy();
  launchOpencode(targetPaneId);

  await expect
    .poll(() => tmux(`display-message -p -t ${targetPaneId} '#{alternate_on}'`), { timeout: 20_000 })
    .toBe('1');

  const name = `e2e-opencode-focus-repaint-${Date.now()}`;
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
    await expect.poll(() => readCanvasInkRatio(page), { timeout: 20_000 }).toBeGreaterThan(0.01);
    const baseline = await readCanvasInkRatio(page);

    await clearTerminalCanvas(page);
    await expect.poll(() => readCanvasInkRatio(page), { timeout: 5_000 }).toBeLessThan(0.002);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    await expect.poll(() => readCanvasInkRatio(page), { timeout: 5_000 }).toBeGreaterThan(baseline * 0.8);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
