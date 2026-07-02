// 移动端 pane 切换按钮：当前 window 多 pane 时出现在标题栏 PageActions，
// 点击弹出 pane 列表（与侧栏 pane 行同款两行排版：标题 + 进程@路径），点击项切换 pane。

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TmuxWindow } from '@tmex/shared';
import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface PaneSwitcherMenuProps {
  window: TmuxWindow;
  currentPaneId: string;
  onSelectPane: (paneId: string) => void;
}

export function PaneSwitcherMenu({ window, currentPaneId, onSelectPane }: PaneSwitcherMenuProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="pane-switcher-button"
        aria-label={t('window.switchPane')}
        title={t('window.switchPane')}
        className="relative inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] text-sm hover:bg-muted hover:text-foreground data-popup-open:bg-muted"
      >
        <Columns2 className="h-4 w-4" />
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground">
          {window.panes.length}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        backdrop
        className="min-w-56 max-w-[80vw]"
        data-testid="pane-switcher-menu"
      >
        {window.panes.map((pane) => {
          const isCurrent = pane.id === currentPaneId;
          return (
            <DropdownMenuItem
              key={pane.id}
              data-testid="pane-switcher-item"
              data-pane-id={pane.id}
              className={`py-2 [@media(any-pointer:coarse)]:py-2.5 ${
                isCurrent
                  ? 'bg-primary/10 text-primary'
                  : pane.active
                    ? 'bg-accent text-accent-foreground'
                    : ''
              }`}
              onClick={() => {
                if (!isCurrent) {
                  onSelectPane(pane.id);
                }
              }}
            >
              {/* 与侧栏 pane 行一致的两行排版 */}
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
                  {pane.customName || pane.title || t('window.pane')}
                </span>
                {pane.currentCommand && (
                  <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
                    {pane.currentPath
                      ? `${pane.currentCommand}@${pane.currentPath}`
                      : pane.currentCommand}
                  </span>
                )}
              </span>
              {isCurrent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
