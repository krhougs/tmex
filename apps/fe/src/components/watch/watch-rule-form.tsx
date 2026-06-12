import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  AssistRegexResponse,
  CreateWatchRuleRequest,
  ListLlmProvidersResponse,
  UpdateWatchRuleRequest,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchRuleDto,
  WatchTriggerType,
} from '@tmex/shared';
import { Loader2, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { assistRegex, createWatchRule, updateWatchRule } from './api';

const TRIGGER_TYPES: WatchTriggerType[] = ['match', 'unchanged', 'llm'];
const FOLLOW_DEFAULT_VALUE = '__default__';

function minIntervalFor(triggerType: WatchTriggerType): number {
  return triggerType === 'llm' ? 30 : 5;
}

interface WatchRuleFormProps {
  deviceId: string;
  paneId: string;
  rule: WatchRuleDto | null;
  onSaved: (created: boolean) => void;
  onCancel: () => void;
}

export function WatchRuleForm({ deviceId, paneId, rule, onSaved, onCancel }: WatchRuleFormProps) {
  const { t } = useTranslation();
  const formId = useId();

  const [name, setName] = useState(rule?.name ?? '');
  const [triggerType, setTriggerType] = useState<WatchTriggerType>(rule?.triggerType ?? 'match');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [patternFlags, setPatternFlags] = useState(rule?.patternFlags ?? '');
  const [extractGroup, setExtractGroup] = useState(rule?.extractGroup ?? 0);
  const [unchangedMinutes, setUnchangedMinutes] = useState(rule?.unchangedMinutes ?? 10);
  const [noMatchBehavior, setNoMatchBehavior] = useState<WatchNoMatchBehavior>(
    rule?.noMatchBehavior ?? 'reset'
  );
  const [conditionPrompt, setConditionPrompt] = useState(rule?.conditionPrompt ?? '');
  const [providerId, setProviderId] = useState<string | null>(rule?.providerId ?? null);
  const [modelId, setModelId] = useState(rule?.modelId ?? '');
  const [confirmWithLlm, setConfirmWithLlm] = useState(rule?.confirmWithLlm ?? false);
  const [summarizeWithLlm, setSummarizeWithLlm] = useState(rule?.summarizeWithLlm ?? false);
  const [intervalSeconds, setIntervalSeconds] = useState(rule?.intervalSeconds ?? 30);
  const [fireMode, setFireMode] = useState<WatchFireMode>(rule?.fireMode ?? 'once');
  const [cooldownSeconds, setCooldownSeconds] = useState(rule?.cooldownSeconds ?? 600);

  const [assistDescription, setAssistDescription] = useState('');
  const [assistResult, setAssistResult] = useState<AssistRegexResponse | null>(null);

  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await fetch('/api/llm/providers');
      if (!res.ok) {
        throw new Error('Failed to load providers');
      }
      return (await res.json()) as ListLlmProvidersResponse;
    },
    throwOnError: false,
  });

  const providers = providersQuery.data?.providers ?? [];
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const modelOptions = selectedProvider?.models ?? [];

  const isRegexType = triggerType === 'match' || triggerType === 'unchanged';
  const needsModel = triggerType === 'llm' || confirmWithLlm || summarizeWithLlm;
  const minInterval = minIntervalFor(triggerType);

  const handleTriggerTypeChange = (next: WatchTriggerType): void => {
    setTriggerType(next);
    const nextMin = minIntervalFor(next);
    setIntervalSeconds((current) => {
      if (current < nextMin) {
        return next === 'llm' ? 60 : 30;
      }
      return current;
    });
  };

  const validate = (): string | null => {
    if (!name.trim()) {
      return t('watch.validation.nameRequired');
    }
    if (isRegexType) {
      if (!pattern) {
        return t('watch.validation.patternRequired');
      }
      try {
        // 与后端 compileWatchPattern 一致：g flag 由服务端自动追加，这里仅验证可编译
        new RegExp(pattern, patternFlags.replace(/g/g, ''));
      } catch (error) {
        return t('watch.validation.patternInvalid', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (triggerType === 'unchanged' && (!unchangedMinutes || unchangedMinutes <= 0)) {
        return t('watch.validation.unchangedMinutesInvalid');
      }
    } else if (!conditionPrompt.trim()) {
      return t('watch.validation.conditionPromptRequired');
    }
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < minInterval) {
      return t('watch.validation.intervalMin', { min: minInterval });
    }
    return null;
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const common = {
        name: name.trim(),
        triggerType,
        pattern: isRegexType ? pattern : null,
        patternFlags: isRegexType ? patternFlags : '',
        extractGroup,
        conditionPrompt: triggerType === 'llm' ? conditionPrompt : null,
        providerId,
        modelId: providerId ? modelId.trim() || null : null,
        confirmWithLlm: isRegexType ? confirmWithLlm : false,
        summarizeWithLlm: isRegexType ? summarizeWithLlm : false,
        intervalSeconds,
        unchangedMinutes: triggerType === 'unchanged' ? unchangedMinutes : null,
        noMatchBehavior,
        fireMode,
        cooldownSeconds,
      };
      if (rule) {
        const body: UpdateWatchRuleRequest = common;
        await updateWatchRule(rule.id, body);
        return false;
      }
      const body: CreateWatchRuleRequest = { ...common, deviceId, paneId, enabled: true };
      await createWatchRule(body);
      return true;
    },
    onSuccess: (created) => {
      toast.success(created ? t('watch.toast.created') : t('watch.toast.updated'));
      onSaved(created);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const assistMutation = useMutation({
    mutationFn: async () =>
      assistRegex({
        description: assistDescription.trim(),
        deviceId,
        paneId,
        providerId,
        modelId: providerId ? modelId.trim() || null : null,
      }),
    onSuccess: (result) => {
      setPattern(result.pattern);
      setPatternFlags(result.flags);
      setExtractGroup(result.extractGroup);
      setAssistResult(result);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const handleSubmit = (): void => {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    saveMutation.mutate();
  };

  return (
    <form
      data-testid="watch-rule-form"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor={`${formId}-name`}>
          {t('watch.form.name')}
        </label>
        <Input
          id={`${formId}-name`}
          data-testid="watch-form-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('watch.form.namePlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('watch.form.triggerType')}</span>
        <div className="grid gap-2">
          {TRIGGER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-testid={`watch-form-type-${type}`}
              onClick={() => handleTriggerTypeChange(type)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                triggerType === type
                  ? 'border-primary/50 bg-primary/10'
                  : 'border-border hover:bg-accent/40'
              )}
            >
              <span className="block text-sm font-medium">{t(`watch.type.${type}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`watch.typeDesc.${type}`)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {isRegexType && (
        <>
          <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
            <label className="block text-sm font-medium" htmlFor={`${formId}-assist`}>
              {t('watch.form.assistLabel')}
            </label>
            <div className="flex gap-2">
              <Input
                id={`${formId}-assist`}
                data-testid="watch-form-assist-input"
                value={assistDescription}
                onChange={(event) => setAssistDescription(event.target.value)}
                placeholder={t('watch.form.assistPlaceholder')}
              />
              <Button
                type="button"
                variant="secondary"
                data-testid="watch-form-assist-generate"
                disabled={!assistDescription.trim() || assistMutation.isPending}
                onClick={() => assistMutation.mutate()}
              >
                {assistMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {t('watch.form.assistButton')}
              </Button>
            </div>
            {assistResult && (
              <div className="space-y-1 text-xs" data-testid="watch-form-assist-result">
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t('watch.form.assistExplanation')}:
                  </span>{' '}
                  {assistResult.explanation}
                </p>
                <p className="font-medium text-foreground">{t('watch.form.assistPreview')}:</p>
                {assistResult.preview.length === 0 ? (
                  <p className="text-muted-foreground">{t('watch.form.assistPreviewEmpty')}</p>
                ) : (
                  <ul className="max-h-24 space-y-0.5 overflow-y-auto">
                    {assistResult.preview.map((hit, index) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: 预览命中是只读静态列表
                        key={index}
                        className="truncate rounded bg-muted px-1.5 py-0.5 font-mono"
                      >
                        {hit}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor={`${formId}-pattern`}>
                {t('watch.form.pattern')}
              </label>
              <Input
                id={`${formId}-pattern`}
                data-testid="watch-form-pattern"
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                placeholder={t('watch.form.patternPlaceholder')}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor={`${formId}-flags`}>
                {t('watch.form.flags')}
              </label>
              <Input
                id={`${formId}-flags`}
                data-testid="watch-form-flags"
                value={patternFlags}
                onChange={(event) => setPatternFlags(event.target.value)}
                placeholder={t('watch.form.flagsPlaceholder')}
                className="font-mono"
              />
            </div>
          </div>
        </>
      )}

      {triggerType === 'unchanged' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={`${formId}-extract-group`}>
              {t('watch.form.extractGroup')}
            </label>
            <Input
              id={`${formId}-extract-group`}
              data-testid="watch-form-extract-group"
              type="number"
              min={0}
              step={1}
              value={extractGroup}
              onChange={(event) => setExtractGroup(Math.max(0, Number(event.target.value) || 0))}
            />
            <p className="text-xs text-muted-foreground">{t('watch.form.extractGroupHint')}</p>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={`${formId}-unchanged-minutes`}>
              {t('watch.form.unchangedMinutes')}
            </label>
            <Input
              id={`${formId}-unchanged-minutes`}
              data-testid="watch-form-unchanged-minutes"
              type="number"
              min={1}
              step={1}
              value={unchangedMinutes}
              onChange={(event) =>
                setUnchangedMinutes(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </div>
          <div className="col-span-2 space-y-2">
            <span className="block text-sm font-medium">{t('watch.form.noMatchBehavior')}</span>
            <Select
              value={noMatchBehavior}
              onValueChange={(value) => {
                if (value === 'reset' || value === 'ignore') {
                  setNoMatchBehavior(value);
                }
              }}
            >
              <SelectTrigger className="w-full" data-testid="watch-form-no-match-behavior">
                <SelectValue>
                  {noMatchBehavior === 'reset'
                    ? t('watch.form.noMatchReset')
                    : t('watch.form.noMatchIgnore')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reset">{t('watch.form.noMatchReset')}</SelectItem>
                <SelectItem value="ignore">{t('watch.form.noMatchIgnore')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {triggerType === 'llm' && (
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`${formId}-condition`}>
            {t('watch.form.conditionPrompt')}
          </label>
          <Textarea
            id={`${formId}-condition`}
            data-testid="watch-form-condition-prompt"
            value={conditionPrompt}
            onChange={(event) => setConditionPrompt(event.target.value)}
            placeholder={t('watch.form.conditionPromptPlaceholder')}
            rows={3}
          />
        </div>
      )}

      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('watch.form.model')}</span>
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={providerId ?? FOLLOW_DEFAULT_VALUE}
            onValueChange={(value) => {
              if (!value) return;
              const next = value === FOLLOW_DEFAULT_VALUE ? null : value;
              setProviderId(next);
              if (next === null) {
                setModelId('');
              }
            }}
          >
            <SelectTrigger className="w-full" data-testid="watch-form-provider">
              <SelectValue>
                {selectedProvider?.name ?? t('watch.form.followGlobalDefault')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_DEFAULT_VALUE}>
                {t('watch.form.followGlobalDefault')}
              </SelectItem>
              {enabledProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            data-testid="watch-form-model"
            list={`${formId}-model-options`}
            value={modelId}
            disabled={!providerId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder={t('watch.form.modelPlaceholder')}
          />
          <datalist id={`${formId}-model-options`}>
            {modelOptions.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        {needsModel && (
          <p
            className="rounded-md bg-primary/10 px-2 py-1.5 text-xs text-primary"
            data-testid="watch-form-model-hint"
          >
            {t('watch.form.modelRequiredHint')}
          </p>
        )}
      </div>

      {isRegexType && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="block text-sm font-medium">{t('watch.form.confirmWithLlm')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('watch.form.confirmWithLlmDesc')}
              </span>
            </div>
            <Switch
              checked={confirmWithLlm}
              onCheckedChange={(checked) => setConfirmWithLlm(Boolean(checked))}
              data-testid="watch-form-confirm-llm"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="block text-sm font-medium">{t('watch.form.summarizeWithLlm')}</span>
              <span className="block text-xs text-muted-foreground">
                {t('watch.form.summarizeWithLlmDesc')}
              </span>
            </div>
            <Switch
              checked={summarizeWithLlm}
              onCheckedChange={(checked) => setSummarizeWithLlm(Boolean(checked))}
              data-testid="watch-form-summarize-llm"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`${formId}-interval`}>
            {t('watch.form.intervalSeconds')}
          </label>
          <Input
            id={`${formId}-interval`}
            data-testid="watch-form-interval"
            type="number"
            min={minInterval}
            step={1}
            value={intervalSeconds}
            onChange={(event) => setIntervalSeconds(Number(event.target.value) || 0)}
          />
          <p className="text-xs text-muted-foreground">
            {t('watch.form.intervalHint', { min: minInterval })}
          </p>
        </div>
        <div className="space-y-2">
          <span className="block text-sm font-medium">{t('watch.form.fireMode')}</span>
          <Select
            value={fireMode}
            onValueChange={(value) => {
              if (value === 'once' || value === 'repeat') {
                setFireMode(value);
              }
            }}
          >
            <SelectTrigger className="w-full" data-testid="watch-form-fire-mode">
              <SelectValue>
                {fireMode === 'once' ? t('watch.form.fireOnce') : t('watch.form.fireRepeat')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">{t('watch.form.fireOnce')}</SelectItem>
              <SelectItem value="repeat">{t('watch.form.fireRepeat')}</SelectItem>
            </SelectContent>
          </Select>
          {fireMode === 'repeat' && (
            <Input
              data-testid="watch-form-cooldown"
              type="number"
              min={0}
              step={1}
              value={cooldownSeconds}
              onChange={(event) => setCooldownSeconds(Math.max(0, Number(event.target.value) || 0))}
              aria-label={t('watch.form.cooldownSeconds')}
              placeholder={t('watch.form.cooldownSeconds')}
            />
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} data-testid="watch-form-cancel">
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={saveMutation.isPending} data-testid="watch-form-save">
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {rule ? t('watch.form.save') : t('watch.form.create')}
        </Button>
      </div>
    </form>
  );
}
