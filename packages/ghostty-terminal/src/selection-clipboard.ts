export function hasCopyModifier(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey;
}

export function isCopyShortcut(event: KeyboardEvent): boolean {
  return hasCopyModifier(event) && event.key.toLowerCase() === 'c';
}

export async function writeSelectionToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
}

export function writeSelectionToCopyEvent(event: ClipboardEvent, text: string): boolean {
  if (!text || !event.clipboardData) {
    return false;
  }

  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
  return true;
}
