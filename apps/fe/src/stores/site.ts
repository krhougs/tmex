import { DEFAULT_LOCALE, type SiteSettings } from '@tmex/shared';
import { create } from 'zustand';
import i18n from '../i18n';

interface SiteState {
  settings: SiteSettings | null;
  loading: boolean;
  fetchSettings: () => Promise<SiteSettings>;
  refreshSettings: () => Promise<SiteSettings>;
}

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: 'tmex',
  siteUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:9663',
  bellThrottleSeconds: 6,
  enableBrowserBellToast: true,
  enableTelegramBellPush: true,
  sshReconnectMaxRetries: 2,
  sshReconnectDelaySeconds: 10,
  language: DEFAULT_LOCALE,
  updatedAt: new Date(0).toISOString(),
};

async function fetchSiteSettingsFromApi(): Promise<SiteSettings> {
  const res = await fetch('/api/settings/site');
  if (!res.ok) {
    throw new Error('Failed to load site settings');
  }
  const payload = (await res.json()) as { settings: SiteSettings };
  return payload.settings;
}

export const useSiteStore = create<SiteState>((set, get) => ({
  settings: null,
  loading: false,

  fetchSettings: async () => {
    const existing = get().settings;
    if (existing) {
      return existing;
    }

    set({ loading: true });
    try {
      const settings = await fetchSiteSettingsFromApi();
      set({ settings, loading: false });
      void i18n.changeLanguage(settings.language);
      return settings;
    } catch (err) {
      console.error('[site] failed to fetch settings:', err);
      set({ settings: DEFAULT_SETTINGS, loading: false });
      void i18n.changeLanguage(DEFAULT_SETTINGS.language);
      return DEFAULT_SETTINGS;
    }
  },

  refreshSettings: async () => {
    set({ loading: true });
    try {
      const settings = await fetchSiteSettingsFromApi();
      set({ settings, loading: false });
      void i18n.changeLanguage(settings.language);
      return settings;
    } catch (err) {
      console.error('[site] failed to refresh settings:', err);
      set({ loading: false });
      throw err;
    }
  },
}));
