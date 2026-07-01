// 移动端 pane 切换按钮：当前 window 多 pane 时出现在标题栏 PageActions，
// 点击弹出 pane 列表（index / title / 进程 / cwd + active 圆点），点击项切换 pane。

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface PaneSwitcherMenuProps {
  window: TmuxWindow;
  currentPaneId: string;
  onSelectPane: (paneId: string) => void;
}

function paneLabel(pane: TmuxPane): string {
  const title = pane.title?.trim();
  const command = pane.currentCommand?.trim();
  if (title && title !== command) {
    return command ? `${title} · ${command}` : title;
  }
  return command || title || `Pane ${pane.index}`;
}

function cwdBasename(pane: TmuxPane): string | null {
  const path = pane.currentPath?.trim();
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1) ?? path;
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
        className="min-w-52"
        data-testid="pane-switcher-menu"
      >
        {window.panes.map((pane) => {
          const isCurrent = pane.id === currentPaneId;
          const cwd = cwdBasename(pane);
          return (
            <DropdownMenuItem
              key={pane.id}
              data-testid="pane-switcher-item"
              data-pane-id={pane.id}
              className={`[@media(any-pointer:coarse)]:py-2.5 ${
                isCurrent ? 'bg-primary/10 text-primary' : ''
              }`}
              onClick={() => {
                if (!isCurrent) {
                  onSelectPane(pane.id);
                }
              }}
            >
              <span className="w-5 shrink-0 text-xs text-muted-foreground">{pane.index}</span>
              <span className="min-w-0 flex-1 truncate">{paneLabel(pane)}</span>
              {cwd && (
                <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {cwd}
                </span>
              )}
              {isCurrent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
