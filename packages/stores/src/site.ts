import { FeatureSet, fetchCapabilities, fetchSiteSettings } from '@tmex/api-client';
import { DEFAULT_LOCALE, type SiteSettings, type ThemeMode } from '@tmex/shared';
import { buildSiteThemeUpdate } from '@tmex/ws-client';
import i18next from 'i18next';
import { create } from 'zustand';
import type { RuntimeCore } from './runtime';
import type { UIStore } from './ui';

export interface SiteState {
  settings: SiteSettings | null;
  loading: boolean;
  /** 服务端能力集（GET /api/capabilities）；消费方按 featureset 决定渲染，默认空集 */
  capabilities: FeatureSet;
  fetchSettings: () => Promise<SiteSettings>;
  refreshSettings: () => Promise<SiteSettings>;
  loadCapabilities: () => Promise<void>;
  updateTheme: (theme: ThemeMode) => void;
  setThemeFromS2C: (theme: ThemeMode) => void;
}

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: 'tmex',
  siteUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:9663',
  bellThrottleSeconds: 6,
  notificationThrottleSeconds: 3,
  enableBrowserNotificationToast: true,
  enableNotificationPush: true,
  enableBellPush: true,
  enableBellSound: true,
  sshReconnectMaxRetries: 2,
  sshReconnectDelaySeconds: 10,
  language: DEFAULT_LOCALE,
  theme: 'dark' as ThemeMode,
  disabledNotificationChannels: [],
  updatedAt: new Date(0).toISOString(),
};

export function createSiteStore(
  core: Pick<RuntimeCore, 'client' | 'apiClient' | 'storagePrefix' | 'features'>,
  getUIStore: () => UIStore
) {
  function applySiteLanguage(language: string): void {
    if (core.features.hostManagedLocale) return;
    void i18next.changeLanguage(language);
  }

  function syncThemeToUIStore(theme: ThemeMode): void {
    if (core.features.hostManagedTheme) return;
    const uiStore = getUIStore();
    if (uiStore.getState().theme !== theme) {
      uiStore.setState({ theme });
    }
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
  }

  function writeThemeToLocalStorage(theme: ThemeMode): void {
    if (core.features.hostManagedTheme) return;
    try {
      const key = `${core.storagePrefix}tmex-ui`;
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as { state?: { theme?: unknown } }) : { state: {} };
      parsed.state = { ...(parsed.state ?? {}), theme };
      localStorage.setItem(key, JSON.stringify(parsed));
    } catch {
      // localStorage 不可用时静默降级（离线 fallback 仅在可用时生效）
    }
  }

  return create<SiteState>((set, get) => ({
    settings: null,
    loading: false,
    capabilities: FeatureSet.empty(),

    fetchSettings: async () => {
      const existing = get().settings;
      if (existing) {
        return existing;
      }

      set({ loading: true });
      try {
        const settings = await fetchSiteSettings(core.apiClient);
        set({ settings, loading: false });
        applySiteLanguage(settings.language);
        syncThemeToUIStore(settings.theme);
        return settings;
      } catch (err) {
        console.error('[site] failed to fetch settings:', err);
        set({ settings: DEFAULT_SETTINGS, loading: false });
        applySiteLanguage(DEFAULT_SETTINGS.language);
        syncThemeToUIStore(DEFAULT_SETTINGS.theme);
        return DEFAULT_SETTINGS;
      }
    },

    refreshSettings: async () => {
      set({ loading: true });
      try {
        const settings = await fetchSiteSettings(core.apiClient);
        set({ settings, loading: false });
        applySiteLanguage(settings.language);
        syncThemeToUIStore(settings.theme);
        return settings;
      } catch (err) {
        console.error('[site] failed to refresh settings:', err);
        set({ loading: false });
        throw err;
      }
    },

    loadCapabilities: async () => {
      try {
        const res = await fetchCapabilities(core.apiClient);
        set({ capabilities: new FeatureSet(res.capabilities) });
      } catch (err) {
        console.error('[site] failed to load capabilities:', err);
      }
    },

    updateTheme: (theme) => {
      const current = get().settings;
      const nextSettings: SiteSettings = current
        ? { ...current, theme }
        : { ...DEFAULT_SETTINGS, theme };
      set({ settings: nextSettings });
      syncThemeToUIStore(theme);
      writeThemeToLocalStorage(theme);

      if (core.client.isReady()) {
        const msg = buildSiteThemeUpdate(theme);
        core.client.send(msg.kind, msg.payload);
      }
    },

    setThemeFromS2C: (theme) => {
      const current = get().settings;
      const nextSettings: SiteSettings = current
        ? { ...current, theme }
        : { ...DEFAULT_SETTINGS, theme };
      set({ settings: nextSettings });
      syncThemeToUIStore(theme);
      writeThemeToLocalStorage(theme);
    },
  }));
}

export type SiteStore = ReturnType<typeof createSiteStore>;
