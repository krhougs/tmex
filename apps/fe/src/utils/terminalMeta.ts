import { getSiteNameFallback } from './site';

interface TerminalLabelInput {
  paneIdx?: number | null;
  windowIdx?: number | null;
  paneTitle?: string | null;
  windowName?: string | null;
  windowCustomName?: string | null;
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
  windowCustomName,
  deviceName,
}: TerminalLabelInput): string {
  const safeWindowIdx = windowIdx ?? '?';
  const safePaneIdx = paneIdx ?? '?';
  const safePaneTitle = toSafeText(windowCustomName ?? paneTitle ?? windowName);
  const safeDeviceName = toSafeText(deviceName);
  return `${safeWindowIdx}/${safePaneIdx}: ${safePaneTitle}@${safeDeviceName}`;
}

interface WindowTitleInput {
  name: string;
  customName?: string | null;
  panes: Array<{ active: boolean; title?: string | null }>;
}

export interface WindowTitleParts {
  title: string;
  processName?: string;
}

export function buildWindowTitleParts(window: WindowTitleInput): WindowTitleParts {
  const customName = window.customName?.trim();
  const activePane = window.panes.find((pane) => pane.active) ?? window.panes[0];
  const processName = window.name.trim();
  const oscTitle = activePane?.title?.trim();
  const title = customName || oscTitle || processName;
  // 标题已经是进程名时不重复展示
  const showProcess = Boolean(processName) && processName !== title;
  return { title, processName: showProcess ? processName : undefined };
}

export function buildWindowDisplayName(window: WindowTitleInput): string {
  const { title, processName } = buildWindowTitleParts(window);
  return processName ? `${processName}: ${title}` : title;
}

export function buildBrowserTitle(label?: string | null): string {
  const siteName = getSiteNameFallback();
  if (!label?.trim()) {
    return siteName;
  }
  return `[${siteName}]${label}`;
}
