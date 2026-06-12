import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentLlmSettingsDto,
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  LlmProviderDto,
  LlmProviderProtocol,
  UpdateAgentLlmSettingsRequest,
  UpdateLlmProviderRequest,
  UpdateLlmProviderResponse,
} from '@tmex/shared';
import { Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Switch } from '@/components/ui/switch';

const PROTOCOL_OPTIONS: LlmProviderProtocol[] = ['openai-chat', 'openai-responses'];

interface ProvidersResponse {
  providers: LlmProviderDto[];
}

interface LlmSettingsResponse {
  settings: AgentLlmSettingsDto;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function LlmProvidersTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [newName, setNewName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newProtocol, setNewProtocol] = useState<LlmProviderProtocol>('openai-chat');
  const [newApiKey, setNewApiKey] = useState('');

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

  const createProviderMutation = useMutation({
    mutationFn: async () => {
      const payload: CreateLlmProviderRequest = {
        name: newName.trim(),
        protocol: newProtocol,
        baseUrl: newBaseUrl.trim(),
        apiKey: newApiKey.trim(),
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
      setNewName('');
      setNewBaseUrl('');
      setNewProtocol('openai-chat');
      setNewApiKey('');
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      if (data.modelsError) {
        toast.warning(t('settings.llm.modelsFetchFailed', { error: data.modelsError }));
      } else {
        toast.success(t('common.success'));
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const providers = providersQuery.data?.providers ?? [];

  return (
    <>
      <Card className="border-0 ring-0" data-testid="llm-providers-section">
        <CardHeader>
          <CardTitle>{t('settings.llm.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
            <div className="md:col-span-3 space-y-2">
              <label className="block text-sm font-medium" htmlFor="new-llm-provider-name">
                {t('settings.llm.name')}
              </label>
              <Input
                id="new-llm-provider-name"
                data-testid="llm-provider-name-input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t('settings.llm.namePlaceholder')}
                className="min-h-10"
              />
            </div>

            <div className="md:col-span-4 space-y-2">
              <label className="block text-sm font-medium" htmlFor="new-llm-provider-baseurl">
                {t('settings.llm.baseUrl')}
              </label>
              <Input
                id="new-llm-provider-baseurl"
                data-testid="llm-provider-baseurl-input"
                value={newBaseUrl}
                onChange={(event) => setNewBaseUrl(event.target.value)}
                placeholder={t('settings.llm.baseUrlPlaceholder')}
                className="min-h-10"
              />
            </div>

            <div className="md:col-span-2 space-y-2">
              <label className="block text-sm font-medium" htmlFor="new-llm-provider-protocol">
                {t('settings.llm.protocol')}
              </label>
              <Select
                value={newProtocol}
                onValueChange={(value) => {
                  if (!value) return;
                  setNewProtocol(value as LlmProviderProtocol);
                }}
              >
                <SelectTrigger
                  id="new-llm-provider-protocol"
                  data-testid="llm-provider-protocol-select"
                  className="w-full min-h-10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROTOCOL_OPTIONS.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>
                      {protocol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-3 space-y-2">
              <label className="block text-sm font-medium" htmlFor="new-llm-provider-apikey">
                {t('settings.llm.apiKey')}
              </label>
              <Input
                id="new-llm-provider-apikey"
                data-testid="llm-provider-apikey-input"
                type="password"
                value={newApiKey}
                onChange={(event) => setNewApiKey(event.target.value)}
                placeholder={t('settings.llm.apiKeyPlaceholder')}
                className="min-h-10"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              variant="default"
              data-testid="llm-provider-add"
              onClick={() => createProviderMutation.mutate()}
              disabled={
                createProviderMutation.isPending ||
                !newName.trim() ||
                !newBaseUrl.trim() ||
                !newApiKey.trim()
              }
              className="w-full sm:w-auto"
            >
              {createProviderMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t('settings.llm.addProvider')}
            </Button>
          </div>

          <div className="space-y-3">
            {providersQuery.isLoading && (
              <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
            )}

            {!providersQuery.isLoading && providers.length === 0 && (
              <div className="text-sm text-muted-foreground" data-testid="llm-providers-empty">
                {t('settings.llm.empty')}
              </div>
            )}

            {providers.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} />
            ))}
          </div>
        </CardContent>
      </Card>

      <LlmDefaultsCard providers={providers} />
    </>
  );
}

interface ProviderCardProps {
  provider: LlmProviderDto;
}

function ProviderCard({ provider }: ProviderCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [protocol, setProtocol] = useState<LlmProviderProtocol>(provider.protocol);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);
  const [showModels, setShowModels] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setProtocol(provider.protocol);
    setEnabled(provider.enabled);
  }, [provider.name, provider.baseUrl, provider.protocol, provider.enabled]);

  const patchProviderMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateLlmProviderRequest = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        protocol,
        enabled,
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
      setApiKey('');
      await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
      if (data.modelsError) {
        toast.warning(t('settings.llm.modelsFetchFailed', { error: data.modelsError }));
      } else {
        toast.success(t('common.success'));
      }
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
      toast.success(t('common.success'));
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

  return (
    <div
      className="space-y-4 rounded-md border-0 bg-card p-4"
      data-testid={`llm-provider-card-${provider.id}`}
      data-provider-name={provider.name}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
        <div className="md:col-span-3 space-y-2">
          <label className="block text-sm font-medium" htmlFor={`llm-provider-name-${provider.id}`}>
            {t('settings.llm.name')}
          </label>
          <Input
            id={`llm-provider-name-${provider.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-h-10"
          />
        </div>
        <div className="md:col-span-4 space-y-2">
          <label
            className="block text-sm font-medium"
            htmlFor={`llm-provider-baseurl-${provider.id}`}
          >
            {t('settings.llm.baseUrl')}
          </label>
          <Input
            id={`llm-provider-baseurl-${provider.id}`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="min-h-10"
          />
        </div>
        <div className="md:col-span-2 space-y-2">
          <label
            className="block text-sm font-medium"
            htmlFor={`llm-provider-protocol-${provider.id}`}
          >
            {t('settings.llm.protocol')}
          </label>
          <Select
            value={protocol}
            onValueChange={(value) => {
              if (!value) return;
              setProtocol(value as LlmProviderProtocol);
            }}
          >
            <SelectTrigger id={`llm-provider-protocol-${provider.id}`} className="w-full min-h-10">
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
        <div className="md:col-span-3 space-y-2">
          <label
            className="block text-sm font-medium"
            htmlFor={`llm-provider-apikey-${provider.id}`}
          >
            {t('settings.llm.apiKey')}
          </label>
          <Input
            id={`llm-provider-apikey-${provider.id}`}
            data-testid={`llm-provider-apikey-${provider.id}`}
            data-key-set={provider.hasApiKey ? 'true' : 'false'}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              provider.hasApiKey
                ? t('settings.llm.apiKeySetPlaceholder')
                : t('settings.llm.apiKeyPlaceholder')
            }
            className="min-h-10"
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-h-10 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2">
            <span className="text-sm font-medium">{t('common.enabled')}</span>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              data-testid={`llm-provider-enabled-${provider.id}`}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid={`llm-provider-refresh-models-${provider.id}`}
            onClick={() => refreshModelsMutation.mutate()}
            disabled={refreshModelsMutation.isPending}
          >
            {refreshModelsMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('settings.llm.refreshModels')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`llm-provider-toggle-models-${provider.id}`}
            onClick={() => setShowModels((prev) => !prev)}
          >
            {provider.models.length > 0
              ? t('settings.llm.modelsCount', { total: provider.models.length })
              : t('settings.llm.modelsNotFetched')}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            data-testid={`llm-provider-delete-${provider.id}`}
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleteProviderMutation.isPending}
          >
            <Trash2 className="h-4 w-4" />
            {t('common.delete')}
          </Button>
          <Button
            variant="default"
            size="sm"
            data-testid={`llm-provider-save-${provider.id}`}
            onClick={() => patchProviderMutation.mutate()}
            disabled={patchProviderMutation.isPending || !name.trim() || !baseUrl.trim()}
          >
            {patchProviderMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </div>
      </div>

      {showModels && provider.models.length > 0 && (
        <div
          className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background p-3"
          data-testid={`llm-provider-models-${provider.id}`}
        >
          <ul className="space-y-1">
            {provider.models.map((model) => (
              <li key={model} className="font-mono text-xs text-muted-foreground">
                {model}
              </li>
            ))}
          </ul>
        </div>
      )}

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

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings) {
      return;
    }
    setDefaultProviderId(settings.defaultProviderId);
    setDefaultModelId(settings.defaultModelId ?? '');
  }, [settingsQuery.data?.settings]);

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
                className="w-full min-h-10"
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
              className="min-h-10"
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
            variant="default"
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
