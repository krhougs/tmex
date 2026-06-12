import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { RightPanelTrigger } from '@/components/ui/right-panel';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SendIcon } from 'lucide-react';

import { SessionSwitcher, type SessionSwitcherProps } from './session-switcher';

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export function ChatThread({
  messages,
  className,
}: {
  messages: AgentChatMessage[];
  className?: string;
}) {
  const { t } = useTranslation();

  if (messages.length === 0) {
    return (
      <div
        data-testid="agent-chat-thread"
        className={cn('flex min-h-0 flex-1 items-center justify-center p-4', className)}
      >
        <p className="text-muted-foreground text-sm">{t('agent.panel.empty')}</p>
      </div>
    );
  }

  return (
    <div
      data-testid="agent-chat-thread"
      className={cn('min-h-0 flex-1 overflow-y-auto p-3', className)}
    >
      <ul className="flex flex-col gap-3">
        {messages.map((message) => (
          <li
            key={message.id}
            data-testid={`agent-chat-message-${message.id}`}
            data-role={message.role}
            className={cn(
              'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
              message.role === 'user'
                ? 'bg-primary text-primary-foreground self-end'
                : 'bg-muted text-foreground self-start'
            )}
          >
            {message.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChatInput({
  onSend,
  disabled,
  className,
}: {
  onSend?: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend?.(trimmed);
    setText('');
  };

  return (
    <div
      data-testid="agent-chat-input"
      className={cn('flex shrink-0 items-end gap-2 border-t p-3', className)}
    >
      <Textarea
        data-testid="agent-chat-input-textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t('agent.panel.inputPlaceholder')}
        disabled={disabled}
        className="max-h-40 min-h-9 flex-1 resize-none"
        rows={1}
      />
      <Button
        data-testid="agent-chat-send"
        size="icon"
        disabled={disabled || text.trim().length === 0}
        onClick={submit}
        aria-label={t('agent.panel.send')}
      >
        <SendIcon />
      </Button>
    </div>
  );
}

export function AgentPanel({
  sessions,
  currentSessionId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SessionSwitcherProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="agent-panel" className="flex h-full min-h-0 flex-col">
      <header
        data-testid="agent-panel-header"
        className="flex h-12 shrink-0 items-center gap-2 px-3 md:h-16"
      >
        <span className="text-sm font-semibold">{t('agent.panel.title')}</span>
        <Separator orientation="vertical" className="shrink-0 data-[orientation=vertical]:h-4" />
        <div className="min-w-0 flex-1">
          <SessionSwitcher
            sessions={sessions}
            currentSessionId={currentSessionId}
            onSelect={onSelect}
            onCreate={onCreate}
            onRename={onRename}
            onDelete={onDelete}
          />
        </div>
        <RightPanelTrigger className="shrink-0" data-testid="right-panel-close" />
      </header>
      <Separator />
      {/* Task 8 接入 store/WS 后由真实消息驱动 */}
      <ChatThread messages={[]} />
      <ChatInput disabled />
    </div>
  );
}
