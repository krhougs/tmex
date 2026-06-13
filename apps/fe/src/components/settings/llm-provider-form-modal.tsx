import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  LlmProviderDto,
  LlmProviderProtocol,
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { parseApiError } from './llm-providers-api';

const PROTOCOL_OPTIONS: LlmProviderProtocol[] = ['openai-chat', 'openai-responses'];

const FIELD_CLASS = 'h-9 w-full';

interface LlmProviderFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  provider?: LlmProviderDto;
}

export function LlmProviderFormModal({ open, onOpenChange, provider }: LlmProviderFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEdit = Boolean(provider);

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<LlmProviderProtocol>('openai-chat');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(provider?.name ?? '');
    setBaseUrl(provider?.baseUrl ?? '');
    setProtocol(provider?.protocol ?? 'openai-chat');
    setApiKey('');
  }, [open, provider]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload: CreateLlmProviderRequest = {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        enabled: true,
      };
      const res = await fetch('/api/llm/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.createFailed')));
      }
      return (await res.json()) as CreateLlmProviderResponse;
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

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!provider) {
        throw new Error(t('settings.llm.updateFailed'));
      }
      const payload: UpdateLlmProviderRequest = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        protocol,
      };
      if (apiKey.trim()) {
        payload.apiKey = apiKey.trim();
      }
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

  const isPending = createMutation.isPending || updateMutation.isPending;
  const canSubmit =
    name.trim().length > 0 && baseUrl.trim().length > 0 && (isEdit || apiKey.trim().length > 0);

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
        data-testid={isEdit ? `llm-provider-edit-modal-${provider?.id}` : 'llm-provider-add-modal'}
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('settings.llm.editProvider') : t('settings.llm.addProvider')}
          </DialogTitle>
          <DialogDescription>{t('settings.llm.formHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="llm-form-name">
              {t('settings.llm.name')}
            </label>
            <Input
              id="llm-form-name"
              data-testid="llm-provider-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('settings.llm.namePlaceholder')}
              className={FIELD_CLASS}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="llm-form-baseurl">
              {t('settings.llm.baseUrl')}
            </label>
            <Input
              id="llm-form-baseurl"
              data-testid="llm-provider-baseurl-input"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t('settings.llm.baseUrlPlaceholder')}
              className={FIELD_CLASS}
            />
            <p className="text-xs text-muted-foreground">{t('settings.llm.baseUrlHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="llm-form-protocol">
              {t('settings.llm.protocol')}
            </label>
            <Select
              value={protocol}
              onValueChange={(value) => {
                if (!value) return;
                setProtocol(value as LlmProviderProtocol);
              }}
            >
              <SelectTrigger
                id="llm-form-protocol"
                data-testid="llm-provider-protocol-select"
                className={FIELD_CLASS}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOL_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="llm-form-apikey">
              {t('settings.llm.apiKey')}
            </label>
            <Input
              id="llm-form-apikey"
              data-testid="llm-provider-apikey-input"
              data-key-set={provider?.hasApiKey ? 'true' : 'false'}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                provider?.hasApiKey
                  ? t('settings.llm.apiKeySetPlaceholder')
                  : t('settings.llm.apiKeyPlaceholder')
              }
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="llm-provider-form-submit"
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
