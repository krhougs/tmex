import { expect, test } from '@playwright/test';

test('settings: theme toggle, telegram bot crud, webhook crud, language save/reset', async ({
  page,
}) => {
  const botName = `e2e-bot-${Date.now()}`;
  const webhookUrl = `https://example.com/e2e-webhook-${Date.now()}`;
  const webhookSecret = `secret-${Date.now()}`;

  // Telegram endpoints call real Telegram APIs. Mock to keep e2e deterministic.
  const bots: Array<{
    id: string;
    name: string;
    enabled: boolean;
    allowAuthRequests: boolean;
    createdAt: string;
    updatedAt: string;
    pendingCount: number;
    authorizedCount: number;
  }> = [];

  await page.route('**/api/settings/telegram/bots**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === 'GET' && url.pathname === '/api/settings/telegram/bots') {
      await route.fulfill({ status: 200, json: { bots } });
      return;
    }

    if (req.method() === 'POST' && url.pathname === '/api/settings/telegram/bots') {
      const body = req.postDataJSON() as {
        name?: string;
        enabled?: boolean;
        allowAuthRequests?: boolean;
      } | null;
      const now = new Date().toISOString();
      const id = `e2e-${Date.now()}`;
      bots.push({
        id,
        name: body?.name ?? id,
        enabled: body?.enabled ?? true,
        allowAuthRequests: body?.allowAuthRequests ?? true,
        createdAt: now,
        updatedAt: now,
        pendingCount: 0,
        authorizedCount: 0,
      });
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    if (req.method() === 'DELETE' && url.pathname.startsWith('/api/settings/telegram/bots/')) {
      const botId = url.pathname.split('/')[5];
      const index = bots.findIndex((bot) => bot.id === botId);
      if (index >= 0) {
        bots.splice(index, 1);
      }
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    if (req.method() === 'GET' && url.pathname.includes('/chats')) {
      await route.fulfill({ status: 200, json: { chats: [] } });
      return;
    }

    if (req.method() === 'POST' || req.method() === 'PATCH') {
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    await route.fallback();
  });

  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();

  // Theme toggle should flip the root class.
  const html = page.locator('html');
  const themeToggle = page.getByTestId('settings-theme-toggle');
  await themeToggle.click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await themeToggle.click();
  await expect(html).toHaveClass(/\bdark\b/);

  // Create a Telegram bot (uses server persistence).
  await page.locator('#new-bot-name').fill(botName);
  await page.locator('#new-bot-token').fill('dummy-token');
  await page.getByTestId('telegram-add-bot').click();

  const botCard = page.locator(`[data-bot-name="${botName}"]`);
  await expect(botCard).toBeVisible();

  await botCard.locator(`[data-testid^="telegram-bot-delete-"]`).click();
  await expect(botCard).toHaveCount(0);

  // Create + delete webhook (real backend).
  await page.getByTestId('webhook-url-input').fill(webhookUrl);
  await page.getByTestId('webhook-secret-input').fill(webhookSecret);
  await page.getByTestId('webhook-add').click();

  const webhookItem = page.locator(
    `[data-testid="webhook-item"][data-webhook-url="${webhookUrl}"]`
  );
  await expect(webhookItem).toBeVisible();
  await webhookItem.getByTestId('webhook-delete').click();
  await expect(webhookItem).toHaveCount(0);

  // Change language and verify refresh notice, then reset language to keep later tests stable.
  await page.getByTestId('settings-language-select').click();
  await page.locator('[data-slot="select-content"]').getByText('简体中文').click();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-refresh-notice')).toBeVisible();

  await page.getByTestId('settings-language-select').click();
  await page.locator('[data-slot="select-content"]').getByText('English').click();
  await page.getByTestId('settings-save').click();
});
