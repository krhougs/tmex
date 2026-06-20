import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WeixinAccountWithStats } from '@tmex/shared';
import { AlertTriangle, Pencil, QrCode, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { WeixinAccountLoginModal } from './weixin-account-login-modal';
import { WeixinAccountUsersModal } from './weixin-account-users-modal';

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface WeixinAccountRowProps {
  account: WeixinAccountWithStats;
  onEdit: (account: WeixinAccountWithStats) => void;
}

export function WeixinAccountRow({ account, onEdit }: WeixinAccountRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showUsers, setShowUsers] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const toggleEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/settings/weixin/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.updateFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/weixin/accounts/${account.id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.deleteFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
      toast.success(t('weixin.accountDeleted'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`weixin-account-card-${account.id}`}
      data-account-name={account.name}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Switch
          checked={account.enabled}
          disabled={toggleEnabledMutation.isPending}
          onCheckedChange={(checked) => toggleEnabledMutation.mutate(Boolean(checked))}
          data-testid={`weixin-account-enabled-${account.id}`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{account.name}</span>
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                account.loggedIn
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              )}
              data-testid={`weixin-account-login-state-${account.id}`}
            >
              {account.loggedIn ? t('weixin.loggedIn') : t('weixin.notLoggedIn')}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {t('weixin.userCount', {
              authorized: account.authorizedCount,
              pending: account.pendingCount,
            })}
          </div>
          {account.needsReactivationCount > 0 && (
            <div
              className="mt-0.5 flex items-center gap-1 text-xs font-medium text-destructive"
              data-testid={`weixin-account-needs-reactivation-${account.id}`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('weixin.needsReactivation')}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={account.loggedIn ? t('weixin.relogin') : t('weixin.scanToLogin')}
          data-testid={`weixin-account-login-${account.id}`}
          onClick={() => setShowLogin(true)}
        >
          <QrCode className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('weixin.authorizedUsers')}
          data-testid={`weixin-account-users-${account.id}`}
          onClick={() => setShowUsers(true)}
        >
          <Users className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`weixin-account-edit-${account.id}`}
          onClick={() => onEdit(account)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('weixin.deleteAccount')}
          data-testid={`weixin-account-delete-${account.id}`}
          onClick={() => deleteAccountMutation.mutate()}
          disabled={deleteAccountMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <WeixinAccountLoginModal
        open={showLogin}
        onOpenChange={setShowLogin}
        accountId={account.id}
        accountName={account.name}
      />

      <WeixinAccountUsersModal
        open={showUsers}
        onOpenChange={setShowUsers}
        accountId={account.id}
        accountName={account.name}
      />
    </div>
  );
}
