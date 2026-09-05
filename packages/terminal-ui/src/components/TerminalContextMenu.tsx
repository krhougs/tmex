import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@tmex/ui/context-menu';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { forwardRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  terminal: CompatibleTerminalLike | null;
  hasSelection: boolean;
  canPaste: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onCopyLink: (text: string) => void;
  children: ReactNode;
};

export const TerminalContextMenu = forwardRef<HTMLDivElement, Props>(function TerminalContextMenu(
  { terminal, hasSelection, canPaste, onCopy, onPaste, onSelectAll, onCopyLink, children },
  ref
) {
  const { t } = useTranslation();
  const [link, setLink] =
    useState<ReturnType<NonNullable<CompatibleTerminalLike['getContextLink']>>>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={ref}
        className="relative min-h-0 w-full flex-1"
        onTouchStart={(event) => event.preventBaseUIHandler()}
        onContextMenu={(event) => {
          if (terminal?.isMouseReporting?.() && !event.shiftKey) {
            event.preventBaseUIHandler();
            event.preventDefault();
            return;
          }
          setLink(terminal?.getContextLink?.(event.clientX, event.clientY) ?? null);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              shiftKey: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            })
          );
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent finalFocus={() => (canPaste ? (terminal?.textarea ?? false) : false)}>
        <ContextMenuItem disabled={!hasSelection} onClick={onCopy}>
          {t('terminal.copy')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!canPaste} onClick={onPaste}>
          {t('terminal.paste')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!terminal} onClick={onSelectAll}>
          {t('terminal.selectAll')}
        </ContextMenuItem>
        {link && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => terminal?.activateContextLink?.(link)}>
              {t('terminal.openLink')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCopyLink(link.kind === 'url' ? link.url : link.path)}>
              {t('terminal.copyLink')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
