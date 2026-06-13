import type { LlmModelInfo } from '@tmex/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

export interface ModelDraft {
  id: string;
  source: LlmModelInfo['source'];
  enabled: boolean;
}

interface LlmProviderModelsProps {
  models: ModelDraft[];
  onChange: (models: ModelDraft[]) => void;
}

export function LlmProviderModels({ models, onChange }: LlmProviderModelsProps) {
  const { t } = useTranslation();
  const [draftId, setDraftId] = useState('');

  const toggleModel = (id: string, enabled: boolean) => {
    onChange(models.map((model) => (model.id === id ? { ...model, enabled } : model)));
  };

  const removeManualModel = (id: string) => {
    onChange(models.filter((model) => model.id !== id));
  };

  const addManualModel = () => {
    const id = draftId.trim();
    if (!id) {
      return;
    }
    if (models.some((model) => model.id === id)) {
      setDraftId('');
      return;
    }
    onChange([...models, { id, source: 'manual', enabled: true }]);
    setDraftId('');
  };

  return (
    <div className="space-y-3" data-testid="llm-provider-models">
      <div className="flex items-center gap-2">
        <Input
          value={draftId}
          onChange={(event) => setDraftId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addManualModel();
            }
          }}
          placeholder={t('settings.llm.addModelPlaceholder')}
          className="h-9"
          data-testid="llm-provider-add-model-input"
        />
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={addManualModel}
          disabled={!draftId.trim()}
          data-testid="llm-provider-add-model"
        >
          <Plus className="h-4 w-4" />
          {t('common.add')}
        </Button>
      </div>

      {models.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('settings.llm.modelsNotFetched')}</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-2">
          {models.map((model) => (
            <li
              key={model.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
              data-testid={`llm-provider-model-${model.id}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Switch
                  checked={model.enabled}
                  onCheckedChange={(checked) => toggleModel(model.id, Boolean(checked))}
                  data-testid={`llm-provider-model-toggle-${model.id}`}
                />
                <span className="truncate font-mono text-xs">{model.id}</span>
                {model.source === 'manual' && (
                  <Badge variant="secondary">{t('settings.llm.modelManual')}</Badge>
                )}
              </div>
              {model.source === 'manual' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeManualModel(model.id)}
                  data-testid={`llm-provider-model-remove-${model.id}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
