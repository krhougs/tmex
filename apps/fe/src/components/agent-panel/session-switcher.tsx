import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface AgentSessionSummary {
  id: string;
  title: string;
}

export interface SessionSwitcherProps {
  sessions?: AgentSessionSummary[];
  currentSessionId?: string | null;
  onSelect?: (sessionId: string) => void;
  onCreate?: () => void;
  // Task 8 接入会话管理时使用
  onRename?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
}

export function SessionSwitcher({
  sessions = [],
  currentSessionId,
  onSelect,
  onCreate,
}: SessionSwitcherProps) {
  const { t } = useTranslation();
  const currentSession = sessions.find((session) => session.id === currentSessionId);

  return (
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
      <DropdownMenuContent align="start" className="w-56" data-testid="agent-session-switcher-menu">
        {sessions.map((session) => (
          <DropdownMenuItem
            key={session.id}
            data-testid={`agent-session-item-${session.id}`}
            onClick={() => onSelect?.(session.id)}
          >
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {session.id === currentSessionId && <CheckIcon className="shrink-0" />}
          </DropdownMenuItem>
        ))}
        {sessions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem data-testid="agent-session-create" onClick={() => onCreate?.()}>
          <PlusIcon className="shrink-0" />
          <span>{t('agent.session.new')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
