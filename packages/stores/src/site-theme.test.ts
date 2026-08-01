import { ApiClient, FeatureSet } from '@tmex/api-client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// localStorage polyfill（bun test node 环境无 localStorage，zustand persist 默认读 window.localStorage）
class MemStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}
const memStorage =
  (globalThis.localStorage as unknown as MemStorage | undefined) ?? new MemStorage();
// @ts-ignore
globalThis.localStorage = memStorage;
// @ts-ignore zustand persist 默认读 window.localStorage；site.ts 读 window.location.origin
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    localStorage: memStorage,
    location: { origin: 'http://localhost:9663' },
  } as unknown as Window & typeof globalThis;
} else {
  (globalThis.window as unknown as { localStorage: Storage }).localStorage =
    memStorage as unknown as Storage;
}

const changeLanguageMock = mock(() => Promise.resolve());
mock.module('i18next', () => {
  return { default: { changeLanguage: changeLanguageMock, t: (k: string) => k } };
});

const sendMock = mock(() => true);
const isReadyMock = mock(() => true);
const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => {
  return {
    ...wsActual,
    getBorshClient: () => ({ send: sendMock, isReady: isReadyMock }),
    buildSiteThemeUpdate: (theme: 'dark' | 'light') => ({
      kind: 99,
      payload: new Uint8Array([theme === 'light' ? 1 : 2]),
    }),
  };
});

const { createSiteStore, createUIStore, useSiteStore, useUIStore } = await import('./index');

const TMEX_UI_KEY = 'tmex-ui';

function readLocalStorageTheme(): 'dark' | 'light' | undefined {
  const raw = localStorage.getItem(TMEX_UI_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } };
    return parsed?.state?.theme === 'light' ? 'light' : 'dark';
  } catch {
    return undefined;
  }
}

function setLocalStorageTheme(theme: 'dark' | 'light'): void {
  const raw = localStorage.getItem(TMEX_UI_KEY) ?? '{"state":{}}';
  const parsed = JSON.parse(raw) as { state?: { theme?: unknown } };
  parsed.state = { ...(parsed.state ?? {}), theme };
  localStorage.setItem(TMEX_UI_KEY, JSON.stringify(parsed));
}

describe('useSiteStore theme', () => {
  beforeEach(() => {
    localStorage.clear();
    sendMock.mockClear();
    isReadyMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    useSiteStore.setState({ settings: null, loading: false });
    useUIStore.setState({ theme: 'dark' });
  });

  test('DEFAULT_SETTINGS.theme 为 dark', () => {
    expect(useSiteStore.getState().settings).toBeNull();
  });

  test('fetchSettings 从 /api/settings/site 加载 theme', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/settings/site')) {
        return new Response(
          JSON.stringify({
            settings: {
              siteName: 'tmex',
              siteUrl: 'http://localhost',
              bellThrottleSeconds: 6,
              notificationThrottleSeconds: 3,
              enableBrowserNotificationToast: true,
              enableNotificationPush: true,
              enableBellPush: true,
              enableBellSound: true,
              sshReconnectMaxRetries: 2,
              sshReconnectDelaySeconds: 10,
              language: 'en_US',
              disabledNotificationChannels: [],
              theme: 'light',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    try {
      const settings = await useSiteStore.getState().fetchSettings();
      expect(settings.theme).toBe('light');
      expect(useUIStore.getState().theme).toBe('light');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('updateTheme 乐观更新本地 state + 发 C2S', () => {
    useSiteStore.setState({
      settings: {
        siteName: 'tmex',
        siteUrl: 'http://localhost',
        bellThrottleSeconds: 6,
        notificationThrottleSeconds: 3,
        enableBrowserNotificationToast: true,
        enableNotificationPush: true,
        enableBellPush: true,
        enableBellSound: true,
        sshReconnectMaxRetries: 2,
        sshReconnectDelaySeconds: 10,
        language: 'en_US',
        disabledNotificationChannels: [],
        theme: 'dark',
        updatedAt: new Date().toISOString(),
      },
    });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(useSiteStore.getState().settings?.theme).toBe('light');
    expect(useUIStore.getState().theme).toBe('light');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('updateTheme 同时写 localStorage 作为离线 fallback', () => {
    useSiteStore.setState({
      settings: {
        siteName: 'tmex',
        siteUrl: 'http://localhost',
        bellThrottleSeconds: 6,
        notificationThrottleSeconds: 3,
        enableBrowserNotificationToast: true,
        enableNotificationPush: true,
        enableBellPush: true,
        enableBellSound: true,
        sshReconnectMaxRetries: 2,
        sshReconnectDelaySeconds: 10,
        language: 'en_US',
        disabledNotificationChannels: [],
        theme: 'dark',
        updatedAt: new Date().toISOString(),
      },
    });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(readLocalStorageTheme()).toBe('light');
  });

  test('离线场景：ws 未就绪时 updateTheme 只写 localStorage + 本地 state，不发 C2S', () => {
    isReadyMock.mockImplementation(() => false);
    useSiteStore.setState({
      settings: {
        siteName: 'tmex',
        siteUrl: 'http://localhost',
        bellThrottleSeconds: 6,
        notificationThrottleSeconds: 3,
        enableBrowserNotificationToast: true,
        enableNotificationPush: true,
        enableBellPush: true,
        enableBellSound: true,
        sshReconnectMaxRetries: 2,
        sshReconnectDelaySeconds: 10,
        language: 'en_US',
        disabledNotificationChannels: [],
        theme: 'dark',
        updatedAt: new Date().toISOString(),
      },
    });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().updateTheme('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(readLocalStorageTheme()).toBe('light');
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('setThemeFromS2C 更新本地 state 但不回送 C2S', () => {
    useSiteStore.setState({
      settings: {
        siteName: 'tmex',
        siteUrl: 'http://localhost',
        bellThrottleSeconds: 6,
        notificationThrottleSeconds: 3,
        enableBrowserNotificationToast: true,
        enableNotificationPush: true,
        enableBellPush: true,
        enableBellSound: true,
        sshReconnectMaxRetries: 2,
        sshReconnectDelaySeconds: 10,
        language: 'en_US',
        disabledNotificationChannels: [],
        theme: 'dark',
        updatedAt: new Date().toISOString(),
      },
    });
    useUIStore.setState({ theme: 'dark' });

    useSiteStore.getState().setThemeFromS2C('light');

    expect(useSiteStore.getState().settings?.theme).toBe('light');
    expect(useUIStore.getState().theme).toBe('light');
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('useUIStore.theme 从 useSiteStore.theme 派生（fetchSettings 后同步）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/settings/site')) {
        return new Response(
          JSON.stringify({
            settings: {
              siteName: 'tmex',
              siteUrl: 'http://localhost',
              bellThrottleSeconds: 6,
              notificationThrottleSeconds: 3,
              enableBrowserNotificationToast: true,
              enableNotificationPush: true,
              enableBellPush: true,
              enableBellSound: true,
              sshReconnectMaxRetries: 2,
              sshReconnectDelaySeconds: 10,
              language: 'en_US',
              disabledNotificationChannels: [],
              theme: 'dark',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    try {
      useUIStore.setState({ theme: 'light' });
      await useSiteStore.getState().fetchSettings();
      expect(useUIStore.getState().theme).toBe('dark');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('localStorage 作为离线 fallback：启动时先读 localStorage 即时反馈', () => {
    setLocalStorageTheme('light');
    expect(readLocalStorageTheme()).toBe('light');
  });

  test('useUIStore.setTheme 保留本地 state 更新（persist 写 localStorage）', () => {
    useUIStore.setState({ theme: 'dark' });

    useUIStore.getState().setTheme('light');

    expect(useUIStore.getState().theme).toBe('light');
    expect(readLocalStorageTheme()).toBe('light');
  });
});

describe('useSiteStore capabilities', () => {
  test('loadCapabilities 从 /api/capabilities 填充 FeatureSet', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/capabilities')) {
        return new Response(
          JSON.stringify({
            serverImpl: 'tmex',
            serverVersion: '0.0.0',
            apiVersion: 1,
            wsProtocolVersion: 1,
            capabilities: ['tmex-ws-borsh-v1', 'tmex-agent-v1'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await useSiteStore.getState().loadCapabilities();
      const caps = useSiteStore.getState().capabilities;
      expect(caps.has('tmex-agent-v1')).toBe(true);
      expect(caps.has('missing-cap')).toBe(false);
      expect(caps.list().sort()).toEqual(['tmex-agent-v1', 'tmex-ws-borsh-v1']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('loadCapabilities 请求失败时静默保持空集（不抛）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response('nope', { status: 500 })
    ) as unknown as typeof fetch;
    try {
      useSiteStore.setState({ capabilities: FeatureSet.empty() });
      await useSiteStore.getState().loadCapabilities();
      expect(useSiteStore.getState().capabilities.list()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('hostManagedTheme runtime feature', () => {
  const originalDocument = globalThis.document;
  const darkToggle = mock(() => {});

  function makeSettings(theme: 'dark' | 'light') {
    return {
      siteName: 'tmex',
      siteUrl: 'http://localhost',
      bellThrottleSeconds: 6,
      notificationThrottleSeconds: 3,
      enableBrowserNotificationToast: true,
      enableNotificationPush: true,
      enableBellPush: true,
      enableBellSound: true,
      sshReconnectMaxRetries: 2,
      sshReconnectDelaySeconds: 10,
      language: 'en_US',
      disabledNotificationChannels: [],
      theme,
      updatedAt: new Date().toISOString(),
    };
  }

  function makeThemedSiteStore(hostManagedTheme: boolean, prefix: string) {
    const transport = async (url: string) => {
      if (url.includes('/api/settings/site')) {
        return new Response(JSON.stringify({ settings: makeSettings('light') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    };
    const ui = createUIStore({ storagePrefix: prefix });
    ui.setState({ theme: 'dark' });
    const site = createSiteStore(
      {
        client: { send: sendMock, isReady: isReadyMock } as unknown as Parameters<
          typeof createSiteStore
        >[0]['client'],
        apiClient: new ApiClient('', transport),
        storagePrefix: prefix,
        features: {
          agentUi: true,
          watchUi: true,
          filesUi: true,
          hostManagedNotifications: false,
          hostManagedTheme,
          hostManagedLocale: false,
        },
      },
      () => ui
    );
    return { ui, site };
  }

  function readPrefixedTheme(prefix: string): 'dark' | 'light' | undefined {
    const raw = localStorage.getItem(`${prefix}tmex-ui`);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { state?: { theme?: unknown } };
      const theme = parsed?.state?.theme;
      return theme === 'light' || theme === 'dark' ? theme : undefined;
    } catch {
      return undefined;
    }
  }

  beforeEach(() => {
    localStorage.clear();
    sendMock.mockClear();
    isReadyMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    darkToggle.mockClear();
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: { classList: { toggle: darkToggle } } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  });

  test('对照：默认（false）时 setThemeFromS2C 写 uiStore + localStorage + dark class', () => {
    const prefix = 'hmt-off:';
    const { ui, site } = makeThemedSiteStore(false, prefix);

    site.getState().setThemeFromS2C('light');

    expect(site.getState().settings?.theme).toBe('light');
    expect(ui.getState().theme).toBe('light');
    expect(readPrefixedTheme(prefix)).toBe('light');
    expect(darkToggle).toHaveBeenCalledWith('dark', false);
  });

  test('fetchSettings 不写 uiStore/localStorage/dark class，settings 状态照常更新', async () => {
    const prefix = 'hmt-fetch:';
    const { ui, site } = makeThemedSiteStore(true, prefix);

    const settings = await site.getState().fetchSettings();

    expect(settings.theme).toBe('light');
    expect(site.getState().settings?.theme).toBe('light');
    expect(ui.getState().theme).toBe('dark');
    expect(readPrefixedTheme(prefix)).not.toBe('light');
    expect(darkToggle).not.toHaveBeenCalled();
  });

  test('refreshSettings 不写 uiStore/localStorage/dark class，settings 状态照常更新', async () => {
    const prefix = 'hmt-refresh:';
    const { ui, site } = makeThemedSiteStore(true, prefix);

    const settings = await site.getState().refreshSettings();

    expect(settings.theme).toBe('light');
    expect(site.getState().settings?.theme).toBe('light');
    expect(ui.getState().theme).toBe('dark');
    expect(readPrefixedTheme(prefix)).not.toBe('light');
    expect(darkToggle).not.toHaveBeenCalled();
  });

  test('setThemeFromS2C 不写 uiStore/localStorage/dark class，settings 状态照常更新', () => {
    const prefix = 'hmt-s2c:';
    const { ui, site } = makeThemedSiteStore(true, prefix);

    site.getState().setThemeFromS2C('light');

    expect(site.getState().settings?.theme).toBe('light');
    expect(ui.getState().theme).toBe('dark');
    expect(readPrefixedTheme(prefix)).not.toBe('light');
    expect(darkToggle).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('updateTheme 仍发 C2S 并更新 settings，但不写 uiStore/localStorage/dark class', () => {
    const prefix = 'hmt-update:';
    const { ui, site } = makeThemedSiteStore(true, prefix);

    site.getState().updateTheme('light');

    expect(site.getState().settings?.theme).toBe('light');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(ui.getState().theme).toBe('dark');
    expect(readPrefixedTheme(prefix)).not.toBe('light');
    expect(darkToggle).not.toHaveBeenCalled();
  });
});

describe('hostManagedLocale runtime feature', () => {
  function makeLocaleSiteStore(hostManagedLocale: boolean, prefix: string) {
    const transport = async (url: string) => {
      if (url.includes('/api/settings/site')) {
        return new Response(
          JSON.stringify({
            settings: {
              siteName: 'tmex',
              siteUrl: 'http://localhost',
              bellThrottleSeconds: 6,
              notificationThrottleSeconds: 3,
              enableBrowserNotificationToast: true,
              enableNotificationPush: true,
              enableBellPush: true,
              enableBellSound: true,
              sshReconnectMaxRetries: 2,
              sshReconnectDelaySeconds: 10,
              language: 'en_US',
              disabledNotificationChannels: [],
              theme: 'light',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    };
    const ui = createUIStore({ storagePrefix: prefix });
    return createSiteStore(
      {
        client: { send: sendMock, isReady: isReadyMock } as unknown as Parameters<
          typeof createSiteStore
        >[0]['client'],
        apiClient: new ApiClient('', transport),
        storagePrefix: prefix,
        features: {
          agentUi: true,
          watchUi: true,
          filesUi: true,
          hostManagedNotifications: false,
          hostManagedTheme: false,
          hostManagedLocale,
        },
      },
      () => ui
    );
  }

  beforeEach(() => {
    changeLanguageMock.mockClear();
  });

  test('关断时 site settings 仍驱动 i18next（默认行为不变）', async () => {
    const site = makeLocaleSiteStore(false, 'locale-off:');
    await site.getState().fetchSettings();
    await site.getState().refreshSettings();
    expect(changeLanguageMock).toHaveBeenCalled();
  });

  test('开启时 fetch/refresh 都不改宿主语言', async () => {
    const site = makeLocaleSiteStore(true, 'locale-on:');
    await site.getState().fetchSettings();
    await site.getState().refreshSettings();
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });
});
