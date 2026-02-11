import { useSiteStore } from '../stores/site';

export function getSiteNameFallback(): string {
  const settings = useSiteStore.getState().settings;
  return settings?.siteName || 'tmex';
}

export function getSiteUrlFallback(): string {
  const settings = useSiteStore.getState().settings;
  return settings?.siteUrl || window.location.origin;
}
