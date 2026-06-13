import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LlmProviderDto,
  UpdateLlmProviderRequest,
  UpdateLlmProviderResponse,
} from '@tmex/shared';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { LlmProviderModels, type ModelDraft } from './llm-provider-models';
import { parseApiError } from './llm-providers-api';

interface LlmProviderModelsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: LlmProviderDto;
}

function toModelDrafts(provider: LlmProviderDto): ModelDraft[] {
  return provider.modelDetails.map((model) => ({
    id: model.id,
    source: model.source,
    enabled: model.enabled,
  }));
}

export function LlmProviderModelsModal({
  open,
  onOpenChange,
  provider,
}: LlmProviderModelsModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [models, setModels] = useState<ModelDraft[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setModels(toModelDrafts(provider));
  }, [open, provider]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const manualModels = models.filter((m) => m.source === 'manual').map((m) => m.id);
      const disabledModels = models.filter((m) => !m.enabled).map((m) => m.id);
      const payload: UpdateLlmProviderRequest = { manualModels, disabledModels };
      const res = await fetch(`/api/llm/providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.updateFailed')));
      }
      return (await res.json()) as UpdateLlmProviderResponse;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      if (data.modelsError) {
        toast.warning(t('settings.llm.modelsFetchFailed', { error: data.modelsError }));
      } else {
        toast.success(t('common.success'));
      }
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={`llm-provider-models-modal-${provider.id}`}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.llm.modelsTitle', { name: provider.name })}</DialogTitle>
          <DialogDescription>{t('settings.llm.modelsHint')}</DialogDescription>
        </DialogHeader>

        <LlmProviderModels models={models} onChange={setModels} />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            data-testid={`llm-provider-models-save-${provider.id}`}
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? (
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
