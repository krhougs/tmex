import { useTmuxStore } from '@/stores/tmux';
import type { ConnectionState } from '@/ws-borsh';
import { getBorshClient } from '@/ws-borsh';
import { Loader2, RefreshCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Phase = 'hidden' | 'entering' | 'visible' | 'exiting';

function shouldShowIndicator(state: ConnectionState): boolean {
  return state === 'WS_CONNECTING' || state === 'HELLO_NEGOTIATING' || state === 'RECONNECT_BACKOFF' || state === 'CLOSED';
}

export function ConnectionIndicator() {
  const { t } = useTranslation();
  const connectionState = useTmuxStore((s) => s.connectionState);
  const hasConnectedOnce = useTmuxStore((s) => s.hasConnectedOnce);
  const [phase, setPhase] = useState<Phase>('hidden');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const shouldShow = shouldShowIndicator(connectionState);

  useEffect(() => {
    if (shouldShow && (phaseRef.current === 'hidden' || phaseRef.current === 'exiting')) {
      setPhase('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPhase('visible');
        });
      });
    } else if (!shouldShow && phaseRef.current === 'visible') {
      setPhase('exiting');
    }
  }, [shouldShow]);

  const handleTransitionEnd = () => {
    if (phaseRef.current === 'exiting') {
      setPhase('hidden');
    }
  };

  if (phase === 'hidden') return null;

  const isClosed = connectionState === 'CLOSED';
  const isFirstConnect = !hasConnectedOnce && !isClosed;

  const transitionStyle: React.CSSProperties = {
    bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
    transition: phase === 'exiting'
      ? 'transform 300ms ease-in, opacity 300ms ease-in'
      : 'transform 300ms ease-out, opacity 300ms ease-out',
    transform: phase === 'visible' ? 'translateY(0)' : phase === 'exiting' ? 'translateY(20px) scale(0.8)' : 'translateY(20px)',
    opacity: phase === 'visible' ? 1 : 0,
  };

  if (isClosed) {
    return (
      <div
        className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg px-3 py-2 gap-2 text-sm text-destructive cursor-pointer"
        style={transitionStyle}
        onTransitionEnd={handleTransitionEnd}
        onClick={() => getBorshClient().reconnect()}
      >
        <RefreshCcw className="size-4" />
        <span>{t('websocket.reconnect')}</span>
      </div>
    );
  }

  if (isFirstConnect) {
    return (
      <div
        className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg p-2.5 text-sm text-muted-foreground"
        style={transitionStyle}
        onTransitionEnd={handleTransitionEnd}
      >
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg px-3 py-2 gap-2 text-sm text-muted-foreground"
      style={transitionStyle}
      onTransitionEnd={handleTransitionEnd}
    >
      <Loader2 className="size-4 animate-spin" />
      <span>{t('websocket.reconnecting')}</span>
    </div>
  );
}
