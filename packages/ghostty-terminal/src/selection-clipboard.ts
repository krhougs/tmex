export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  if (/mac|iphone|ipad|ipod/iu.test(platform)) {
    return true;
  }

  return /mac os x/iu.test(navigator.userAgent ?? '');
}

export function hasCopyModifier(event: KeyboardEvent): boolean {
  if (event.altKey) {
    return false;
  }

  return Boolean(isMacPlatform() ? event.metaKey : event.ctrlKey);
}

export function isCopyShortcut(event: KeyboardEvent): boolean {
  return hasCopyModifier(event) && event.key.toLowerCase() === 'c';
}

export function isPasteShortcut(event: KeyboardEvent): boolean {
  if (
    event.shiftKey &&
    event.key === 'Insert' &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return true;
  }

  if (event.altKey || event.key.toLowerCase() !== 'v') {
    return false;
  }

  return Boolean(isMacPlatform() ? event.metaKey : event.ctrlKey);
}

export async function writeTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('clipboard unavailable');
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.left = '-9999px';
  helper.style.top = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    helper.remove();
  }
}

export async function writeSelectionToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  await writeTextToClipboard(text);
}

export function writeSelectionToCopyEvent(event: ClipboardEvent, text: string): boolean {
  if (!text || !event.clipboardData) {
    return false;
  }

  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
  return true;
}
