import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AgentSessionDto } from '@tmex/shared';
import { CheckIcon, ChevronsUpDownIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface SessionSwitcherProps {
  sessions: AgentSessionDto[];
  currentSessionId?: string | null;
  showAll: boolean;
  onToggleShowAll: (showAll: boolean) => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  createDisabled?: boolean;
  createDisabledReason?: string;
}

export function SessionSwitcher({
  sessions,
  currentSessionId,
  showAll,
  onToggleShowAll,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  createDisabled,
  createDisabledReason,
}: SessionSwitcherProps) {
  const { t } = useTranslation();
  const currentSession = sessions.find((session) => session.id === currentSessionId);

  const [renameTarget, setRenameTarget] = useState<AgentSessionDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AgentSessionDto | null>(null);

  const submitRename = (): void => {
    const title = renameValue.trim();
    if (renameTarget && title) {
      onRename(renameTarget.id, title);
    }
    setRenameTarget(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-full justify-start gap-1"
              data-testid="agent-session-switcher"
            />
          }
        >
          <span className={cn('min-w-0 truncate', !currentSession && 'text-muted-foreground')}>
            {currentSession ? currentSession.title : t('agent.session.none')}
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          data-testid="agent-session-switcher-menu"
        >
          {sessions.length === 0 && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              {t('agent.session.noSessions')}
            </p>
          )}
          {sessions.map((session) => (
            <DropdownMenuItem
              key={session.id}
              data-testid={`agent-session-item-${session.id}`}
              onClick={() => onSelect(session.id)}
            >
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.id === currentSessionId && <CheckIcon className="shrink-0" />}
              <button
                type="button"
                data-testid={`agent-session-rename-${session.id}`}
                aria-label={t('agent.session.rename')}
                className="text-muted-foreground hover:text-foreground shrink-0 p-0.5"
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setRenameValue(session.title);
                  setRenameTarget(session);
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                data-testid={`agent-session-delete-${session.id}`}
                aria-label={t('agent.session.delete')}
                className="text-muted-foreground hover:text-destructive shrink-0 p-0.5"
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setDeleteTarget(session);
                }}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            data-testid="agent-session-show-all"
            checked={showAll}
            onCheckedChange={(checked) => onToggleShowAll(Boolean(checked))}
            closeOnClick={false}
          >
            {t('agent.session.showAll')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="agent-session-create"
            disabled={createDisabled}
            onClick={() => onCreate()}
          >
            <PlusIcon className="shrink-0" />
            <span>{t('agent.session.new')}</span>
          </DropdownMenuItem>
          <p className="text-muted-foreground px-2 pt-0.5 pb-1.5 text-[11px] leading-snug">
            {createDisabled && createDisabledReason
              ? createDisabledReason
              : t('agent.session.privacyNotice')}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent data-testid="agent-session-rename-dialog" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('agent.session.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            data-testid="agent-session-rename-input"
            value={renameValue}
            placeholder={t('agent.session.renamePlaceholder')}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitRename();
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t('agent.session.cancel')}
            </Button>
            <Button
              data-testid="agent-session-rename-save"
              disabled={renameValue.trim().length === 0}
              onClick={submitRename}
            >
              {t('agent.session.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent data-testid="agent-session-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('agent.session.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agent.session.deleteDesc', { title: deleteTarget?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('agent.session.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="agent-session-delete-confirm"
              onClick={() => {
                if (deleteTarget) {
                  onDelete(deleteTarget.id);
                }
                setDeleteTarget(null);
              }}
            >
              {t('agent.session.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
