import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AgentQueuedMessageDto } from '@tmex/shared';
import { CheckIcon, PencilIcon, XIcon, ZapIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 运行中排队消息：可编辑 / 撤回 / 立即 steer 注入 */
export function QueueChips({
  queued,
  onEdit,
  onWithdraw,
  onSteer,
}: {
  queued: AgentQueuedMessageDto[];
  onEdit: (itemId: string, text: string) => void;
  onWithdraw: (itemId: string) => void;
  onSteer: () => void;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (queued.length === 0) return null;

  const startEdit = (item: AgentQueuedMessageDto): void => {
    setEditingId(item.id);
    setDraft(item.text);
  };
  const commitEdit = (itemId: string): void => {
    const trimmed = draft.trim();
    if (trimmed) onEdit(itemId, trimmed);
    setEditingId(null);
  };

  return (
    <div
      data-testid="agent-queue"
      className="bg-muted/50 mx-3 mb-2 flex shrink-0 flex-col gap-1.5 rounded-xl px-2.5 py-2"
    >
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium">
          {t('agent.queue.title', { count: queued.length })}
        </span>
        <Button
          data-testid="agent-queue-steer"
          size="xs"
          variant="outline"
          onClick={onSteer}
          title={t('agent.queue.steerHint')}
        >
          <ZapIcon />
          {t('agent.queue.steer')}
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {queued.map((item) => (
          <li
            key={item.id}
            data-testid={`agent-queue-item-${item.id}`}
            className="bg-background/60 flex items-start gap-1.5 rounded-lg px-2 py-1"
          >
            {editingId === item.id ? (
              <>
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      commitEdit(item.id);
                    }
                    if (event.key === 'Escape') setEditingId(null);
                  }}
                  rows={1}
                  className="max-h-32 min-h-7 flex-1 resize-none text-xs"
                  autoFocus
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => commitEdit(item.id)}
                  aria-label={t('common.save')}
                >
                  <CheckIcon />
                </Button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-xs">{item.text}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => startEdit(item)}
                  aria-label={t('common.edit')}
                >
                  <PencilIcon />
                </Button>
                <Button
                  data-testid={`agent-queue-withdraw-${item.id}`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onWithdraw(item.id)}
                  aria-label={t('agent.queue.withdraw')}
                >
                  <XIcon />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
