import i18n from '../i18n';

function buildPaneLabel(data: Record<string, unknown>): string {
  if (typeof data.paneTitle === 'string' && data.paneTitle) {
    return data.paneTitle;
  }
  if (typeof data.paneCurrentCommand === 'string' && data.paneCurrentCommand) {
    return data.paneCurrentCommand;
  }
  if (typeof data.paneIndex === 'number') {
    return i18n.t('terminal.paneTitle', { index: data.paneIndex });
  }
  if (typeof data.paneId === 'string' && data.paneId) {
    return i18n.t('terminal.paneTitle', { index: data.paneId });
  }
  return '';
}

export function buildPaneLocationLabel(data: Record<string, unknown>): string {
  const windowLabel =
    typeof data.windowIndex === 'number'
      ? String(data.windowIndex)
      : typeof data.windowId === 'string' && data.windowId
        ? data.windowId
        : '';
  const paneLabel = buildPaneLabel(data);

  if (windowLabel && paneLabel) {
    return i18n.t('terminal.bellDescriptionWithTitle', { window: windowLabel, paneLabel });
  }
  if (windowLabel) {
    return `${i18n.t('notification.window')} ${windowLabel}`;
  }
  if (paneLabel) {
    return paneLabel;
  }
  return '';
}

export function formatTerminalNotificationToast(data: Record<string, unknown>): {
  title: string;
  description: string;
} {
  const title =
    typeof data.title === 'string' && data.title
      ? data.title
      : i18n.t('terminal.notificationFallbackTitle');
  const location = buildPaneLocationLabel(data);
  const detail =
    typeof data.body === 'string' && data.body
      ? data.body
      : typeof data.source === 'string' && data.source
        ? i18n.t('terminal.notificationSourceLabel', { source: data.source })
        : i18n.t('terminal.notificationFallbackDetail');

  return {
    title,
    description: location ? `${location}\n${detail}` : detail,
  };
}
