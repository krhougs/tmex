import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WeixinAccountWithStats } from '@tmex/shared';
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

import { WeixinAccountLoginModal } from './weixin-account-login-modal';

const FIELD_CLASS = 'min-h-10';

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface CreateAccountResponse {
  success: boolean;
  accountId: string;
}

interface WeixinAccountFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  account?: WeixinAccountWithStats;
}

export function WeixinAccountFormModal({
  open,
  onOpenChange,
  account,
}: WeixinAccountFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEdit = Boolean(account);

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);

  const [loginAccount, setLoginAccount] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(account?.name ?? '');
    setEnabled(account?.enabled ?? true);
  }, [open, account]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/weixin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          enabled,
          allowAuthRequests: true,
        }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.createFailed')));
      }
      return (await res.json()) as CreateAccountResponse;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
      toast.success(t('weixin.accountCreated'));
      onOpenChange(false);
      setLoginAccount({ id: data.accountId, name: name.trim() });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!account) {
        throw new Error(t('weixin.updateFailed'));
      }
      const res = await fetch(`/api/settings/weixin/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          enabled,
        }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.updateFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
      toast.success(t('weixin.accountUpdated'));
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = name.trim().length > 0;

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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg"
          data-testid={
            isEdit ? `weixin-account-edit-modal-${account?.id}` : 'weixin-account-add-modal'
          }
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? t('weixin.editAccount') : t('weixin.addAccount')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="weixin-account-name">
                {t('weixin.accountName')}
              </label>
              <Input
                id="weixin-account-name"
                data-testid="weixin-account-name-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('weixin.accountNamePlaceholder')}
                className={FIELD_CLASS}
              />
            </div>

            <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="text-sm font-medium">{t('weixin.enableAccount')}</span>
              <Switch
                checked={enabled}
                data-testid="weixin-account-enabled"
                onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              data-testid="weixin-account-form-submit"
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

      {loginAccount && (
        <WeixinAccountLoginModal
          open={Boolean(loginAccount)}
          onOpenChange={(next) => {
            if (!next) {
              setLoginAccount(null);
            }
          }}
          accountId={loginAccount.id}
          accountName={loginAccount.name}
        />
      )}
    </>
  );
}
