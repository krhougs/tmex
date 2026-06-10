import { ClipboardPaste, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SelectionToolbarProps {
  visible: boolean;
  canPaste: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onDismiss: () => void;
}

export function SelectionToolbar({
  visible,
  canPaste,
  onCopy,
  onPaste,
  onDismiss,
}: SelectionToolbarProps) {
  const { t } = useTranslation();

  if (!visible) {
    return null;
  }

  const preventFocusSteal = (event: React.MouseEvent) => {
    event.preventDefault();
  };

  return (
    <div
      className="absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-md backdrop-blur"
      data-testid="terminal-selection-toolbar"
    >
      <button
        type="button"
        className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        onMouseDown={preventFocusSteal}
        onClick={onCopy}
        data-testid="terminal-selection-copy"
      >
        <Copy className="h-4 w-4" />
        {t('terminal.copy')}
      </button>
      {canPaste && (
        <button
          type="button"
          className="flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          onMouseDown={preventFocusSteal}
          onClick={onPaste}
          data-testid="terminal-selection-paste"
        >
          <ClipboardPaste className="h-4 w-4" />
          {t('terminal.paste')}
        </button>
      )}
      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onMouseDown={preventFocusSteal}
        onClick={onDismiss}
        aria-label={t('terminal.clearSelection')}
        data-testid="terminal-selection-dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
