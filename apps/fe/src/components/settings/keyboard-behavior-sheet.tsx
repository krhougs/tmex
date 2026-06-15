import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { type KeyboardBehaviorMode, useUIStore } from '@/stores/ui';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface KeyboardBehaviorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// 手机键盘行为选择（issue #27）。三种模式即点即生效（写 useUIStore，无保存按钮），
// 底部 Sheet；大屏（触屏 PC / iPad）居中限宽。
const MODE_ITEMS = [
  {
    value: 'lift',
    labelKey: 'terminal.keyboardBehavior.modeLift',
    descKey: 'terminal.keyboardBehavior.modeLiftDesc',
  },
  {
    value: 'resize',
    labelKey: 'terminal.keyboardBehavior.modeResize',
    descKey: 'terminal.keyboardBehavior.modeResizeDesc',
  },
  {
    value: 'follow',
    labelKey: 'terminal.keyboardBehavior.modeFollow',
    descKey: 'terminal.keyboardBehavior.modeFollowDesc',
  },
] as const satisfies ReadonlyArray<{
  value: KeyboardBehaviorMode;
  labelKey: string;
  descKey: string;
}>;

export function KeyboardBehaviorSheet({ open, onOpenChange }: KeyboardBehaviorSheetProps) {
  const { t } = useTranslation();
  const mode = useUIStore((state) => state.keyboardBehaviorMode);
  const setMode = useUIStore((state) => state.setKeyboardBehaviorMode);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="pb-[var(--tmex-safe-area-bottom)] sm:mx-auto sm:max-w-md sm:rounded-t-2xl sm:border sm:border-b-0"
        data-testid="keyboard-behavior-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t('terminal.keyboardBehavior.title')}</SheetTitle>
          <SheetDescription>{t('terminal.keyboardBehavior.description')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {MODE_ITEMS.map((item) => {
            const selected = mode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                aria-pressed={selected}
                data-testid={`keyboard-behavior-option-${item.value}`}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {selected && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(item.labelKey)}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {t(item.descKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
