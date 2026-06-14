import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentLlmSettingsDto,
  LlmProviderDto,
  UpdateAgentLlmSettingsRequest,
} from '@tmex/shared';
import { Loader2, Plus, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { LlmProviderFormModal } from './llm-provider-form-modal';
import { LlmProviderRow } from './llm-provider-row';
import { parseApiError } from './llm-providers-api';

interface ProvidersResponse {
  providers: LlmProviderDto[];
}

interface LlmSettingsResponse {
  settings: AgentLlmSettingsDto;
}

export function LlmProvidersTab() {
  const { t } = useTranslation();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<LlmProviderDto | undefined>(undefined);

  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await fetch('/api/llm/providers');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.loadFailed')));
      }
      return (await res.json()) as ProvidersResponse;
    },
  });

  const providers = providersQuery.data?.providers ?? [];

  const openAdd = () => {
    setEditingProvider(undefined);
    setModalOpen(true);
  };

  const openEdit = (provider: LlmProviderDto) => {
    setEditingProvider(provider);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0" data-testid="llm-providers-section">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{t('settings.llm.title')}</CardTitle>
          <Button variant="secondary" data-testid="llm-provider-add" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('settings.llm.addProvider')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {providersQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!providersQuery.isLoading && providers.length === 0 && (
            <div className="text-sm text-muted-foreground" data-testid="llm-providers-empty">
              {t('settings.llm.empty')}
            </div>
          )}

          {providers.map((provider) => (
            <LlmProviderRow key={provider.id} provider={provider} onEdit={openEdit} />
          ))}
        </CardContent>
      </Card>

      <LlmProviderFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        provider={editingProvider}
      />

      <LlmDefaultsCard providers={providers} />
    </>
  );
}

interface LlmDefaultsCardProps {
  providers: LlmProviderDto[];
}

const NONE_PROVIDER_VALUE = '__none__';

function LlmDefaultsCard({ providers }: LlmDefaultsCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [defaultModelId, setDefaultModelId] = useState('');

  const settingsQuery = useQuery({
    queryKey: ['llm-settings'],
    queryFn: async () => {
      const res = await fetch('/api/llm/settings');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.settingsLoadFailed')));
      }
      return (await res.json()) as LlmSettingsResponse;
    },
  });

  const serverDefaultProviderId = settingsQuery.data?.settings.defaultProviderId ?? null;
  const serverDefaultModelId = settingsQuery.data?.settings.defaultModelId ?? '';
  const settingsLoaded = Boolean(settingsQuery.data);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }
    setDefaultProviderId(serverDefaultProviderId);
    setDefaultModelId(serverDefaultModelId);
  }, [settingsLoaded, serverDefaultProviderId, serverDefaultModelId]);

  const saveDefaultsMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateAgentLlmSettingsRequest = {
        defaultProviderId,
        defaultModelId: defaultModelId.trim() || null,
      };
      const res = await fetch('/api/llm/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.llm.settingsSaveFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedProvider = providers.find((provider) => provider.id === defaultProviderId);
  const modelOptions = selectedProvider?.models ?? [];

  return (
    <Card className="border-0 ring-0" data-testid="llm-defaults-section">
      <CardHeader>
        <CardTitle>{t('settings.llm.defaults')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="llm-default-provider-select">
              {t('settings.llm.defaultProvider')}
            </label>
            <Select
              value={defaultProviderId ?? NONE_PROVIDER_VALUE}
              onValueChange={(value) => {
                if (!value) return;
                setDefaultProviderId(value === NONE_PROVIDER_VALUE ? null : value);
              }}
            >
              <SelectTrigger
                id="llm-default-provider-select"
                data-testid="llm-default-provider-select"
                className="h-9 w-full"
              >
                <SelectValue>
                  {selectedProvider?.name ?? t('settings.llm.defaultProviderNone')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_PROVIDER_VALUE}>
                  {t('settings.llm.defaultProviderNone')}
                </SelectItem>
                {enabledProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="llm-default-model-input">
              {t('settings.llm.defaultModel')}
            </label>
            <Input
              id="llm-default-model-input"
              data-testid="llm-default-model-input"
              list="llm-default-model-options"
              value={defaultModelId}
              onChange={(event) => setDefaultModelId(event.target.value)}
              placeholder={t('settings.llm.defaultModelPlaceholder')}
              className="h-9"
            />
            <datalist id="llm-default-model-options">
              {modelOptions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            variant="secondary"
            data-testid="llm-defaults-save"
            onClick={() => saveDefaultsMutation.mutate()}
            disabled={saveDefaultsMutation.isPending || settingsQuery.isLoading}
            className="w-full sm:w-auto"
          >
            {saveDefaultsMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('settings.llm.saveDefaults')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
