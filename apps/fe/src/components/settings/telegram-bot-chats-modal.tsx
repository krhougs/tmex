import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TelegramBotChat } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { Send, Shield } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSiteStore } from '@/stores/site';

interface TelegramChatsResponse {
  chats: TelegramBotChat[];
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface TelegramBotChatsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botId: string;
  botName: string;
}

export function TelegramBotChatsModal({
  open,
  onOpenChange,
  botId,
  botName,
}: TelegramBotChatsModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const chatsQuery = useQuery({
    queryKey: ['telegram-bot-chats', botId],
    enabled: open,
    queryFn: async () => {
      const res = await fetch(`/api/settings/telegram/bots/${botId}/chats`);
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.loadChatsFailed')));
      }
      return (await res.json()) as TelegramChatsResponse;
    },
  });

  const groupedChats = useMemo(() => {
    const chats = chatsQuery.data?.chats ?? [];
    return {
      pending: chats.filter((chat) => chat.status === 'pending'),
      authorized: chats.filter((chat) => chat.status === 'authorized'),
    };
  }, [chatsQuery.data?.chats]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
      queryClient.invalidateQueries({ queryKey: ['telegram-bot-chats', botId] }),
    ]);
  };

  const approveMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${botId}/chats/${encodeURIComponent(chatId)}/approve`,
        { method: 'POST' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.approveFailed')));
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const removeChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${botId}/chats/${encodeURIComponent(chatId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.removeFailed')));
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const testChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${botId}/chats/${encodeURIComponent(chatId)}/test`,
        { method: 'POST' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.testMessageFailed')));
      }
    },
    onSuccess: () => {
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid={`telegram-bot-chats-modal-${botId}`}>
        <DialogHeader>
          <DialogTitle>{t('telegram.chats')}</DialogTitle>
          <DialogDescription>{botName}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-semibold">
              <Shield className="h-4 w-4" />
              {t('telegram.pendingChats')}
            </h3>
            {groupedChats.pending.length === 0 && (
              <div className="text-xs text-muted-foreground">{t('telegram.noPendingChats')}</div>
            )}
            {groupedChats.pending.map((chat) => (
              <ChatRow
                key={`${chat.botId}-${chat.chatId}`}
                chat={chat}
                pending
                onApprove={() => approveMutation.mutate(chat.chatId)}
                onDelete={() => removeChatMutation.mutate(chat.chatId)}
              />
            ))}
          </div>

          <div className="space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-semibold">
              <Shield className="h-4 w-4" />
              {t('telegram.chats')}
            </h3>
            {groupedChats.authorized.length === 0 && (
              <div className="text-xs text-muted-foreground">{t('telegram.noAuthorizedChats')}</div>
            )}
            {groupedChats.authorized.map((chat) => (
              <ChatRow
                key={`${chat.botId}-${chat.chatId}`}
                chat={chat}
                pending={false}
                onTest={() => testChatMutation.mutate(chat.chatId)}
                onDelete={() => removeChatMutation.mutate(chat.chatId)}
              />
            ))}
          </div>

          {chatsQuery.isLoading && (
            <div className="text-xs text-muted-foreground lg:col-span-2">{t('common.loading')}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ChatRowProps {
  chat: TelegramBotChat;
  pending: boolean;
  onApprove?: () => void;
  onDelete: () => void;
  onTest?: () => void;
}

function ChatRow({ chat, pending, onApprove, onDelete, onTest }: ChatRowProps) {
  const { t } = useTranslation();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  return (
    <div className="space-y-2 rounded border-0 bg-background p-3">
      <div className="truncate text-sm font-medium" title={chat.displayName}>
        {chat.displayName}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('telegram.chatId')}：{chat.chatId}
      </div>
      <div className="text-xs text-muted-foreground">
        {new Date(chat.appliedAt).toLocaleString(toBCP47(language))}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {pending ? (
          <>
            <Button variant="outline" size="sm" onClick={onDelete}>
              {t('telegram.reject')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onApprove}>
              {t('telegram.authorize')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onTest}>
              <Send className="h-3.5 w-3.5" />
              {t('telegram.sendTestMessage')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
