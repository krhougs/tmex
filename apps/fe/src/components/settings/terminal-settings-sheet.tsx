import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useTranslation } from 'react-i18next';
import { TerminalSettingsPanel } from './terminal-settings-panel';

interface TerminalSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// 终端页右上角入口：底部 Sheet 展示完整终端设置（字号/行高/字体/键盘行为），
// 与设置页「终端」Tab 复用 TerminalSettingsPanel。即改即生效，仅存浏览器。
// 大屏（触屏 PC / iPad）居中限宽；内容较高，超出时内部滚动。
export function TerminalSettingsSheet({ open, onOpenChange }: TerminalSettingsSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[88dvh] overflow-y-auto pb-[var(--tmex-safe-area-bottom)] sm:mx-auto sm:max-w-md sm:rounded-t-2xl sm:border sm:border-b-0"
        data-testid="keyboard-behavior-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t('settings.terminal.title')}</SheetTitle>
          <SheetDescription>{t('settings.terminal.savedInBrowser')}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <TerminalSettingsPanel />
        </div>
      </SheetContent>
    </Sheet>
  );
}
