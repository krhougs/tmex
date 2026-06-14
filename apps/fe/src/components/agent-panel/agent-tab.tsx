import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agent';
import { type UiThreadBlock, buildThreadBlocks, lastUserMessageText } from '@/stores/agent-thread';
import { useTmuxStore } from '@/stores/tmux';
import { useUIStore } from '@/stores/ui';
import { buildTerminalLabel } from '@/utils/terminalMeta';
import { useQuery } from '@tanstack/react-query';
import type { Device, StateSnapshotPayload } from '@tmex/shared';
import {
  CircleAlertIcon,
  ListTreeIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  ZapIcon,
} from 'lucide-react';

import { ChatThread } from './chat-thread';
import { ModelPicker } from './model-picker';
import { QueueChips } from './queue-chips';

function ChatInput({
  onSend,
  onSteer,
  onStop,
  running,
  steerable,
  disabled,
  modelPicker,
  writeModeControl,
}: {
  onSend?: (text: string) => void;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  running?: boolean;
  steerable?: boolean;
  disabled?: boolean;
  modelPicker?: ReactNode;
  writeModeControl?: ReactNode;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend?.(trimmed);
    setText('');
  };

  const steer = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSteer?.(trimmed);
    setText('');
  };

  return (
    <div
      data-testid="agent-chat-input"
      className="bg-chat-surface flex shrink-0 flex-col gap-2 mx-3 mb-2.5 rounded-xl mt-1.5 focus-within:ring-1 focus-within:ring-ring/30"
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
        className="max-h-40 min-h-[4.5rem] w-full resize-none border-transparent bg-transparent p-3 text-[13px] shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
        rows={3}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {writeModeControl}
          {modelPicker && <div className="min-w-0 flex-1">{modelPicker}</div>}
        </div>
        {running ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {steerable && (
              <Button
                data-testid="agent-chat-steer"
                size="icon"
                variant="outline"
                disabled={disabled || text.trim().length === 0}
                onClick={steer}
                aria-label={t('agent.queue.steer')}
                title={t('agent.queue.steerHint')}
              >
                <ZapIcon />
              </Button>
            )}
            <Button
              data-testid="agent-chat-send"
              size="icon"
              variant="secondary"
              disabled={disabled || text.trim().length === 0}
              onClick={submit}
              aria-label={t('agent.panel.send')}
            >
              <SendIcon />
            </Button>
            <Button
              data-testid="agent-chat-stop"
              size="icon"
              variant="destructive"
              onClick={() => onStop?.()}
              aria-label={t('agent.panel.stop')}
            >
              <SquareIcon />
            </Button>
          </div>
        ) : (
          <Button
            data-testid="agent-chat-send"
            size="icon"
            className="ml-auto shrink-0"
            disabled={disabled || text.trim().length === 0}
            onClick={submit}
            aria-label={t('agent.panel.send')}
          >
            <SendIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

interface BindingInfo {
  label: string;
  state: 'valid' | 'invalid' | 'unknown';
  windowId: string | null;
}

function resolveBinding(
  binding: { deviceId: string | null; paneId: string | null },
  snapshots: Record<string, StateSnapshotPayload | undefined>,
  devices: Device[] | undefined
): BindingInfo | null {
  if (!binding.deviceId || !binding.paneId) {
    return null;
  }
  const deviceName = devices?.find((device) => device.id === binding.deviceId)?.name ?? null;
  const snapshot = snapshots[binding.deviceId];
  if (!snapshot?.session) {
    return {
      label: `${binding.paneId}@${deviceName ?? '?'}`,
      state: 'unknown',
      windowId: null,
    };
  }
  for (const window of snapshot.session.windows) {
    const pane = window.panes.find((candidate) => candidate.id === binding.paneId);
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
    label: `${binding.paneId}@${deviceName ?? '?'}`,
    state: 'invalid',
    windowId: null,
  };
}

export function AgentTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);

  const paneMatch = useMatch('/devices/:deviceId/windows/:windowId/panes/:paneId');
  const routeDeviceId = paneMatch?.params.deviceId ?? null;
  const routePaneId = paneMatch?.params.paneId ?? null;

  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const draft = useAgentStore((state) => state.draft);
  const messages = useAgentStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );
  const inProgress = useAgentStore((state) =>
    state.activeSessionId ? state.inProgress[state.activeSessionId] : undefined
  );
  const pendingConfirmations = useAgentStore((state) =>
    state.activeSessionId ? state.pendingConfirmations[state.activeSessionId] : undefined
  );
  const sending = useAgentStore((state) =>
    state.activeSessionId ? state.sending[state.activeSessionId] : undefined
  );
  const queued = useAgentStore((state) =>
    state.activeSessionId ? state.queued[state.activeSessionId] : undefined
  );
  const defaultWriteMode = useAgentStore((state) => state.defaultWriteMode);

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

  // 当前路由 pane 的 snapshot 标题，用作新建会话的起源元数据
  const routePaneTitle = useMemo(() => {
    if (!routeDeviceId || !routePaneId) return null;
    const windows = snapshots[routeDeviceId]?.session?.windows;
    for (const window of windows ?? []) {
      const pane = window.panes.find((candidate) => candidate.id === routePaneId);
      if (pane) return pane.title ?? null;
    }
    return null;
  }, [routeDeviceId, routePaneId, snapshots]);

  // 空态即草稿态：进入 agent tab 且有路由 pane 但无会话/草稿时自动起草
  useEffect(() => {
    if (!activeSession && !draft && routeDeviceId && routePaneId) {
      useAgentStore.getState().startDraft(routeDeviceId, routePaneId, routePaneTitle);
    }
  }, [activeSession, draft, routeDeviceId, routePaneId, routePaneTitle]);

  const confirmationByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const confirmation of pendingConfirmations ?? []) {
      map.set(confirmation.toolCallId, confirmation.id);
    }
    return map;
  }, [pendingConfirmations]);

  const blocks = useMemo(() => {
    const merged = buildThreadBlocks(messages, inProgress);
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
          denied: false,
          resolved: false,
        },
      });
    }
    return extras.length > 0 ? [...merged, ...extras] : merged;
  }, [messages, inProgress, pendingConfirmations]);

  // 草稿态（尚未创建 session）也显示绑定 chip：此时显示的是将要绑定的 pane
  const bindingSource =
    activeSession ?? (draft ? { deviceId: draft.deviceId, paneId: draft.paneId } : null);
  const binding = bindingSource
    ? resolveBinding(bindingSource, snapshots, devicesData?.devices)
    : null;
  const paneMismatch = Boolean(
    activeSession &&
      routePaneId &&
      routeDeviceId &&
      (activeSession.paneId !== routePaneId || activeSession.deviceId !== routeDeviceId)
  );

  const running = activeSession?.status === 'running';
  const retryText = lastUserMessageText(messages);

  // 孤立会话：设备缺失 / 不在列表 / pane 在快照中已不存在 → 仅可只读查看
  const isOrphan = Boolean(
    activeSession &&
      (!activeSession.deviceId ||
        !devicesData?.devices?.some((device) => device.id === activeSession.deviceId) ||
        binding?.state === 'invalid')
  );

  const queuedItems = queued ?? [];

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

  const handleNewSession = (): void => {
    if (!routeDeviceId || !routePaneId) return;
    useAgentStore.getState().startDraft(routeDeviceId, routePaneId, routePaneTitle);
  };

  const handleModelChange = (providerId: string | null, modelId: string): void => {
    if (activeSession) {
      void useAgentStore.getState().setSessionModel(activeSession.id, providerId, modelId);
    } else if (draft) {
      useAgentStore.getState().updateDraft({ providerId, modelId });
    }
  };

  const handleSend = (text: string): void => {
    const store = useAgentStore.getState();
    if (activeSession) {
      if (activeSession.status === 'running') {
        void store.enqueueMessage(activeSession.id, text);
      } else {
        void store.sendMessage(activeSession.id, text);
      }
      return;
    }
    if (draft) {
      void (async () => {
        const session = await store.materializeDraft();
        if (session) await store.sendMessage(session.id, text);
      })();
    }
  };

  const handleSteer = (text: string): void => {
    if (!activeSession) return;
    void useAgentStore.getState().enqueueMessage(activeSession.id, text, true);
  };

  const handleQueueSteer = (): void => {
    if (!activeSession) return;
    const first = queuedItems[0];
    if (!first) return;
    const store = useAgentStore.getState();
    void (async () => {
      await store.withdrawQueuedMessage(activeSession.id, first.id);
      await store.enqueueMessage(activeSession.id, first.text, true);
    })();
  };

  const modelProviderId = activeSession ? activeSession.providerId : (draft?.providerId ?? null);
  const modelId = activeSession ? activeSession.modelId : (draft?.modelId ?? null);
  const hasContext = Boolean(activeSession || draft);
  // 已选 pane、尚无 session 的空 Chat：隐藏大聊天卡片，输入框居中
  const draftEmpty = Boolean(draft && !activeSession);
  // 有活动 session 时反映该 session 的写入模式；否则用浏览器记忆的默认值（新 session 的初值）
  const writeMode = activeSession ? activeSession.writeMode : defaultWriteMode;
  // 新建按钮仅在「有内容的活动会话」时显示；草稿态/空会话本身即新会话，隐藏之
  const showNewSession = Boolean(activeSession && (messages?.length ?? 0) > 0);
  const inputDisabled =
    isOrphan || !hasContext || activeSession?.status === 'waiting_confirmation' || Boolean(sending);

  return (
    <div data-testid="agent-tab" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        {binding ? (
          <button
            type="button"
            data-testid="agent-binding-chip"
            data-binding-state={binding.state}
            className={cn(
              'border-border flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
              activeSession && binding.state === 'valid'
                ? 'hover:bg-muted cursor-pointer'
                : 'text-muted-foreground',
              binding.state === 'invalid' && 'opacity-60'
            )}
            onClick={handleBindingClick}
            disabled={!activeSession || binding.state === 'invalid'}
          >
            <TerminalIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{binding.label}</span>
            {binding.state === 'invalid' && (
              <span className="shrink-0">· {t('agent.binding.invalid')}</span>
            )}
          </button>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            data-testid="agent-session-switch"
            size="icon-sm"
            variant="ghost"
            onClick={() => setSidebarTab('panes')}
            aria-label={t('agent.session.switch')}
            title={t('agent.session.switch')}
          >
            <ListTreeIcon />
          </Button>
          {showNewSession && (
            <Button
              data-testid="agent-session-new"
              size="icon-sm"
              variant="ghost"
              disabled={!routeDeviceId || !routePaneId}
              onClick={handleNewSession}
              aria-label={t('agent.session.new')}
              title={
                !routeDeviceId || !routePaneId
                  ? t('agent.session.selectPaneHint')
                  : t('agent.session.new')
              }
            >
              <PlusIcon />
            </Button>
          )}
        </div>
      </div>

      {isOrphan && (
        <div
          data-testid="agent-orphan-banner"
          className="bg-muted/50 text-muted-foreground mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t('agent.orphan.readonly')}</span>
        </div>
      )}

      {activeSession && !isOrphan && paneMismatch && (
        <div
          data-testid="agent-pane-mismatch"
          className="bg-muted/50 mx-3 mb-1.5 flex shrink-0 flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
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
          className="bg-destructive/10 text-destructive mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{activeSession.lastError}</span>
          {retryText && !isOrphan && (
            <Button
              data-testid="agent-error-retry"
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={Boolean(sending)}
              onClick={() => {
                void useAgentStore.getState().sendMessage(activeSession.id, retryText);
              }}
            >
              {t('agent.panel.retry')}
            </Button>
          )}
        </div>
      )}

      {!draftEmpty && (
        <ChatThread
          key={activeSession?.id ?? (draft ? 'draft' : 'none')}
          blocks={activeSession ? blocks : []}
          running={Boolean(running)}
          emptyText={hasContext ? t('agent.panel.empty') : t('agent.session.selectPaneHint')}
          confirmationByToolCallId={confirmationByToolCallId}
          onDecide={handleDecide}
          className="bg-chat-surface mx-3 mb-2 overflow-hidden rounded-xl"
        />
      )}

      {activeSession && !isOrphan && queuedItems.length > 0 && (
        <QueueChips
          queued={queuedItems}
          onEdit={(itemId, text) =>
            void useAgentStore.getState().editQueuedMessage(activeSession.id, itemId, text)
          }
          onWithdraw={(itemId) =>
            void useAgentStore.getState().withdrawQueuedMessage(activeSession.id, itemId)
          }
          onSteer={handleQueueSteer}
        />
      )}

      {hasContext && (
        <div className={draftEmpty ? 'flex min-h-0 flex-1 flex-col justify-center' : 'contents'}>
          {draftEmpty && (
            <div className="flex flex-col items-center gap-2 px-6 pb-6 text-center">
              <SparklesIcon className="text-muted-foreground size-9" />
              <h3 className="text-sm font-medium">{t('agent.welcome.title')}</h3>
              <p className="text-muted-foreground text-xs">{t('agent.welcome.subtitle')}</p>
            </div>
          )}
          <ChatInput
            disabled={inputDisabled}
            running={Boolean(running)}
            steerable={Boolean(activeSession)}
            onSend={handleSend}
            onSteer={handleSteer}
            onStop={() => {
              if (activeSession) {
                void useAgentStore.getState().stopSession(activeSession.id);
              }
            }}
            modelPicker={
              <ModelPicker
                providerId={modelProviderId}
                modelId={modelId}
                onChange={handleModelChange}
                disabled={running}
              />
            }
            writeModeControl={
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-muted-foreground text-xs">
                  {writeMode === 'auto' ? t('agent.writeMode.auto') : t('agent.writeMode.confirm')}
                </span>
                <Switch
                  data-testid="agent-write-mode-switch"
                  checked={writeMode === 'auto'}
                  disabled={Boolean(activeSession) && isOrphan}
                  onCheckedChange={(checked) => {
                    const next = checked ? 'auto' : 'confirm';
                    // 记忆为默认值（影响后续新 session）；有活动 session 时同时改该 session
                    useAgentStore.getState().setDefaultWriteMode(next);
                    if (activeSession) {
                      void useAgentStore.getState().setWriteMode(activeSession.id, next);
                    }
                  }}
                />
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}
