import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LlmProviderDto } from '@tmex/shared';
import { Boxes, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { LlmProviderModelsModal } from './llm-provider-models-modal';
import { parseApiError } from './llm-providers-api';

function maskBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return baseUrl;
  }
}

interface LlmProviderRowProps {
  provider: LlmProviderDto;
  onEdit: (provider: LlmProviderDto) => void;
}

export function LlmProviderRow({ provider, onEdit }: LlmProviderRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showModelsModal, setShowModelsModal] = useState(false);

  const toggleEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/llm/providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.updateFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const refreshModelsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/llm/providers/${provider.id}/refresh-models`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.refreshModelsFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/llm/providers/${provider.id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.deleteFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      await queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`llm-provider-row-${provider.id}`}
      data-provider-name={provider.name}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Switch
          checked={provider.enabled}
          disabled={toggleEnabledMutation.isPending}
          onCheckedChange={(checked) => toggleEnabledMutation.mutate(Boolean(checked))}
          data-testid={`llm-provider-enabled-${provider.id}`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{provider.name}</span>
            <Badge variant="outline">{provider.protocol}</Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{maskBaseUrl(provider.baseUrl)}</span>
            <span aria-hidden>·</span>
            <span className="whitespace-nowrap">
              {t('settings.llm.modelsCount', { total: provider.models.length })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('settings.llm.refreshModels')}
          data-testid={`llm-provider-refresh-models-${provider.id}`}
          onClick={() => refreshModelsMutation.mutate()}
          disabled={refreshModelsMutation.isPending}
        >
          {refreshModelsMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('settings.llm.models')}
          data-testid={`llm-provider-models-${provider.id}`}
          onClick={() => setShowModelsModal(true)}
        >
          <Boxes className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`llm-provider-edit-${provider.id}`}
          onClick={() => onEdit(provider)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.delete')}
          data-testid={`llm-provider-delete-${provider.id}`}
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleteProviderMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <LlmProviderModelsModal
        open={showModelsModal}
        onOpenChange={setShowModelsModal}
        provider={provider}
      />

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.llm.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.llm.deleteConfirm', { name: provider.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowDeleteConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid={`llm-provider-delete-confirm-${provider.id}`}
              onClick={() => {
                deleteProviderMutation.mutate();
                setShowDeleteConfirm(false);
              }}
            >
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
