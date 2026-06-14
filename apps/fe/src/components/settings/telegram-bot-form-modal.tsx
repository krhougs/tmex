import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TelegramBotWithStats } from '@tmex/shared';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const FIELD_CLASS = 'min-h-10';

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface TelegramBotFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  bot?: TelegramBotWithStats;
}

export function TelegramBotFormModal({ open, onOpenChange, bot }: TelegramBotFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEdit = Boolean(bot);

  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [allowAuthRequests, setAllowAuthRequests] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(bot?.name ?? '');
    setToken('');
    setAllowAuthRequests(bot?.allowAuthRequests ?? true);
  }, [open, bot]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/telegram/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          token: token.trim(),
          enabled: true,
          allowAuthRequests,
        }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.createFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!bot) {
        throw new Error(t('telegram.updateFailed'));
      }
      const payload: Record<string, unknown> = {
        name: name.trim(),
        allowAuthRequests,
      };
      if (token.trim()) {
        payload.token = token.trim();
      }
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.updateFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = name.trim().length > 0 && (isEdit || token.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit || isPending) {
      return;
    }
    if (isEdit) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={isEdit ? `telegram-bot-edit-modal-${bot?.id}` : 'telegram-bot-add-modal'}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? t('telegram.editBot') : t('telegram.addBot')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="telegram-bot-name">
              {t('telegram.botName')}
            </label>
            <Input
              id="telegram-bot-name"
              data-testid="telegram-bot-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('telegram.botNamePlaceholder')}
              className={FIELD_CLASS}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="telegram-bot-token">
              {t('telegram.botToken')}
            </label>
            <Input
              id="telegram-bot-token"
              data-testid="telegram-bot-token-input"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={
                isEdit ? t('telegram.tokenPlaceholder') : t('telegram.botTokenPlaceholder')
              }
              className={FIELD_CLASS}
            />
          </div>

          <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
            <span className="text-sm font-medium">{t('telegram.allowAuthRequests')}</span>
            <Switch
              checked={allowAuthRequests}
              data-testid="telegram-bot-allow-auth"
              onCheckedChange={(checked) => setAllowAuthRequests(Boolean(checked))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid="telegram-bot-form-submit"
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
