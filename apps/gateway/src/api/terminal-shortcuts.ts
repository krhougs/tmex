import {
  TERMINAL_SHORTCUT_ACTIONS,
  type TerminalShortcutItem,
  type UpdateTerminalShortcutSettingsRequest,
} from '@tmex/shared';
import { t } from '../i18n';

export const MAX_TERMINAL_SHORTCUTS = 50;
export const MAX_TERMINAL_SHORTCUT_LABEL_LEN = 32;
export const MAX_TERMINAL_SHORTCUT_PAYLOAD_LEN = 256;

export interface NormalizedTerminalShortcuts {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

/**
 * 校验并规范化前端提交的终端快捷键设置。非法输入抛错（→ 400）。
 */
export function normalizeTerminalShortcutsInput(
  body: UpdateTerminalShortcutSettingsRequest
): NormalizedTerminalShortcuts {
  if (typeof body !== 'object' || body === null) {
    throw new Error(t('apiError.invalidRequest'));
  }
  if (typeof body.useIcons !== 'boolean') {
    throw new Error(t('apiError.invalidRequest'));
  }
  if (!Array.isArray(body.items)) {
    throw new Error(t('apiError.invalidRequest'));
  }
  if (body.items.length > MAX_TERMINAL_SHORTCUTS) {
    throw new Error(t('apiError.terminalShortcutsTooMany'));
  }

  const seenIds = new Set<string>();
  const items: TerminalShortcutItem[] = body.items.map((raw): TerminalShortcutItem => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(t('apiError.terminalShortcutInvalid'));
    }
    const item = raw as Partial<TerminalShortcutItem>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seenIds.has(id)) {
      throw new Error(t('apiError.terminalShortcutInvalid'));
    }
    seenIds.add(id);

    const label = typeof item.label === 'string' ? item.label : '';
    if (label.length > MAX_TERMINAL_SHORTCUT_LABEL_LEN) {
      throw new Error(t('apiError.terminalShortcutInvalid'));
    }

    if (item.type === 'send') {
      const payload = typeof item.payload === 'string' ? item.payload : '';
      if (!payload || payload.length > MAX_TERMINAL_SHORTCUT_PAYLOAD_LEN) {
        throw new Error(t('apiError.terminalShortcutInvalid'));
      }
      return { id, type: 'send', label, payload };
    }

    if (item.type === 'action') {
      const action = item.action;
      if (!action || !TERMINAL_SHORTCUT_ACTIONS.includes(action)) {
        throw new Error(t('apiError.terminalShortcutInvalid'));
      }
      return { id, type: 'action', label, action };
    }

    throw new Error(t('apiError.terminalShortcutInvalid'));
  });

  return { items, useIcons: body.useIcons };
}
