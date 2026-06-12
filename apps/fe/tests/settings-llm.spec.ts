import { expect, test } from '@playwright/test';

interface MockProvider {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  models: string[];
  modelsFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockSettings {
  searchProvider: string;
  hasTavilyApiKey: boolean;
  hasBraveApiKey: boolean;
  defaultProviderId: string | null;
  defaultModelId: string | null;
  updatedAt: string;
}

test('settings: llm providers crud, defaults, search provider keys', async ({ page }) => {
  const providerName = `e2e-llm-${Date.now()}`;
  const providers: MockProvider[] = [];
  const settingsPatches: Array<Record<string, unknown>> = [];
  let providerSeq = 0;

  const settings: MockSettings = {
    searchProvider: 'none',
    hasTavilyApiKey: false,
    hasBraveApiKey: false,
    defaultProviderId: null,
    defaultModelId: null,
    updatedAt: new Date().toISOString(),
  };

  // LLM endpoints call real upstream APIs (model fetching). Mock to keep e2e deterministic.
  await page.route('**/api/llm/providers**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === 'GET' && url.pathname === '/api/llm/providers') {
      await route.fulfill({ status: 200, json: { providers } });
      return;
    }

    if (req.method() === 'POST' && url.pathname === '/api/llm/providers') {
      const body = req.postDataJSON() as {
        name?: string;
        protocol?: string;
        baseUrl?: string;
        apiKey?: string;
        enabled?: boolean;
      } | null;
      const now = new Date().toISOString();
      providerSeq += 1;
      const provider: MockProvider = {
        id: `e2e-llm-prov-${providerSeq}`,
        name: body?.name ?? `provider-${providerSeq}`,
        protocol: body?.protocol ?? 'openai-chat',
        baseUrl: body?.baseUrl ?? 'https://example.com/v1',
        hasApiKey: Boolean(body?.apiKey),
        enabled: body?.enabled ?? true,
        models: ['model-alpha', 'model-beta'],
        modelsFetchedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      providers.push(provider);
      await route.fulfill({ status: 201, json: { provider } });
      return;
    }

    const refreshMatch = url.pathname.match(/^\/api\/llm\/providers\/([^/]+)\/refresh-models$/);
    if (req.method() === 'POST' && refreshMatch) {
      const provider = providers.find((item) => item.id === refreshMatch[1]);
      if (!provider) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      provider.models = ['model-alpha', 'model-beta', 'model-gamma'];
      provider.modelsFetchedAt = new Date().toISOString();
      await route.fulfill({ status: 200, json: { models: provider.models } });
      return;
    }

    const idMatch = url.pathname.match(/^\/api\/llm\/providers\/([^/]+)$/);
    if (req.method() === 'PATCH' && idMatch) {
      const provider = providers.find((item) => item.id === idMatch[1]);
      if (!provider) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      const body = req.postDataJSON() as {
        name?: string;
        protocol?: string;
        baseUrl?: string;
        apiKey?: string;
        enabled?: boolean;
      } | null;
      if (body?.name !== undefined) provider.name = body.name;
      if (body?.protocol !== undefined) provider.protocol = body.protocol;
      if (body?.baseUrl !== undefined) provider.baseUrl = body.baseUrl;
      if (body?.apiKey) provider.hasApiKey = true;
      if (body?.enabled !== undefined) provider.enabled = body.enabled;
      provider.updatedAt = new Date().toISOString();
      await route.fulfill({ status: 200, json: { provider } });
      return;
    }

    if (req.method() === 'DELETE' && idMatch) {
      const index = providers.findIndex((item) => item.id === idMatch[1]);
      if (index >= 0) {
        providers.splice(index, 1);
      }
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/llm/settings', async (route) => {
    const req = route.request();

    if (req.method() === 'GET') {
      await route.fulfill({ status: 200, json: { settings } });
      return;
    }

    if (req.method() === 'PATCH') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      settingsPatches.push(body);
      if (typeof body.searchProvider === 'string') {
        settings.searchProvider = body.searchProvider;
      }
      if (body.defaultProviderId !== undefined) {
        settings.defaultProviderId = body.defaultProviderId as string | null;
      }
      if (body.defaultModelId !== undefined) {
        settings.defaultModelId = body.defaultModelId as string | null;
      }
      if (typeof body.tavilyApiKey === 'string') {
        settings.hasTavilyApiKey = body.tavilyApiKey.length > 0;
      }
      if (typeof body.braveApiKey === 'string') {
        settings.hasBraveApiKey = body.braveApiKey.length > 0;
      }
      settings.updatedAt = new Date().toISOString();
      await route.fulfill({ status: 200, json: { settings } });
      return;
    }

    await route.fallback();
  });

  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();

  // LLM tab: empty state, then create provider.
  await page.getByTestId('settings-tab-llm').click();
  await expect(page.getByTestId('llm-providers-section')).toBeVisible();
  await expect(page.getByTestId('llm-providers-empty')).toBeVisible();

  await page.getByTestId('llm-provider-name-input').fill(providerName);
  await page.getByTestId('llm-provider-baseurl-input').fill('https://example.com/v1');
  await page.getByTestId('llm-provider-apikey-input').fill('sk-e2e-dummy');
  await page.getByTestId('llm-provider-add').click();

  const providerCard = page.locator(`[data-provider-name="${providerName}"]`);
  await expect(providerCard).toBeVisible();

  // Stored apiKey is write-only: card input shows "already set" placeholder and stays empty.
  const cardApiKeyInput = providerCard.locator('[data-testid^="llm-provider-apikey-"]');
  await expect(cardApiKeyInput).toHaveAttribute('data-key-set', 'true');
  await expect(cardApiKeyInput).toHaveValue('');
  const placeholder = await cardApiKeyInput.getAttribute('placeholder');
  expect(placeholder).toBeTruthy();

  // Models cache is visible after expanding.
  await providerCard.locator('[data-testid^="llm-provider-toggle-models-"]').click();
  const modelsList = providerCard.locator('[data-testid^="llm-provider-models-"]');
  await expect(modelsList).toBeVisible();
  await expect(modelsList).toContainText('model-alpha');

  // Refresh models updates the cache.
  await providerCard.locator('[data-testid^="llm-provider-refresh-models-"]').click();
  await expect(modelsList).toContainText('model-gamma');

  // Global defaults: pick provider + type model id, then save.
  await page.getByTestId('llm-default-provider-select').click();
  await page.locator('[data-slot="select-content"]').getByText(providerName).click();
  await page.getByTestId('llm-default-model-input').fill('model-alpha');
  await page.getByTestId('llm-defaults-save').click();

  await expect
    .poll(() =>
      settingsPatches.some(
        (patch) =>
          patch.defaultProviderId === providers[0]?.id && patch.defaultModelId === 'model-alpha'
      )
    )
    .toBe(true);

  // Search tab: pick tavily and save key.
  await page.getByTestId('settings-tab-search').click();
  await expect(page.getByTestId('settings-search-section')).toBeVisible();

  await page.getByTestId('settings-search-provider-select').click();
  await page.locator('[data-slot="select-content"]').getByText('Tavily').click();
  await page.getByTestId('settings-search-tavily-input').fill('tavily-e2e-key');
  await page.getByTestId('settings-search-save').click();

  await expect
    .poll(() =>
      settingsPatches.some(
        (patch) => patch.searchProvider === 'tavily' && patch.tavilyApiKey === 'tavily-e2e-key'
      )
    )
    .toBe(true);

  // Saved key shows "already set" placeholder with empty value, then clear it.
  const tavilyInput = page.getByTestId('settings-search-tavily-input');
  await expect(tavilyInput).toHaveAttribute('data-key-set', 'true');
  await expect(tavilyInput).toHaveValue('');

  await page.getByTestId('settings-search-tavily-clear').click();
  await page.getByTestId('settings-search-clear-confirm').click();
  await expect.poll(() => settingsPatches.some((patch) => patch.tavilyApiKey === '')).toBe(true);
  await expect(tavilyInput).toHaveAttribute('data-key-set', 'false');

  // Delete provider via confirm dialog.
  await page.getByTestId('settings-tab-llm').click();
  await providerCard.locator('[data-testid^="llm-provider-delete-"]').first().click();
  await page.locator('[data-testid^="llm-provider-delete-confirm-"]').click();
  await expect(providerCard).toHaveCount(0);
});
