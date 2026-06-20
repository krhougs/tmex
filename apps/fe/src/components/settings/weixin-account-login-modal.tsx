import { useQueryClient } from '@tanstack/react-query';
import type {
  StartWeixinLoginResponse,
  WeixinAccountUser,
  WeixinLoginStatusResponse,
} from '@tmex/shared';
import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
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

interface WeixinUsersResponse {
  users: WeixinAccountUser[];
}

interface WeixinAccountLoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
}

type Phase = 'starting' | 'scanning' | 'awaitMessage' | 'binding' | 'expired' | 'error';

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

  const finishBinding = useCallback(async () => {
    cancelActive();
    await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
    toast.success(t('weixin.bindSuccess'));
    onOpenChange(false);
  }, [cancelActive, onOpenChange, queryClient, t]);

  // 第二段轮询：扫码确认后等用户发新消息，检测到后自动 approve 并完成绑定。
  const pollBinding = useCallback(
    async (gen: number, signal: AbortSignal, baseline: Map<string, string | null>) => {
      try {
        const res = await fetch(`/api/settings/weixin/accounts/${accountId}/users`, { signal });
        if (genRef.current !== gen) return;
        if (!res.ok) {
          throw new Error(await parseApiError(res, t('weixin.loginFailed')));
        }
        const data = (await res.json()) as WeixinUsersResponse;
        if (genRef.current !== gen) return;

        // 新用户（首次绑定）或 lastInboundAt 变化（重新授权）＝扫码后的新消息。
        const fresh = data.users.find(
          (u) => !baseline.has(u.userId) || u.lastInboundAt !== baseline.get(u.userId)
        );

        if (fresh) {
          setPhase('binding');
          setStatusMessage(t('weixin.bindingInProgress'));
          if (fresh.status === 'pending') {
            const approveRes = await fetch(
              `/api/settings/weixin/accounts/${accountId}/users/${encodeURIComponent(fresh.userId)}/approve`,
              { method: 'POST', signal }
            );
            if (genRef.current !== gen) return;
            if (!approveRes.ok) {
              throw new Error(await parseApiError(approveRes, t('weixin.approveFailed')));
            }
          }
          await finishBinding();
          return;
        }

        pollTimerRef.current = setTimeout(
          () => void pollBinding(gen, signal, baseline),
          POLL_INTERVAL_MS
        );
      } catch (err) {
        if (signal.aborted || genRef.current !== gen) return;
        setPhase('error');
        setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
      }
    },
    [accountId, finishBinding, t]
  );

  // 第一段轮询：等扫码确认。确认后拍 users baseline 快照，转入第二段。
  const pollLogin = useCallback(
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

        if (data.loggedIn || data.status === 'confirmed') {
          // 扫码确认那一刻拍一份 users 快照作为 baseline（服务端 lastInboundAt 比对，免时钟漂移）。
          const usersRes = await fetch(`/api/settings/weixin/accounts/${accountId}/users`, {
            signal,
          });
          if (genRef.current !== gen) return;
          if (!usersRes.ok) {
            throw new Error(await parseApiError(usersRes, t('weixin.loginFailed')));
          }
          const usersData = (await usersRes.json()) as WeixinUsersResponse;
          if (genRef.current !== gen) return;

          const baseline = new Map<string, string | null>(
            usersData.users.map((u) => [u.userId, u.lastInboundAt])
          );
          setPhase('awaitMessage');
          setStatusMessage(t('weixin.scanConfirmedSendHint'));
          pollTimerRef.current = setTimeout(
            () => void pollBinding(gen, signal, baseline),
            POLL_INTERVAL_MS
          );
          return;
        }

        setPhase('scanning');
        setStatusMessage(t('weixin.scanQrcodeHint'));
        pollTimerRef.current = setTimeout(() => void pollLogin(gen, signal), POLL_INTERVAL_MS);
      } catch (err) {
        if (signal.aborted || genRef.current !== gen) return;
        setPhase('error');
        setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
      }
    },
    [accountId, pollBinding, t]
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
      // qrcodeUrl 是二维码要编码的 URL（iLink 的 qrcode_img_content 实为 URL，非图片），前端生成二维码。
      setQrcodeUrl(data.qrcodeUrl);
      setPhase('scanning');
      setStatusMessage(t('weixin.scanQrcodeHint'));
      pollTimerRef.current = setTimeout(
        () => void pollLogin(gen, controller.signal),
        POLL_INTERVAL_MS
      );
    } catch (err) {
      if (controller.signal.aborted || genRef.current !== gen) return;
      setPhase('error');
      setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
    }
  }, [accountId, cancelActive, pollLogin, t]);

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
              <QRCodeSVG
                value={qrcodeUrl}
                size={208}
                marginSize={3}
                data-testid={`weixin-account-login-qrcode-${accountId}`}
              />
            )}
            {!isStarting && !qrcodeUrl && <QrCode className="h-10 w-10 text-muted-foreground" />}
          </div>

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
