import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TelegramBotWithStats } from '@tmex/shared';
import { Pencil, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { TelegramBotChatsModal } from './telegram-bot-chats-modal';

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface TelegramBotRowProps {
  bot: TelegramBotWithStats;
  onEdit: (bot: TelegramBotWithStats) => void;
}

export function TelegramBotRow({ bot, onEdit }: TelegramBotRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showChats, setShowChats] = useState(false);

  const toggleEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.updateFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deleteBotMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.deleteFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`telegram-bot-card-${bot.id}`}
      data-bot-name={bot.name}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Switch
          checked={bot.enabled}
          disabled={toggleEnabledMutation.isPending}
          onCheckedChange={(checked) => toggleEnabledMutation.mutate(Boolean(checked))}
          data-testid={`telegram-bot-enabled-${bot.id}`}
        />
        <div className="min-w-0">
          <div className="truncate font-medium">{bot.name}</div>
          <div className="text-xs text-muted-foreground">
            {t('telegram.authCount', {
              authorized: bot.authorizedCount,
              pending: bot.pendingCount,
            })}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('telegram.chats')}
          data-testid={`telegram-bot-chats-${bot.id}`}
          onClick={() => setShowChats(true)}
        >
          <Users className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`telegram-bot-edit-${bot.id}`}
          onClick={() => onEdit(bot)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('telegram.deleteBot')}
          data-testid={`telegram-bot-delete-${bot.id}`}
          onClick={() => deleteBotMutation.mutate()}
          disabled={deleteBotMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <TelegramBotChatsModal
        open={showChats}
        onOpenChange={setShowChats}
        botId={bot.id}
        botName={bot.name}
      />
    </div>
  );
}
