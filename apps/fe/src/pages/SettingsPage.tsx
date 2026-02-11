import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SiteSettings,
  TelegramBotChat,
  TelegramBotWithStats,
  UpdateSiteSettingsRequest,
} from '@tmex/shared';
import { toBCP47 as toBCP47Locale } from '@tmex/shared';
import { Loader2, RefreshCcw, RotateCcw, Save, Send, Shield, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectOption,
} from '../components/ui';
import { useSiteStore } from '../stores/site';

interface TelegramBotsResponse {
  bots: TelegramBotWithStats[];
}

interface TelegramChatsResponse {
  chats: TelegramBotChat[];
}

interface SiteSettingsResponse {
  settings: SiteSettings;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refreshSettings } = useSiteStore();

  const [siteName, setSiteName] = useState('tmex');
  const [siteUrl, setSiteUrl] = useState(window.location.origin);
  const [language, setLanguage] = useState<'en_US' | 'zh_CN'>('en_US');
  const [bellThrottleSeconds, setBellThrottleSeconds] = useState(6);
  const [enableBrowserBellToast, setEnableBrowserBellToast] = useState(true);
  const [enableTelegramBellPush, setEnableTelegramBellPush] = useState(true);
  const [sshReconnectMaxRetries, setSshReconnectMaxRetries] = useState(2);
  const [sshReconnectDelaySeconds, setSshReconnectDelaySeconds] = useState(10);
  const [showRefreshNotice, setShowRefreshNotice] = useState(false);

  const [newBotName, setNewBotName] = useState('');
  const [newBotToken, setNewBotToken] = useState('');
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['site-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/site');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.loadFailed')));
      }
      return (await res.json()) as SiteSettingsResponse;
    },
  });

  const botsQuery = useQuery({
    queryKey: ['telegram-bots'],
    queryFn: async () => {
      const res = await fetch('/api/settings/telegram/bots');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.loadBotsFailed')));
      }
      return (await res.json()) as TelegramBotsResponse;
    },
  });

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings) {
      return;
    }

    setSiteName(settings.siteName);
    setSiteUrl(settings.siteUrl);
    setLanguage(settings.language ?? 'en_US');
    setBellThrottleSeconds(settings.bellThrottleSeconds);
    setEnableBrowserBellToast(settings.enableBrowserBellToast ?? true);
    setEnableTelegramBellPush(settings.enableTelegramBellPush ?? true);
    setSshReconnectMaxRetries(settings.sshReconnectMaxRetries);
    setSshReconnectDelaySeconds(settings.sshReconnectDelaySeconds);
  }, [settingsQuery.data?.settings]);

  const saveSiteMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateSiteSettingsRequest = {
        siteName,
        siteUrl,
        language,
        bellThrottleSeconds,
        enableBrowserBellToast,
        enableTelegramBellPush,
        sshReconnectMaxRetries,
        sshReconnectDelaySeconds,
      };

      const res = await fetch('/api/settings/site', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.saveFailed')));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['site-settings'] }),
        refreshSettings(),
      ]);
      toast.success(t('settings.settingsSaved'));
      if (settingsQuery.data?.settings?.language !== language) {
        setShowRefreshNotice(true);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/restart', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.restartFailed')));
      }
    },
    onSuccess: () => {
      toast.success(t('settings.restartScheduled'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const createBotMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/telegram/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newBotName,
          token: newBotToken,
          enabled: true,
          allowAuthRequests: true,
        }),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.createFailed')));
      }
    },
    onSuccess: async () => {
      setNewBotName('');
      setNewBotToken('');
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const bots = botsQuery.data?.bots ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" data-testid="settings-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('nav.settings')}</h1>
        <Button
          variant="ghost"
          onClick={() => {
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: ['site-settings'] }),
              queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
            ]);
          }}
        >
          <RefreshCcw className="h-4 w-4" />
          {t('common.refresh')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.siteName')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="site-name-input">
              {t('settings.siteName')}
            </label>
            <Input
              id="site-name-input"
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
              placeholder={t('settings.siteNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="site-url-input">
              {t('settings.siteUrl')}
            </label>
            <Input
              id="site-url-input"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder={t('settings.siteUrlPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="language-select">
              {t('settings.language')}
            </label>
            <Select
              id="language-select"
              data-testid="settings-language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'en_US' | 'zh_CN')}
            >
              <SelectOption value="en_US">{t('settings.language_en_US')}</SelectOption>
              <SelectOption value="zh_CN">{t('settings.language_zh_CN')}</SelectOption>
            </Select>
            {showRefreshNotice && (
              <p
                className="text-xs text-[var(--color-accent)] mt-1"
                data-testid="settings-refresh-notice"
              >
                {t('settings.refreshToApply')}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label
              className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none"
              htmlFor="enable-browser-bell-toast"
            >
              <input
                id="enable-browser-bell-toast"
                data-testid="settings-enable-browser-bell-toast"
                type="checkbox"
                checked={enableBrowserBellToast}
                onChange={(event) => setEnableBrowserBellToast(event.target.checked)}
              />
              <span>{t('settings.enableBrowserBellToast')}</span>
            </label>

            <label
              className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none"
              htmlFor="enable-telegram-bell-push"
            >
              <input
                id="enable-telegram-bell-push"
                data-testid="settings-enable-telegram-bell-push"
                type="checkbox"
                checked={enableTelegramBellPush}
                onChange={(event) => setEnableTelegramBellPush(event.target.checked)}
              />
              <span>{t('settings.enableTelegramBellPush')}</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="bell-throttle-input">
                {t('settings.bellThrottle')}
              </label>
              <Input
                id="bell-throttle-input"
                type="number"
                value={bellThrottleSeconds}
                min={0}
                max={300}
                onChange={(event) => setBellThrottleSeconds(Number(event.target.value))}
              />
            </div>

            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                htmlFor="ssh-reconnect-retries-input"
              >
                {t('settings.sshReconnectMaxRetries')}
              </label>
              <Input
                id="ssh-reconnect-retries-input"
                type="number"
                value={sshReconnectMaxRetries}
                min={0}
                max={20}
                onChange={(event) => setSshReconnectMaxRetries(Number(event.target.value))}
              />
            </div>

            <div>
              <label
                className="block text-sm font-medium mb-1.5"
                htmlFor="ssh-reconnect-delay-input"
              >
                {t('settings.sshReconnectDelay')}
              </label>
              <Input
                id="ssh-reconnect-delay-input"
                type="number"
                value={sshReconnectDelaySeconds}
                min={1}
                max={300}
                onChange={(event) => setSshReconnectDelaySeconds(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="danger"
              data-testid="settings-restart"
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              {t('settings.restartGateway')}
            </Button>

            <Button
              variant="primary"
              data-testid="settings-save"
              onClick={() => saveSiteMutation.mutate()}
              disabled={saveSiteMutation.isPending}
            >
              <Save className="h-4 w-4" />
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('telegram.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium mb-1.5" htmlFor="new-bot-name">
                {t('telegram.botName')}
              </label>
              <Input
                id="new-bot-name"
                value={newBotName}
                onChange={(event) => setNewBotName(event.target.value)}
                placeholder={t('telegram.botNamePlaceholder')}
              />
            </div>

            <div className="md:col-span-7">
              <label className="block text-sm font-medium mb-1.5" htmlFor="new-bot-token">
                {t('telegram.botToken')}
              </label>
              <Input
                id="new-bot-token"
                type="password"
                value={newBotToken}
                onChange={(event) => setNewBotToken(event.target.value)}
                placeholder={t('telegram.botTokenPlaceholder')}
              />
            </div>

            <div className="md:col-span-2">
              <Button
                variant="primary"
                className="w-full"
                onClick={() => createBotMutation.mutate()}
                disabled={createBotMutation.isPending || !newBotName.trim() || !newBotToken.trim()}
              >
                {createBotMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {t('telegram.addBot')}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {botsQuery.isLoading && (
              <div className="text-sm text-[var(--color-text-secondary)]">
                {t('common.loading')}
              </div>
            )}

            {!botsQuery.isLoading && bots.length === 0 && (
              <div className="text-sm text-[var(--color-text-secondary)]">
                {t('telegram.addBot')}
              </div>
            )}

            {bots.map((bot) => (
              <BotCard
                key={bot.id}
                bot={bot}
                expanded={expandedBotId === bot.id}
                onToggleExpand={() => {
                  setExpandedBotId((prev) => (prev === bot.id ? null : bot.id));
                }}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface BotCardProps {
  bot: TelegramBotWithStats;
  expanded: boolean;
  onToggleExpand: () => void;
}

function BotCard({ bot, expanded, onToggleExpand }: BotCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [name, setName] = useState(bot.name);
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(bot.enabled);
  const [allowAuthRequests, setAllowAuthRequests] = useState(bot.allowAuthRequests);

  useEffect(() => {
    setName(bot.name);
    setEnabled(bot.enabled);
    setAllowAuthRequests(bot.allowAuthRequests);
  }, [bot.allowAuthRequests, bot.enabled, bot.name]);

  const chatsQuery = useQuery({
    queryKey: ['telegram-bot-chats', bot.id],
    enabled: expanded,
    queryFn: async () => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}/chats`);
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.loadChatsFailed')));
      }
      return (await res.json()) as TelegramChatsResponse;
    },
  });

  const groupedChats = useMemo(() => {
    const chats = chatsQuery.data?.chats ?? [];
    return {
      pending: chats.filter((chat) => chat.status === 'pending'),
      authorized: chats.filter((chat) => chat.status === 'authorized'),
    };
  }, [chatsQuery.data?.chats]);

  const patchBotMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name,
        enabled,
        allowAuthRequests,
      };
      if (token.trim()) {
        payload.token = token.trim();
      }

      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.updateFailed')));
      }
    },
    onSuccess: async () => {
      setToken('');
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const deleteBotMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.deleteFailed')));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}/approve`,
        {
          method: 'POST',
        }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.approveFailed')));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
        queryClient.invalidateQueries({ queryKey: ['telegram-bot-chats', bot.id] }),
      ]);
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const removeChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}`,
        {
          method: 'DELETE',
        }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.removeFailed')));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
        queryClient.invalidateQueries({ queryKey: ['telegram-bot-chats', bot.id] }),
      ]);
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const testChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(
        `/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}/test`,
        {
          method: 'POST',
        }
      );
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.testMessageFailed')));
      }
    },
    onSuccess: () => {
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{bot.name}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">
            {bot.authorizedCount} / {bot.pendingCount}
          </div>
        </div>
        <Button variant="ghost" onClick={onToggleExpand}>
          {expanded ? t('common.collapse') : t('common.expand')}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-3">
          <label className="block text-sm font-medium mb-1.5" htmlFor={`bot-name-${bot.id}`}>
            {t('telegram.botName')}
          </label>
          <Input
            id={`bot-name-${bot.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="md:col-span-4">
          <label className="block text-sm font-medium mb-1.5" htmlFor={`bot-token-${bot.id}`}>
            {t('telegram.botToken')}
          </label>
          <Input
            id={`bot-token-${bot.id}`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t('telegram.tokenPlaceholder')}
          />
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t('common.enabled')}
          </label>
        </div>
        <div className="md:col-span-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={allowAuthRequests}
              onChange={(event) => setAllowAuthRequests(event.target.checked)}
            />
            {t('telegram.allowAuthRequests')}
          </label>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="danger" onClick={() => deleteBotMutation.mutate()}>
          <Trash2 className="h-4 w-4" />
          {t('telegram.deleteBot')}
        </Button>
        <Button variant="primary" onClick={() => patchBotMutation.mutate()}>
          <Save className="h-4 w-4" />
          {t('common.save')}
        </Button>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-[var(--color-border)]">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1">
              <Shield className="h-4 w-4" />
              {t('telegram.pendingChats')}
            </h3>
            {groupedChats.pending.length === 0 && (
              <div className="text-xs text-[var(--color-text-secondary)]">-</div>
            )}
            {groupedChats.pending.map((chat) => (
              <ChatRow
                key={`${chat.botId}-${chat.chatId}`}
                chat={chat}
                pending
                onApprove={() => approveMutation.mutate(chat.chatId)}
                onDelete={() => removeChatMutation.mutate(chat.chatId)}
              />
            ))}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1">
              <Shield className="h-4 w-4" />
              {t('telegram.chats')}
            </h3>
            {groupedChats.authorized.length === 0 && (
              <div className="text-xs text-[var(--color-text-secondary)]">-</div>
            )}
            {groupedChats.authorized.map((chat) => (
              <ChatRow
                key={`${chat.botId}-${chat.chatId}`}
                chat={chat}
                pending={false}
                onTest={() => testChatMutation.mutate(chat.chatId)}
                onDelete={() => removeChatMutation.mutate(chat.chatId)}
              />
            ))}
          </div>

          {chatsQuery.isLoading && (
            <div className="lg:col-span-2 text-xs text-[var(--color-text-secondary)]">
              {t('common.loading')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ChatRowProps {
  chat: TelegramBotChat;
  pending: boolean;
  onApprove?: () => void;
  onDelete: () => void;
  onTest?: () => void;
}

function ChatRow({ chat, pending, onApprove, onDelete, onTest }: ChatRowProps) {
  const { t } = useTranslation();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  return (
    <div className="rounded border border-[var(--color-border)] p-3 bg-[var(--color-bg)] space-y-2">
      <div className="text-sm font-medium truncate" title={chat.displayName}>
        {chat.displayName}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)]">
        {t('telegram.chatId')}：{chat.chatId}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)]">
        {new Date(chat.appliedAt).toLocaleString(toBCP47Locale(language))}
      </div>

      <div className="flex items-center justify-end gap-2">
        {pending ? (
          <>
            <Button variant="default" size="sm" onClick={onDelete}>
              {t('telegram.reject')}
            </Button>
            <Button variant="primary" size="sm" onClick={onApprove}>
              {t('telegram.authorize')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="default" size="sm" onClick={onTest}>
              <Send className="h-3.5 w-3.5" />
              {t('telegram.sendTestMessage')}
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
