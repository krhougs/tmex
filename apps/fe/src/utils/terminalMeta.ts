import { getSiteNameFallback } from './site';

interface TerminalLabelInput {
  paneIdx?: number | null;
  windowIdx?: number | null;
  paneTitle?: string | null;
  windowName?: string | null;
  deviceName?: string | null;
}

function toSafeText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '?';
}

export function buildTerminalLabel({
  paneIdx,
  windowIdx,
  paneTitle,
  windowName,
  deviceName,
}: TerminalLabelInput): string {
  const safeWindowIdx = windowIdx ?? '?';
  const safePaneIdx = paneIdx ?? '?';
  const safePaneTitle = toSafeText(paneTitle ?? windowName);
  const safeDeviceName = toSafeText(deviceName);
  return `${safeWindowIdx}/${safePaneIdx}: ${safePaneTitle}@${safeDeviceName}`;
}

export function buildBrowserTitle(label?: string | null): string {
  const siteName = getSiteNameFallback();
  if (!label?.trim()) {
    return siteName;
  }
  return `[${siteName}]${label}`;
}
