import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemInfo, UpdateCheckResult, UpgradeStatus } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { MarkdownPreview } from '@/components/markdown/markdown-preview';
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
import { useSiteStore } from '../../stores/site';

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
      <div className="min-w-0 pr-2 text-sm font-medium">{label}</div>
      <div className="min-w-0 truncate text-right text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

export function VersionTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const [showConfirm, setShowConfirm] = useState(false);
  // 是否已触发本次升级（用于跨服务重启的完成检测）
  const [pending, setPending] = useState(false);
  const sawActiveRef = useRef(false);

  const infoQuery = useQuery({
    queryKey: ['system-info'],
    queryFn: async () => {
      const res = await fetch('/api/system/info');
      if (!res.ok) throw new Error(await parseApiError(res, t('settings.loadFailed')));
      return (await res.json()) as SystemInfo;
    },
  });
  const info = infoQuery.data;

  const updateQuery = useQuery({
    queryKey: ['system-update-check'],
    enabled: false,
    gcTime: 0,
    queryFn: async () => {
      const res = await fetch('/api/system/update-check');
      if (!res.ok) throw new Error(await parseApiError(res, t('settings.version.checkFailed')));
      return (await res.json()) as UpdateCheckResult;
    },
  });
  const update = updateQuery.data;

  const upgradeStatusQuery = useQuery({
    queryKey: ['system-upgrade-status'],
    enabled: pending,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (pending || (state && state !== 'idle')) return 2000;
      return false;
    },
    retry: true,
    queryFn: async () => {
      const res = await fetch('/api/system/upgrade');
      if (!res.ok) throw new Error('status');
      return (await res.json()) as UpgradeStatus;
    },
  });
  const upgradeStatus = upgradeStatusQuery.data;

  // 升级完成检测：见过非 idle 后又回到 idle（服务重启完成）→ 刷新版本信息
  useEffect(() => {
    if (!pending) return;
    const state = upgradeStatus?.state;
    if (state && state !== 'idle') {
      sawActiveRef.current = true;
    } else if (state === 'idle' && upgradeStatus?.error) {
      // 下载阶段失败：仅报错，不再误报成功（error 与 success 分支互斥）
      sawActiveRef.current = false;
      setPending(false);
      toast.error(upgradeStatus.error);
    } else if (state === 'idle' && sawActiveRef.current) {
      // 见过非 idle 后回到 idle 且无错误 → 升级成功（服务已重启）
      sawActiveRef.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: ['system-info'] });
      queryClient.removeQueries({ queryKey: ['system-update-check'] });
      toast.success(t('common.success'));
    }
  }, [pending, upgradeStatus, queryClient, t]);

  const startUpgradeMutation = useMutation({
    mutationFn: async (version: string) => {
      const res = await fetch('/api/system/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error(await parseApiError(res, t('common.error')));
      return (await res.json()) as UpgradeStatus;
    },
    onSuccess: (status) => {
      sawActiveRef.current = false;
      setPending(true);
      queryClient.setQueryData(['system-upgrade-status'], status);
      toast.success(t('settings.version.upgradeStarted'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deploymentLabel = (deployment: SystemInfo['deployment']): string => {
    if (deployment === 'launchd') return t('settings.version.deploymentLaunchd');
    if (deployment === 'systemd') return t('settings.version.deploymentSystemd');
    return t('settings.version.deploymentNone');
  };

  const isUpgrading = pending && upgradeStatus?.state !== undefined;
  const upgradeStateText =
    upgradeStatus?.state === 'downloading'
      ? t('settings.version.stateDownloading')
      : upgradeStatus?.state === 'executing'
        ? t('settings.version.stateExecuting')
        : null;

  const disabledReason = !info?.canSelfUpdate
    ? !info?.isProd
      ? t('settings.version.upgradeDisabledDev')
      : !info?.installedViaCli
        ? t('settings.version.upgradeDisabledNonCli')
        : null
    : null;

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.version.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <InfoRow
            label={t('settings.version.currentVersion')}
            value={
              <span data-testid="settings-version-current" className="font-mono">
                {info ? info.version : t('common.loading')}
              </span>
            }
          />
          <InfoRow
            label={t('settings.version.installMethod')}
            value={
              info
                ? info.installedViaCli
                  ? t('settings.version.installMethodCli')
                  : t('settings.version.installMethodNonCli')
                : '-'
            }
          />
          <InfoRow
            label={t('settings.version.deployment')}
            value={info ? deploymentLabel(info.deployment) : '-'}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            data-testid="settings-version-check"
            onClick={() => updateQuery.refetch()}
            disabled={updateQuery.isFetching || isUpgrading}
          >
            {updateQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {updateQuery.isFetching
              ? t('settings.version.checking')
              : t('settings.version.checkUpdate')}
          </Button>

          {update && (
            <span className="text-sm text-muted-foreground" data-testid="settings-version-latest">
              {update.hasUpdate && update.latestVersion
                ? t('settings.version.updateAvailable', { version: update.latestVersion })
                : t('settings.version.upToDate')}
              {update.publishedAt
                ? ` · ${t('settings.version.publishedAt', {
                    date: new Date(update.publishedAt).toLocaleDateString(toBCP47(language)),
                  })}`
                : ''}
            </span>
          )}
        </div>

        {updateQuery.isError && (
          <div className="text-sm text-destructive">{t('settings.version.checkFailed')}</div>
        )}

        {update?.hasUpdate && (
          <div className="space-y-3">
            <div className="text-sm font-semibold">{t('settings.version.changelog')}</div>
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              {update.changelog ? (
                <MarkdownPreview source={update.changelog} basePath="/" />
              ) : (
                <div className="text-sm text-muted-foreground">
                  {t('settings.version.changelogUnavailable')}
                </div>
              )}
            </div>

            {info?.canSelfUpdate ? (
              <Button
                variant="default"
                data-testid="settings-version-upgrade"
                disabled={isUpgrading || startUpgradeMutation.isPending}
                onClick={() => setShowConfirm(true)}
              >
                {isUpgrading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('settings.version.upgrade')}
              </Button>
            ) : (
              <div className="space-y-1">
                {disabledReason && (
                  <div className="text-sm text-muted-foreground">{disabledReason}</div>
                )}
                <div className="text-xs text-muted-foreground font-mono">
                  {t('settings.version.terminalHint')}
                </div>
              </div>
            )}
          </div>
        )}

        {isUpgrading && upgradeStateText && (
          <div
            className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3"
            data-testid="settings-version-upgrade-status"
          >
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
            <div className="space-y-1">
              <div className="text-sm font-medium">{upgradeStateText}</div>
              <div className="text-xs text-muted-foreground">
                {t('settings.version.interruptNotice')}
              </div>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('settings.version.upgradeWarningTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.version.upgradeWarningBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="settings-version-upgrade-confirm"
              onClick={() => {
                setShowConfirm(false);
                if (update?.latestVersion) {
                  startUpgradeMutation.mutate(update.latestVersion);
                }
              }}
            >
              {t('settings.version.upgrade')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
