function buildPaneLocationLabel(data: Record<string, unknown>): string {
  const windowLabel =
    typeof data.windowIndex === 'number'
      ? `Window ${data.windowIndex}`
      : typeof data.windowId === 'string' && data.windowId
        ? `Window ${data.windowId}`
        : '';
  const paneLabel =
    typeof data.paneIndex === 'number'
      ? `Pane ${data.paneIndex}`
      : typeof data.paneId === 'string' && data.paneId
        ? `Pane ${data.paneId}`
        : '';

  return [windowLabel, paneLabel].filter(Boolean).join(' · ');
}

export function formatTerminalNotificationToast(data: Record<string, unknown>): {
  title: string;
  description: string;
} {
  const title = typeof data.title === 'string' && data.title ? data.title : 'Terminal Notification';
  const location = buildPaneLocationLabel(data);
  const detail =
    typeof data.body === 'string' && data.body
      ? data.body
      : typeof data.source === 'string' && data.source
        ? `From ${data.source}`
        : 'Terminal notification';

  return {
    title,
    description: location ? `${location}\n${detail}` : detail,
  };
}
