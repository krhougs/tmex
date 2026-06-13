import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type { GetAgentLlmSettingsResponse, LlmProviderDto } from '@tmex/shared';
import { useTranslation } from 'react-i18next';

const SEP = '::';

export function encodeModelValue(providerId: string | null, modelId: string): string {
  return `${providerId ?? ''}${SEP}${modelId}`;
}

function decodeModelValue(value: string): { providerId: string | null; modelId: string } {
  const idx = value.indexOf(SEP);
  if (idx < 0) return { providerId: null, modelId: value };
  const providerId = value.slice(0, idx);
  return { providerId: providerId || null, modelId: value.slice(idx + SEP.length) };
}

/** 为 session（或草稿）选择 provider+model；运行中禁用 */
export function ModelPicker({
  providerId,
  modelId,
  onChange,
  disabled,
  className,
}: {
  providerId: string | null;
  modelId: string | null;
  onChange: (providerId: string | null, modelId: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await fetch('/api/llm/providers');
      if (!res.ok) throw new Error('Failed to load providers');
      return (await res.json()) as { providers: LlmProviderDto[] };
    },
    throwOnError: false,
  });

  const { data: settingsData } = useQuery({
    queryKey: ['llm-settings'],
    queryFn: async () => {
      const res = await fetch('/api/llm/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      return (await res.json()) as GetAgentLlmSettingsResponse;
    },
    throwOnError: false,
  });

  const providers = (data?.providers ?? []).filter((p) => p.enabled && p.models.length > 0);

  // effective 选中 = 显式 providerId/modelId ?? 全局默认
  const effectiveProviderId = providerId ?? settingsData?.settings.defaultProviderId ?? null;
  const effectiveModelId = modelId ?? settingsData?.settings.defaultModelId ?? null;

  const current = effectiveModelId ? encodeModelValue(effectiveProviderId, effectiveModelId) : '';
  // 当前模型可能不在已启用列表里（如被禁用/旧值）——补一个占位项保证可显示
  const hasCurrent = providers.some(
    (p) => p.id === effectiveProviderId && p.models.includes(effectiveModelId ?? '')
  );

  const effectiveProviderName = providers.find((p) => p.id === effectiveProviderId)?.name ?? null;
  const triggerLabel = effectiveModelId
    ? effectiveProviderName
      ? `${effectiveProviderName}/${effectiveModelId}`
      : effectiveModelId
    : t('agent.model.placeholder');

  return (
    <Select
      value={current}
      onValueChange={(value) => {
        if (typeof value !== 'string' || !value) return;
        const decoded = decodeModelValue(value);
        onChange(decoded.providerId, decoded.modelId);
      }}
      disabled={disabled || providers.length === 0}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          'h-7 w-full min-w-0 border-transparent bg-transparent text-muted-foreground text-xs hover:border-border/40 dark:bg-transparent dark:hover:bg-transparent',
          className
        )}
        data-testid="agent-model-picker"
        aria-label={t('agent.model.select')}
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
      </SelectTrigger>
      <SelectContent>
        {!hasCurrent && effectiveModelId && (
          <SelectItem value={current} className="text-muted-foreground">
            {effectiveModelId}
          </SelectItem>
        )}
        {providers.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectLabel>{provider.name}</SelectLabel>
            {provider.models.map((model) => (
              <SelectItem
                key={`${provider.id}:${model}`}
                value={encodeModelValue(provider.id, model)}
              >
                {model}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
