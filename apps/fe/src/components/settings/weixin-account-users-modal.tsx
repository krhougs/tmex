import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WeixinAccountUser } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { AlertTriangle, Send, Shield } from 'lucide-react';
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

interface WeixinUsersResponse {
  users: WeixinAccountUser[];
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

interface WeixinAccountUsersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
}

export function WeixinAccountUsersModal({
  open,
  onOpenChange,
  accountId,
  accountName,
}: WeixinAccountUsersModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ['weixin-account-users', accountId],
    enabled: open,
    queryFn: async () => {
      const res = await fetch(`/api/settings/weixin/accounts/${accountId}/users`);
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.loadUsersFailed')));
      }
      return (await res.json()) as WeixinUsersResponse;
    },
  });

  const groupedUsers = useMemo(() => {
    const users = usersQuery.data?.users ?? [];
    return {
      pending: users.filter((user) => user.status === 'pending'),
      authorized: users.filter((user) => user.status === 'authorized'),
    };
  }, [usersQuery.data?.users]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] }),
      queryClient.invalidateQueries({ queryKey: ['weixin-account-users', accountId] }),
    ]);
  };

  const approveMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/settings/weixin/accounts/${accountId}/users/${encodeURIComponent(userId)}/approve`,
        { method: 'POST' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.approveFailed')));
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('weixin.authApproved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const removeUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/settings/weixin/accounts/${accountId}/users/${encodeURIComponent(userId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.removeFailed')));
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('weixin.userRemoved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const testUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/settings/weixin/accounts/${accountId}/users/${encodeURIComponent(userId)}/test`,
        { method: 'POST' }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.testMessageFailed')));
      }
    },
    onSuccess: () => {
      toast.success(t('weixin.testMessageSent'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid={`weixin-account-users-modal-${accountId}`}
      >
        <DialogHeader>
          <DialogTitle>{t('weixin.authorizedUsers')}</DialogTitle>
          <DialogDescription>{accountName}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-semibold">
              <Shield className="h-4 w-4" />
              {t('weixin.pendingUsers')}
            </h3>
            {groupedUsers.pending.length === 0 && (
              <div className="text-xs text-muted-foreground">{t('weixin.noPendingUsers')}</div>
            )}
            {groupedUsers.pending.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                pending
                onApprove={() => approveMutation.mutate(user.userId)}
                onDelete={() => removeUserMutation.mutate(user.userId)}
              />
            ))}
          </div>

          <div className="space-y-2">
            <h3 className="flex items-center gap-1 text-sm font-semibold">
              <Shield className="h-4 w-4" />
              {t('weixin.authorizedUsers')}
            </h3>
            {groupedUsers.authorized.length === 0 && (
              <div className="text-xs text-muted-foreground">{t('weixin.noAuthorizedUsers')}</div>
            )}
            {groupedUsers.authorized.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                pending={false}
                onTest={() => testUserMutation.mutate(user.userId)}
                onDelete={() => removeUserMutation.mutate(user.userId)}
              />
            ))}
          </div>

          {usersQuery.isLoading && (
            <div className="text-xs text-muted-foreground lg:col-span-2">{t('common.loading')}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface UserRowProps {
  user: WeixinAccountUser;
  pending: boolean;
  onApprove?: () => void;
  onDelete: () => void;
  onTest?: () => void;
}

function UserRow({ user, pending, onApprove, onDelete, onTest }: UserRowProps) {
  const { t } = useTranslation();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  return (
    <div className="space-y-2 rounded border-0 bg-background p-3">
      <div className="truncate text-sm font-medium" title={user.displayName}>
        {user.displayName}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('weixin.userId')}：{user.userId}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('weixin.applyTime')}：{new Date(user.appliedAt).toLocaleString(toBCP47(language))}
      </div>

      {!pending && user.needsReactivation && (
        <div
          className="flex items-start gap-1.5 rounded bg-destructive/10 p-2 text-xs text-destructive"
          title={t('weixin.reactivationHint')}
          data-testid={`weixin-user-needs-reactivation-${user.id}`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">{t('weixin.needsReactivation')}</div>
            <div className="text-destructive/80">{t('weixin.reactivationHint')}</div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {pending ? (
          <>
            <Button variant="outline" size="sm" onClick={onDelete}>
              {t('weixin.removeUser')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onApprove}>
              {t('weixin.approve')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onTest}>
              <Send className="h-3.5 w-3.5" />
              {t('weixin.sendTestMessage')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              {t('weixin.revokeAuth')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
