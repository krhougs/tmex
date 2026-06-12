import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { RightPanelTrigger } from '@/components/ui/right-panel';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agent';
import { type UiThreadBlock, buildThreadBlocks, lastUserMessageText } from '@/stores/agent-thread';
import { useTmuxStore } from '@/stores/tmux';
import { buildTerminalLabel } from '@/utils/terminalMeta';
import { useQuery } from '@tanstack/react-query';
import type { AgentSessionDto, Device, StateSnapshotPayload } from '@tmex/shared';
import { CircleAlertIcon, SendIcon, SquareIcon, TerminalIcon } from 'lucide-react';

import { ChatThread } from './chat-thread';
import { SessionSwitcher } from './session-switcher';

export function ChatInput({
  onSend,
  onStop,
  running,
  disabled,
  className,
}: {
  onSend?: (text: string) => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || running) return;
    onSend?.(trimmed);
    setText('');
  };

  return (
    <div
      data-testid="agent-chat-input"
      className={cn('flex shrink-0 items-end gap-2 border-t p-3', className)}
    >
      <Textarea
        data-testid="agent-chat-input-textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t('agent.panel.inputPlaceholder')}
        disabled={disabled}
        className="max-h-40 min-h-9 flex-1 resize-none"
        rows={1}
      />
      {running ? (
        <Button
          data-testid="agent-chat-stop"
          size="icon"
          variant="destructive"
          onClick={() => onStop?.()}
          aria-label={t('agent.panel.stop')}
        >
          <SquareIcon />
        </Button>
      ) : (
        <Button
          data-testid="agent-chat-send"
          size="icon"
          disabled={disabled || text.trim().length === 0}
          onClick={submit}
          aria-label={t('agent.panel.send')}
        >
          <SendIcon />
        </Button>
      )}
    </div>
  );
}

interface BindingInfo {
  label: string;
  state: 'valid' | 'invalid' | 'unknown';
  windowId: string | null;
}

function resolveBinding(
  session: AgentSessionDto,
  snapshots: Record<string, StateSnapshotPayload | undefined>,
  devices: Device[] | undefined
): BindingInfo | null {
  if (!session.deviceId || !session.paneId) {
    return null;
  }
  const deviceName = devices?.find((device) => device.id === session.deviceId)?.name ?? null;
  const snapshot = snapshots[session.deviceId];
  if (!snapshot?.session) {
    return {
      label: `${session.paneId}@${deviceName ?? '?'}`,
      state: 'unknown',
      windowId: null,
    };
  }
  for (const window of snapshot.session.windows) {
    const pane = window.panes.find((candidate) => candidate.id === session.paneId);
    if (pane) {
      return {
        label: buildTerminalLabel({
          paneIdx: pane.index,
          windowIdx: window.index,
          paneTitle: pane.title,
          windowName: window.name,
          windowCustomName: window.customName,
          deviceName,
        }),
        state: 'valid',
        windowId: window.id,
      };
    }
  }
  return {
    label: `${session.paneId}@${deviceName ?? '?'}`,
    state: 'invalid',
    windowId: null,
  };
}

export function AgentPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const routeDeviceId = paneMatch?.params.deviceId ?? null;
  const routePaneId = paneMatch?.params.paneId ?? null;

  const sessions = useAgentStore((state) => state.sessions);
  const sessionOrder = useAgentStore((state) => state.sessionOrder);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const showAllSessions = useAgentStore((state) => state.showAllSessions);
  const messages = useAgentStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );
  const inProgress = useAgentStore((state) =>
    state.activeSessionId ? state.inProgress[state.activeSessionId] : undefined
  );
  const pendingConfirmations = useAgentStore((state) =>
    state.activeSessionId ? state.pendingConfirmations[state.activeSessionId] : undefined
  );

  const snapshots = useTmuxStore((state) => state.snapshots);

  const { data: devicesData } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to load devices');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  useEffect(() => {
    const store = useAgentStore.getState();
    store.ensureInitialized();
    void store.loadSessions();
  }, []);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;

  const visibleSessions = useMemo(() => {
    const ordered = sessionOrder
      .map((id) => sessions[id])
      .filter((session): session is AgentSessionDto => Boolean(session));
    if (showAllSessions || !routePaneId || !routeDeviceId) {
      return ordered;
    }
    return ordered.filter(
      (session) =>
        session.id === activeSessionId ||
        (session.deviceId === routeDeviceId && session.paneId === routePaneId)
    );
  }, [sessionOrder, sessions, showAllSessions, routeDeviceId, routePaneId, activeSessionId]);

  const confirmationByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const confirmation of pendingConfirmations ?? []) {
      map.set(confirmation.toolCallId, confirmation.id);
    }
    return map;
  }, [pendingConfirmations]);

  const blocks = useMemo(() => {
    const merged = buildThreadBlocks(messages, inProgress);
    // approval 等待中的 tool-call 可能尚无对应卡片（assistant 消息还没拉到），合成卡片兜底
    const knownToolCallIds = new Set<string>();
    for (const block of merged) {
      if (block.kind === 'tool-call') {
        knownToolCallIds.add(block.call.toolCallId);
      }
    }
    const extras: UiThreadBlock[] = [];
    for (const confirmation of pendingConfirmations ?? []) {
      if (knownToolCallIds.has(confirmation.toolCallId)) continue;
      extras.push({
        kind: 'tool-call',
        key: `confirmation-${confirmation.id}`,
        call: {
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          input: confirmation.input,
          isError: false,
          resolved: false,
        },
      });
    }
    return extras.length > 0 ? [...merged, ...extras] : merged;
  }, [messages, inProgress, pendingConfirmations]);

  const binding = activeSession
    ? resolveBinding(activeSession, snapshots, devicesData?.devices)
    : null;
  const paneMismatch = Boolean(
    activeSession &&
      routePaneId &&
      routeDeviceId &&
      (activeSession.paneId !== routePaneId || activeSession.deviceId !== routeDeviceId)
  );

  const running = activeSession?.status === 'running';
  const retryText = lastUserMessageText(messages);

  const handleDecide = (confirmationId: string, approved: boolean): void => {
    if (!activeSessionId) return;
    void useAgentStore.getState().decideConfirmation(activeSessionId, confirmationId, approved);
  };

  const handleBindingClick = (): void => {
    if (!activeSession?.deviceId) return;
    if (binding?.state === 'valid' && binding.windowId && activeSession.paneId) {
      navigate(
        `/devices/${activeSession.deviceId}/windows/${binding.windowId}/panes/${encodeURIComponent(activeSession.paneId)}`
      );
      return;
    }
    if (binding?.state === 'unknown') {
      navigate(`/devices/${activeSession.deviceId}`);
    }
  };

  return (
    <div data-testid="agent-panel" className="flex h-full min-h-0 flex-col">
      <header
        data-testid="agent-panel-header"
        className="flex h-12 shrink-0 items-center gap-2 px-3 md:h-16"
      >
        <span className="text-sm font-semibold">{t('agent.panel.title')}</span>
        <Separator orientation="vertical" className="shrink-0 data-[orientation=vertical]:h-4" />
        <div className="min-w-0 flex-1">
          <SessionSwitcher
            sessions={visibleSessions}
            currentSessionId={activeSessionId}
            showAll={showAllSessions}
            onToggleShowAll={(showAll) => useAgentStore.getState().setShowAllSessions(showAll)}
            onSelect={(sessionId) => useAgentStore.getState().setActiveSession(sessionId)}
            onCreate={() => {
              if (routeDeviceId && routePaneId) {
                void useAgentStore.getState().createSession(routeDeviceId, routePaneId);
              }
            }}
            onRename={(sessionId, title) => {
              void useAgentStore.getState().renameSession(sessionId, title);
            }}
            onDelete={(sessionId) => {
              void useAgentStore.getState().deleteSession(sessionId);
            }}
            createDisabled={!routeDeviceId || !routePaneId}
            createDisabledReason={t('agent.session.createDisabledNoPane')}
          />
        </div>
        <RightPanelTrigger className="shrink-0" data-testid="right-panel-close" />
      </header>
      <Separator />

      {activeSession && binding && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            data-testid="agent-binding-chip"
            data-binding-state={binding.state}
            className={cn(
              'border-border flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
              binding.state === 'valid' ? 'hover:bg-muted cursor-pointer' : 'text-muted-foreground',
              binding.state === 'invalid' && 'opacity-60'
            )}
            onClick={handleBindingClick}
            disabled={binding.state === 'invalid'}
          >
            <TerminalIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{binding.label}</span>
            {binding.state === 'invalid' && (
              <span className="shrink-0">· {t('agent.binding.invalid')}</span>
            )}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              {activeSession.writeMode === 'auto'
                ? t('agent.writeMode.auto')
                : t('agent.writeMode.confirm')}
            </span>
            <Switch
              data-testid="agent-write-mode-switch"
              checked={activeSession.writeMode === 'auto'}
              onCheckedChange={(checked) => {
                void useAgentStore
                  .getState()
                  .setWriteMode(activeSession.id, checked ? 'auto' : 'confirm');
              }}
            />
          </div>
        </div>
      )}

      {activeSession && paneMismatch && (
        <div
          data-testid="agent-pane-mismatch"
          className="bg-muted/50 mx-3 mb-1.5 flex shrink-0 flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1">
            {t('agent.binding.mismatchTitle')}
          </span>
          {binding?.state === 'valid' && (
            <Button
              data-testid="agent-binding-goto"
              size="xs"
              variant="outline"
              onClick={handleBindingClick}
            >
              {t('agent.binding.goTo')}
            </Button>
          )}
          {routePaneId && (
            <Button
              data-testid="agent-binding-rebind"
              size="xs"
              variant="outline"
              onClick={() => {
                void useAgentStore.getState().rebindPane(activeSession.id, routePaneId);
              }}
            >
              {t('agent.binding.rebind')}
            </Button>
          )}
        </div>
      )}

      {activeSession?.status === 'error' && activeSession.lastError && (
        <div
          data-testid="agent-error-banner"
          className="bg-destructive/10 text-destructive mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-md px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{activeSession.lastError}</span>
          {retryText && (
            <Button
              data-testid="agent-error-retry"
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                void useAgentStore.getState().sendMessage(activeSession.id, retryText);
              }}
            >
              {t('agent.panel.retry')}
            </Button>
          )}
        </div>
      )}

      <ChatThread
        blocks={activeSession ? blocks : []}
        running={Boolean(running)}
        emptyText={t('agent.panel.empty')}
        confirmationByToolCallId={confirmationByToolCallId}
        onDecide={handleDecide}
      />
      <ChatInput
        disabled={!activeSession || activeSession.status === 'waiting_confirmation'}
        running={Boolean(running)}
        onSend={(text) => {
          if (activeSession) {
            void useAgentStore.getState().sendMessage(activeSession.id, text);
          }
        }}
        onStop={() => {
          if (activeSession) {
            void useAgentStore.getState().stopSession(activeSession.id);
          }
        }}
      />
    </div>
  );
}
