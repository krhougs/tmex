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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WatchRuleDto } from '@tmex/shared';
import { Activity, ArrowLeft, Bell, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  deleteWatchRule,
  fetchWatchRuleState,
  fetchWatchRules,
  updateWatchRule,
  watchRuleStateQueryKey,
  watchRulesQueryKey,
} from './api';
import { WatchRuleForm } from './watch-rule-form';

type DialogView =
  | { mode: 'list' }
  | { mode: 'form'; rule: WatchRuleDto | null }
  | { mode: 'state'; rule: WatchRuleDto };

interface WatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
}

function formatTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString();
}

export function WatchDialog({ open, onOpenChange, deviceId, paneId }: WatchDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [view, setView] = useState<DialogView>({ mode: 'list' });
  const [deleteCandidate, setDeleteCandidate] = useState<WatchRuleDto | null>(null);
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  useEffect(() => {
    if (!open) {
      setView({ mode: 'list' });
      setDeleteCandidate(null);
      setShowNotifBanner(false);
    }
  }, [open]);

  const rulesQuery = useQuery({
    queryKey: watchRulesQueryKey(deviceId, paneId),
    queryFn: () => fetchWatchRules(deviceId, paneId),
    enabled: open,
    throwOnError: false,
  });

  const invalidateRules = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['watch-rules'] });
  };

  const toggleMutation = useMutation({
    mutationFn: async ({ rule, enabled }: { rule: WatchRuleDto; enabled: boolean }) => {
      await updateWatchRule(rule.id, { enabled });
    },
    onSuccess: invalidateRules,
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
      invalidateRules();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (rule: WatchRuleDto) => {
      await deleteWatchRule(rule.id);
    },
    onSuccess: () => {
      toast.success(t('watch.toast.deleted'));
      invalidateRules();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const handleSaved = (created: boolean): void => {
    invalidateRules();
    setView({ mode: 'list' });
    if (created && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setShowNotifBanner(true);
    }
  };

  const rules = rulesQuery.data ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]"
          data-testid="watch-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {view.mode === 'list' && t('watch.title')}
              {view.mode === 'form' &&
                (view.rule ? t('watch.form.editTitle') : t('watch.form.createTitle'))}
              {view.mode === 'state' && t('watch.state.title')}
            </DialogTitle>
            <DialogDescription>
              {view.mode === 'list' ? t('watch.dialogDesc') : null}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto pr-1">
            {view.mode === 'list' && (
              <div className="space-y-3">
                {showNotifBanner && (
                  <div
                    className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3"
                    data-testid="watch-notif-banner"
                  >
                    <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t('watch.notifPermission.title')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('watch.notifPermission.desc')}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          data-testid="watch-notif-enable"
                          onClick={() => {
                            void Notification.requestPermission().finally(() =>
                              setShowNotifBanner(false)
                            );
                          }}
                        >
                          {t('watch.notifPermission.enable')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowNotifBanner(false)}>
                          {t('watch.notifPermission.dismiss')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {rulesQuery.isLoading && (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!rulesQuery.isLoading && rules.length === 0 && (
                  <p
                    className="py-6 text-center text-sm text-muted-foreground"
                    data-testid="watch-rules-empty"
                  >
                    {t('watch.rules.empty')}
                  </p>
                )}

                {rules.map((rule) => (
                  <WatchRuleRow
                    key={rule.id}
                    rule={rule}
                    onToggle={(enabled) => toggleMutation.mutate({ rule, enabled })}
                    onEdit={() => setView({ mode: 'form', rule })}
                    onViewState={() => setView({ mode: 'state', rule })}
                    onDelete={() => setDeleteCandidate(rule)}
                  />
                ))}

                <Button
                  variant="outline"
                  className="w-full"
                  data-testid="watch-rule-add"
                  onClick={() => setView({ mode: 'form', rule: null })}
                >
                  <Plus className="h-4 w-4" />
                  {t('watch.rules.addRule')}
                </Button>
              </div>
            )}

            {view.mode === 'form' && (
              <WatchRuleForm
                deviceId={deviceId}
                paneId={paneId}
                rule={view.rule}
                onSaved={handleSaved}
                onCancel={() => setView({ mode: 'list' })}
              />
            )}

            {view.mode === 'state' && (
              <WatchRuleStateView rule={view.rule} onBack={() => setView({ mode: 'list' })} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(nextOpen) => !nextOpen && setDeleteCandidate(null)}
      >
        <AlertDialogContent data-testid="watch-rule-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('watch.rules.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('watch.rules.deleteDesc', { name: deleteCandidate?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="watch-rule-delete-confirm"
              onClick={() => {
                if (deleteCandidate) {
                  deleteMutation.mutate(deleteCandidate);
                }
                setDeleteCandidate(null);
              }}
            >
              {t('watch.rules.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface WatchRuleRowProps {
  rule: WatchRuleDto;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onViewState: () => void;
  onDelete: () => void;
}

function WatchRuleRow({ rule, onToggle, onEdit, onViewState, onDelete }: WatchRuleRowProps) {
  const { t } = useTranslation();

  const stateQuery = useQuery({
    queryKey: watchRuleStateQueryKey(rule.id),
    queryFn: () => fetchWatchRuleState(rule.id),
    throwOnError: false,
  });

  const lastTriggeredAt = formatTime(stateQuery.data?.state?.lastTriggeredAt);

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid={`watch-rule-item-${rule.id}`}
      data-rule-name={rule.name}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="secondary">{t(`watch.type.${rule.triggerType}`)}</Badge>
        <Switch
          checked={rule.enabled}
          onCheckedChange={(checked) => onToggle(Boolean(checked))}
          data-testid={`watch-rule-toggle-${rule.id}`}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {lastTriggeredAt
            ? t('watch.rules.lastTriggered', { time: lastTriggeredAt })
            : t('watch.rules.neverTriggered')}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onViewState}
            title={t('watch.rules.viewState')}
            aria-label={t('watch.rules.viewState')}
            data-testid={`watch-rule-state-${rule.id}`}
          >
            <Activity className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            title={t('watch.rules.edit')}
            aria-label={t('watch.rules.edit')}
            data-testid={`watch-rule-edit-${rule.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            title={t('watch.rules.delete')}
            aria-label={t('watch.rules.delete')}
            data-testid={`watch-rule-delete-${rule.id}`}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface WatchRuleStateViewProps {
  rule: WatchRuleDto;
  onBack: () => void;
}

function WatchRuleStateView({ rule, onBack }: WatchRuleStateViewProps) {
  const { t } = useTranslation();

  const stateQuery = useQuery({
    queryKey: watchRuleStateQueryKey(rule.id),
    queryFn: () => fetchWatchRuleState(rule.id),
    refetchInterval: 5000,
    throwOnError: false,
  });

  const state = stateQuery.data?.state ?? null;
  const samples = stateQuery.data?.samples ?? [];
  const none = t('watch.state.none');

  const fields: Array<{ label: string; value: string }> = [
    { label: t('watch.state.lastSampledAt'), value: formatTime(state?.lastSampledAt) ?? none },
    { label: t('watch.state.lastValue'), value: state?.lastValue ?? none },
    {
      label: t('watch.state.lastValueChangedAt'),
      value: formatTime(state?.lastValueChangedAt) ?? none,
    },
    { label: t('watch.state.lastTriggeredAt'), value: formatTime(state?.lastTriggeredAt) ?? none },
    {
      label: t('watch.state.consecutiveErrors'),
      value: state ? String(state.consecutiveErrors) : none,
    },
    { label: t('watch.state.lastError'), value: state?.lastError ?? none },
  ];

  return (
    <div className="space-y-3" data-testid="watch-rule-state-view">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('watch.state.back')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="secondary">{t(`watch.type.${rule.triggerType}`)}</Badge>
      </div>

      {stateQuery.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-all">{field.value}</dd>
              </div>
            ))}
          </dl>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('watch.state.samples')}</p>
            {samples.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('watch.state.samplesEmpty')}</p>
            ) : (
              <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
                {[...samples].reverse().map((sample) => (
                  <li
                    key={sample.at}
                    className="flex items-center gap-2 rounded bg-muted/60 px-2 py-1"
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatTime(sample.at) ?? sample.at}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {sample.value ?? none}
                    </span>
                    {sample.hit && (
                      <Badge variant="default" className="h-4 px-1 text-[10px]">
                        {t('watch.state.hit')}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
