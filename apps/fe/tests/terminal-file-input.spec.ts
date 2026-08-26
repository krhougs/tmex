import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, test, type Page } from '@playwright/test';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

async function createDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<string> {
  const response = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(response.ok()).toBeTruthy();
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('device' in payload)) {
    throw new Error('device create response is missing device');
  }
  const device = payload.device;
  if (!device || typeof device !== 'object' || !('id' in device) || typeof device.id !== 'string') {
    throw new Error('device create response is missing device.id');
  }
  return device.id;
}

async function waitForTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('[data-terminal-engine]').first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () => page.evaluate(() => Boolean(document.querySelector('[data-terminal-engine] canvas'))),
      { timeout: 20_000 }
    )
    .toBe(true);
}

async function fileTransfer(page: Page, name: string, type: string, body: string) {
  return page.evaluateHandle(
    ({ fileName, mimeType, contents }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([contents], fileName, { type: mimeType }));
      return transfer;
    },
    { fileName: name, mimeType: type, contents: body }
  );
}

test('terminal file drop shows target state and confirms unknown formats before transfer', async ({
  page,
  request,
}) => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-terminal-files-')));
  const sessionName = `tmex-e2e-terminal-files-${Date.now()}`;
  createSinglePaneSession(sessionName);
  const quotedSandbox = sandbox.replaceAll("'", "'\\''");
  tmux(`send-keys -t ${sessionName} "cd '${quotedSandbox}'" C-m`);
  const deviceId = await createDevice(request, sessionName, `e2e-terminal-files-${Date.now()}`);
  const rootResponse = await request.post('/api/files/roots', {
    data: { deviceId, path: sandbox, enabled: true },
  });
  expect(rootResponse.ok()).toBeTruthy();

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForTerminal(page);
    const terminal = page.locator('[data-terminal-engine]').first();

    const cancelledTransfer = await fileTransfer(
      page,
      'untrusted.zip',
      'application/zip',
      'not-a-real-archive'
    );
    await terminal.dispatchEvent('dragenter', { dataTransfer: cancelledTransfer });
    await expect(page.getByTestId('terminal-file-drop-overlay')).toContainText(
      'Release to transfer files to this terminal'
    );
    await terminal.dispatchEvent('drop', { dataTransfer: cancelledTransfer });
    const riskDialog = page.getByTestId('terminal-file-risk-dialog');
    await expect(riskDialog).toBeVisible();
    await expect(riskDialog).toContainText('untrusted.zip');
    await riskDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(riskDialog).toBeHidden();
    expect(existsSync(join(sandbox, 'untrusted.zip'))).toBe(false);

    const confirmedTransfer = await fileTransfer(
      page,
      'untrusted.zip',
      'application/zip',
      'not-a-real-archive'
    );
    await terminal.dispatchEvent('dragenter', { dataTransfer: confirmedTransfer });
    await terminal.dispatchEvent('drop', { dataTransfer: confirmedTransfer });
    await page.getByTestId('terminal-file-risk-confirm').click();

    await expect
      .poll(() => existsSync(join(sandbox, 'untrusted.zip')), { timeout: 20_000 })
      .toBe(true);
    expect(readFileSync(join(sandbox, 'untrusted.zip'), 'utf8')).toBe('not-a-real-archive');
    await expect
      .poll(() => tmux(`capture-pane -p -t ${sessionName}`), { timeout: 15_000 })
      .toContain("'untrusted.zip'");
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
