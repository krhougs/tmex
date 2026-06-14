import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentLlmSettingsDto,
  AgentSearchProvider,
  UpdateAgentLlmSettingsRequest,
} from '@tmex/shared';
import { Loader2, Save, Trash2 } from 'lucide-react';
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

const SEARCH_PROVIDER_OPTIONS: AgentSearchProvider[] = ['none', 'tavily', 'brave'];

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

export function SearchTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [searchProvider, setSearchProvider] = useState<AgentSearchProvider>('none');
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [braveApiKey, setBraveApiKey] = useState('');
  const [pendingClearKey, setPendingClearKey] = useState<'tavilyApiKey' | 'braveApiKey' | null>(
    null
  );

  const settingsQuery = useQuery({
    queryKey: ['llm-settings'],
    queryFn: async () => {
      const res = await fetch('/api/llm/settings');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.search.loadFailed')));
      }
      return (await res.json()) as LlmSettingsResponse;
    },
  });

  const settings = settingsQuery.data?.settings;
  const serverSearchProvider = settings?.searchProvider;

  useEffect(() => {
    if (!serverSearchProvider) {
      return;
    }
    setSearchProvider(serverSearchProvider);
  }, [serverSearchProvider]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateAgentLlmSettingsRequest = { searchProvider };
      if (tavilyApiKey.trim()) {
        payload.tavilyApiKey = tavilyApiKey.trim();
      }
      if (braveApiKey.trim()) {
        payload.braveApiKey = braveApiKey.trim();
      }
      const res = await fetch('/api/llm/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.search.saveFailed')));
      }
    },
    onSuccess: async () => {
      setTavilyApiKey('');
      setBraveApiKey('');
      await queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const clearKeyMutation = useMutation({
    mutationFn: async (key: 'tavilyApiKey' | 'braveApiKey') => {
      const payload: UpdateAgentLlmSettingsRequest = { [key]: '' };
      const res = await fetch('/api/llm/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.search.saveFailed')));
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

  const providerLabel = (provider: AgentSearchProvider): string => {
    if (provider === 'none') {
      return t('settings.search.providerNone');
    }
    return provider === 'tavily' ? 'Tavily' : 'Brave';
  };

  return (
    <Card className="border-0 ring-0" data-testid="settings-search-section">
      <CardHeader>
        <CardTitle>{t('settings.search.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="search-provider-select">
            {t('settings.search.provider')}
          </label>
          <Select
            value={searchProvider}
            onValueChange={(value) => {
              if (!value) return;
              setSearchProvider(value as AgentSearchProvider);
            }}
          >
            <SelectTrigger
              id="search-provider-select"
              data-testid="settings-search-provider-select"
              className="w-full min-h-10"
            >
              <SelectValue>{providerLabel(searchProvider)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SEARCH_PROVIDER_OPTIONS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {providerLabel(provider)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.search.responsesApiHint')}</p>
        </div>

        <ApiKeyField
          id="search-tavily-key-input"
          testId="settings-search-tavily"
          label={t('settings.search.tavilyApiKey')}
          value={tavilyApiKey}
          hasKey={settings?.hasTavilyApiKey ?? false}
          onChange={setTavilyApiKey}
          onClear={() => setPendingClearKey('tavilyApiKey')}
          clearing={clearKeyMutation.isPending && clearKeyMutation.variables === 'tavilyApiKey'}
        />

        <ApiKeyField
          id="search-brave-key-input"
          testId="settings-search-brave"
          label={t('settings.search.braveApiKey')}
          value={braveApiKey}
          hasKey={settings?.hasBraveApiKey ?? false}
          onChange={setBraveApiKey}
          onClear={() => setPendingClearKey('braveApiKey')}
          clearing={clearKeyMutation.isPending && clearKeyMutation.variables === 'braveApiKey'}
        />

        <AlertDialog
          open={pendingClearKey !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingClearKey(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.search.clearKey')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.search.clearKeyConfirm')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                data-testid="settings-search-clear-confirm"
                onClick={() => {
                  if (pendingClearKey) {
                    clearKeyMutation.mutate(pendingClearKey);
                  }
                  setPendingClearKey(null);
                }}
              >
                {t('settings.search.clearKey')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex justify-end">
          <Button
            variant="secondary"
            data-testid="settings-search-save"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || settingsQuery.isLoading}
            className="w-full sm:w-auto"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface ApiKeyFieldProps {
  id: string;
  testId: string;
  label: string;
  value: string;
  hasKey: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  clearing: boolean;
}

function ApiKeyField({
  id,
  testId,
  label,
  value,
  hasKey,
  onChange,
  onClear,
  clearing,
}: ApiKeyFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-testid={`${testId}-input`}
          data-key-set={hasKey ? 'true' : 'false'}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            hasKey ? t('settings.search.keySetPlaceholder') : t('settings.search.keyPlaceholder')
          }
          className="min-h-10"
        />
        {hasKey && (
          <Button
            variant="outline"
            size="sm"
            data-testid={`${testId}-clear`}
            onClick={onClear}
            disabled={clearing}
            className="shrink-0"
          >
            <Trash2 className="h-4 w-4" />
            {t('settings.search.clearKey')}
          </Button>
        )}
      </div>
    </div>
  );
}
