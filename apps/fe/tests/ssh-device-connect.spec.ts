import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}

async function resolveTargetDevice(
  request: APIRequestContext,
  gatewayUrl: string,
  targetName: string
): Promise<{ id: string; name: string }> {
  const response = await request.get(`${gatewayUrl}/api/devices`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    devices: Array<{ id: string; name: string; type: string }>;
  };

  const matches = payload.devices.filter((device) => device.type === 'ssh' && device.name === targetName);
  if (matches.length === 0) {
    throw new Error(`device target "${targetName}" not found`);
  }
  if (matches.length > 1) {
    throw new Error(`device target "${targetName}" matched ${matches.length} devices`);
  }
  const [match] = matches;
  if (!match) {
    throw new Error(`device target "${targetName}" not found after filtering`);
  }

  return match;
}

test('ssh device: probe and runtime connect are parameterized by target name', async ({
  page,
  request,
}) => {
  const targetName = process.env.TMEX_E2E_SSH_DEVICE_NAME?.trim();
  test.skip(!targetName, 'requires TMEX_E2E_SSH_DEVICE_NAME');
  if (!targetName) {
    return;
  }
  const gatewayPort = process.env.TMEX_E2E_GATEWAY_PORT?.trim() || '9663';
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  const target = await resolveTargetDevice(request, gatewayUrl, targetName);
  const probeResponse = await request.post(`${gatewayUrl}/api/devices/${target.id}/test-connection`);
  expect(probeResponse.ok()).toBeTruthy();
  const probePayload = (await probeResponse.json()) as {
    success: boolean;
    tmuxAvailable: boolean;
    phase: string;
    rawMessage?: string;
  };
  expect(probePayload.success).toBe(true);
  expect(probePayload.tmuxAvailable).toBe(true);
  expect(probePayload.phase).toBe('ready');

  const marker = `__TMEX_SSH_SMOKE_${Date.now()}__`;
  await page.goto(`/devices/${target.id}`);
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).__tmexE2eXterm)), { timeout: 30_000 })
    .toBeTruthy();

  await page.locator('.xterm').click();
  await page.keyboard.type(`printf "${marker}\\n"`);
  await page.keyboard.press('Enter');

  await expect.poll(() => readVisibleTerminalText(page), { timeout: 30_000 }).toContain(marker);
});
