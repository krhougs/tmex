import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventType, WebhookEndpoint } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useSiteStore } from '@/stores/site';

export const WEBHOOK_EVENT_OPTIONS: EventType[] = [
  'terminal_bell',
  'terminal_notification',
  'tmux_window_close',
  'tmux_pane_close',
  'device_tmux_missing',
  'device_disconnect',
  'session_created',
  'session_closed',
  'agent_confirmation_pending',
  'agent_turn_finished',
  'agent_error',
  'watch_triggered',
  'watch_model_unavailable',
  'watch_rule_error',
];

interface WebhooksResponse {
  webhooks: WebhookEndpoint[];
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function WebhooksTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookSecret, setNewWebhookSecret] = useState('');
  const [newWebhookEventMask, setNewWebhookEventMask] =
    useState<EventType[]>(WEBHOOK_EVENT_OPTIONS);

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: async () => {
      const res = await fetch('/api/webhooks');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('webhook.loadFailed')));
      }
      return (await res.json()) as WebhooksResponse;
    },
  });

  const createWebhookMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: newWebhookUrl,
          secret: newWebhookSecret,
          eventMask: newWebhookEventMask,
        }),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('webhook.createFailed')));
      }
    },
    onSuccess: async () => {
      setNewWebhookUrl('');
      setNewWebhookSecret('');
      setNewWebhookEventMask(WEBHOOK_EVENT_OPTIONS);
      await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deleteWebhookMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('webhook.deleteFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const webhooks = webhooksQuery.data?.webhooks ?? [];

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('webhook.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
          <div className="md:col-span-6 space-y-2">
            <label className="block text-sm font-medium" htmlFor="webhook-url-input">
              {t('webhook.url')}
            </label>
            <Input
              id="webhook-url-input"
              data-testid="webhook-url-input"
              value={newWebhookUrl}
              onChange={(event) => setNewWebhookUrl(event.target.value)}
              placeholder="https://example.com/webhook"
              className="min-h-10"
            />
          </div>

          <div className="md:col-span-4 space-y-2">
            <label className="block text-sm font-medium" htmlFor="webhook-secret-input">
              {t('webhook.secret')}
            </label>
            <Input
              id="webhook-secret-input"
              data-testid="webhook-secret-input"
              value={newWebhookSecret}
              onChange={(event) => setNewWebhookSecret(event.target.value)}
              placeholder={t('webhook.secretPlaceholder')}
              className="min-h-10"
            />
          </div>

          <div className="md:col-span-2">
            <Button
              variant="secondary"
              className="w-full md:w-auto"
              data-testid="webhook-add"
              onClick={() => createWebhookMutation.mutate()}
              disabled={
                createWebhookMutation.isPending ||
                !newWebhookUrl.trim() ||
                !newWebhookSecret.trim() ||
                newWebhookEventMask.length === 0
              }
            >
              {createWebhookMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t('webhook.add')}
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-sm font-medium">{t('webhook.eventMask')}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {WEBHOOK_EVENT_OPTIONS.map((eventType) => {
              const checked = newWebhookEventMask.includes(eventType);
              return (
                <div
                  key={eventType}
                  className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2"
                >
                  <div className="min-w-0 pr-2 text-sm font-medium">
                    {t(`notification.eventType.${eventType}` as const)}
                  </div>
                  <Switch
                    checked={checked}
                    data-testid={`webhook-event-${eventType}`}
                    onCheckedChange={(nextChecked) => {
                      setNewWebhookEventMask((prev) => {
                        if (nextChecked) {
                          return prev.includes(eventType) ? prev : [...prev, eventType];
                        }
                        return prev.filter((item) => item !== eventType);
                      });
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          {webhooksQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!webhooksQuery.isLoading && webhooks.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('webhook.empty')}</div>
          )}

          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              data-testid="webhook-item"
              data-webhook-url={webhook.url}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{webhook.url}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(webhook.createdAt).toLocaleString(toBCP47(language))}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="webhook-delete"
                onClick={() => deleteWebhookMutation.mutate(webhook.id)}
                disabled={deleteWebhookMutation.isPending}
                aria-label={t('common.delete')}
                title={t('common.delete')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
