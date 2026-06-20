import { useQueryClient } from '@tanstack/react-query';
import type { StartWeixinLoginResponse, WeixinLoginStatusResponse } from '@tmex/shared';
import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

const POLL_INTERVAL_MS = 1500;

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** 把后端返回的二维码内容统一规整为可用作 <img src> 的字符串。 */
function toQrcodeImageSrc(qrcodeUrl: string): string {
  if (qrcodeUrl.startsWith('data:') || qrcodeUrl.startsWith('http')) {
    return qrcodeUrl;
  }
  return `data:image/png;base64,${qrcodeUrl}`;
}

interface WeixinAccountLoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
}

type Phase = 'starting' | 'polling' | 'expired' | 'error';

export function WeixinAccountLoginModal({
  open,
  onOpenChange,
  accountId,
  accountName,
}: WeixinAccountLoginModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 每次登录尝试递增的代际：迟到的 fetch resolve / 排程一律按代际丢弃。
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // 失效当前登录尝试：清定时器、中止在途 fetch、推进代际（关闭/切换/重启时调用）。
  const cancelActive = useCallback(() => {
    clearPollTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    genRef.current += 1;
  }, [clearPollTimer]);

  const finishLogin = useCallback(async () => {
    cancelActive();
    await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
    toast.success(t('weixin.loginConfirmed'));
    onOpenChange(false);
  }, [cancelActive, onOpenChange, queryClient, t]);

  const poll = useCallback(
    async (gen: number, signal: AbortSignal) => {
      try {
        const res = await fetch(`/api/settings/weixin/accounts/${accountId}/login/status`, {
          signal,
        });
        if (genRef.current !== gen) return;
        if (!res.ok) {
          throw new Error(await parseApiError(res, t('weixin.loginFailed')));
        }
        const data = (await res.json()) as WeixinLoginStatusResponse;
        if (genRef.current !== gen) return;

        if (data.loggedIn || data.status === 'confirmed') {
          await finishLogin();
          return;
        }
        if (data.status === 'expired') {
          setPhase('expired');
          setStatusMessage(t('weixin.loginExpired'));
          return;
        }
        if (data.status === 'error') {
          setPhase('error');
          setStatusMessage(t('weixin.loginError', { message: data.message ?? '' }));
          return;
        }

        setPhase('polling');
        setStatusMessage(t('weixin.loginPending'));
        pollTimerRef.current = setTimeout(() => void poll(gen, signal), POLL_INTERVAL_MS);
      } catch (err) {
        if (signal.aborted || genRef.current !== gen) return;
        setPhase('error');
        setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
      }
    },
    [accountId, finishLogin, t]
  );

  const start = useCallback(async () => {
    cancelActive();
    const gen = genRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('starting');
    setStatusMessage(null);
    setQrcodeUrl(null);
    try {
      const res = await fetch(`/api/settings/weixin/accounts/${accountId}/login/start`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (genRef.current !== gen) return;
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('weixin.loginFailed')));
      }
      const data = (await res.json()) as StartWeixinLoginResponse;
      if (genRef.current !== gen) return;
      setQrcodeUrl(toQrcodeImageSrc(data.qrcodeUrl));
      setPhase('polling');
      setStatusMessage(t('weixin.loginPending'));
      pollTimerRef.current = setTimeout(() => void poll(gen, controller.signal), POLL_INTERVAL_MS);
    } catch (err) {
      if (controller.signal.aborted || genRef.current !== gen) return;
      setPhase('error');
      setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
    }
  }, [accountId, cancelActive, poll, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在弹窗打开或账号切换时重新发起登录，start/cancelActive 为稳定回调
  useEffect(() => {
    if (!open) {
      cancelActive();
      return;
    }
    void start();
    return cancelActive;
  }, [open, accountId]);

  const isStarting = phase === 'starting';
  const canRefresh = phase === 'expired' || phase === 'error';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        data-testid={`weixin-account-login-modal-${accountId}`}
      >
        <DialogHeader>
          <DialogTitle>{t('weixin.scanToLogin')}</DialogTitle>
          <DialogDescription>{accountName}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-border bg-white">
            {isStarting && <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />}
            {!isStarting && qrcodeUrl && (
              <img
                src={qrcodeUrl}
                alt={t('weixin.scanToLogin')}
                className="h-52 w-52 object-contain"
                data-testid={`weixin-account-login-qrcode-${accountId}`}
              />
            )}
            {!isStarting && !qrcodeUrl && <QrCode className="h-10 w-10 text-muted-foreground" />}
          </div>

          <p className="text-center text-sm text-muted-foreground">{t('weixin.scanQrcodeHint')}</p>

          {statusMessage && (
            <p
              className="text-center text-sm font-medium"
              data-testid={`weixin-account-login-status-${accountId}`}
            >
              {statusMessage}
            </p>
          )}
        </div>

        <DialogFooter>
          {canRefresh && (
            <Button
              variant="secondary"
              data-testid="weixin-account-login-refresh"
              onClick={() => void start()}
            >
              <RefreshCw className="h-4 w-4" />
              {t('weixin.refreshQrcode')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('weixin.closeLogin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
