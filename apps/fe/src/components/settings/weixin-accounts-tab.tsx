import { useQuery } from '@tanstack/react-query';
import type { WeixinAccountWithStats } from '@tmex/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { WeixinAccountFormModal } from './weixin-account-form-modal';
import { WeixinAccountRow } from './weixin-account-row';

interface WeixinAccountsResponse {
  accounts: WeixinAccountWithStats[];
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function WeixinAccountsTab() {
  const { t } = useTranslation();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<WeixinAccountWithStats | undefined>(
    undefined
  );

  const accountsQuery = useQuery({
    queryKey: ['weixin-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/settings/weixin/accounts');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.loadAccountsFailed')));
      }
      return (await res.json()) as WeixinAccountsResponse;
    },
  });

  const accounts = accountsQuery.data?.accounts ?? [];

  const openAdd = () => {
    setEditingAccount(undefined);
    setModalOpen(true);
  };

  const openEdit = (account: WeixinAccountWithStats) => {
    setEditingAccount(account);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle>{t('weixin.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('weixin.subtitle')}</p>
          </div>
          <Button variant="secondary" data-testid="weixin-add-account" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('weixin.addAccount')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            {t('weixin.replyOnlyNotice')}
          </p>

          {accountsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!accountsQuery.isLoading && accounts.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('weixin.noAccounts')}</div>
          )}

          {accounts.map((account) => (
            <WeixinAccountRow key={account.id} account={account} onEdit={openEdit} />
          ))}
        </CardContent>
      </Card>

      <WeixinAccountFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        account={editingAccount}
      />
    </>
  );
}
