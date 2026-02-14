import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LocaleCode,
  SiteSettings,
  TelegramBotChat,
  TelegramBotWithStats,
  UpdateSiteSettingsRequest,
  WebhookEndpoint,
} from '@tmex/shared';
import { I18N_MANIFEST, toBCP47 as toBCP47Locale } from '@tmex/shared';
import { Loader2, RotateCcw, Save, Send, Shield, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { toast } from 'sonner';

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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSiteStore } from '../stores/site';
import { useUIStore } from '../stores/ui';

interface TelegramBotsResponse {
  bots: TelegramBotWithStats[];
}

interface TelegramChatsResponse {
  chats: TelegramBotChat[];
}

interface SiteSettingsResponse {
  settings: SiteSettings;
}

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

export default function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refreshSettings } = useSiteStore();

  const [activeTab, setActiveTab] = useState<'site' | 'notifications' | 'telegram' | 'webhooks'>(
    'site'
  );

  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const isDark = theme === 'dark';

  // Site settings state
  const [siteName, setSiteName] = useState('tmex');
  const [siteUrl, setSiteUrl] = useState(window.location.origin);
  const [language, setLanguage] = useState<LocaleCode>('en_US');

  // Notifications state
  const [bellThrottleSeconds, setBellThrottleSeconds] = useState(6);
  const [enableBrowserBellToast, setEnableBrowserBellToast] = useState(true);
  const [enableTelegramBellPush, setEnableTelegramBellPush] = useState(true);
  const [sshReconnectMaxRetries, setSshReconnectMaxRetries] = useState(2);
  const [sshReconnectDelaySeconds, setSshReconnectDelaySeconds] = useState(10);
  const [showRefreshNotice, setShowRefreshNotice] = useState(false);

  // Telegram state
  const [newBotName, setNewBotName] = useState('');
  const [newBotToken, setNewBotToken] = useState('');
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);

  // Webhook state
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookSecret, setNewWebhookSecret] = useState('');

  const handleThemeChange = (checked: boolean) => {
    const nextTheme = checked ? 'dark' : 'light';
    setTheme(nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

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
        void i18n.changeLanguage(language);
        setShowRefreshNotice(true);
      }
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
        }),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('webhook.createFailed')));
      }
    },
    onSuccess: async () => {
      setNewWebhookUrl('');
      setNewWebhookSecret('');
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
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:gap-6 sm:p-5"
      data-testid="settings-page"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'site' ? 'default' : 'outline'}
          data-testid="settings-tab-site"
          onClick={() => setActiveTab('site')}
        >
          {t('settings.siteSettings')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'notifications' ? 'default' : 'outline'}
          data-testid="settings-tab-notifications"
          onClick={() => setActiveTab('notifications')}
        >
          {t('settings.notificationsTab')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'telegram' ? 'default' : 'outline'}
          data-testid="settings-tab-telegram"
          onClick={() => setActiveTab('telegram')}
        >
          {t('telegram.title')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'webhooks' ? 'default' : 'outline'}
          data-testid="settings-tab-webhooks"
          onClick={() => setActiveTab('webhooks')}
        >
          {t('webhook.title')}
        </Button>
      </div>

      {activeTab === 'site' && (
        <Card className="border-0 ring-0">
          <CardHeader>
            <CardTitle>{t('settings.siteSettings')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="site-name-input">
                {t('settings.siteName')}
              </label>
              <Input
                id="site-name-input"
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                placeholder={t('settings.siteNamePlaceholder')}
                className="min-h-10"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="site-url-input">
                {t('settings.siteUrl')}
              </label>
              <Input
                id="site-url-input"
                value={siteUrl}
                onChange={(event) => setSiteUrl(event.target.value)}
                placeholder={t('settings.siteUrlPlaceholder')}
                className="min-h-10"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="language-select">
                {t('settings.language')}
              </label>
              <Select
                value={language}
                onValueChange={(nextValue) => {
                  if (!nextValue) return;
                  setLanguage(nextValue as LocaleCode);
                }}
              >
                <SelectTrigger
                  id="language-select"
                  data-testid="settings-language-select"
                  className="w-full min-h-10"
                >
                  <SelectValue placeholder={t('settings.language')}>
                    {I18N_MANIFEST.locales.find((l) => l.code === language)?.nativeName ?? language}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-[var(--tmex-viewport-height)]">
                  {I18N_MANIFEST.locales.map((locale) => (
                    <SelectItem key={locale.code} value={locale.code}>
                      {locale.nativeName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {showRefreshNotice && (
                <p className="mt-1 text-xs text-primary" data-testid="settings-refresh-notice">
                  {t('settings.refreshToApply')}
                </p>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                <div className="min-w-0 pr-2">
                  <div className="text-sm font-medium">{t('settings.theme')}</div>
                </div>
                <Switch
                  checked={isDark}
                  onCheckedChange={(checked) => handleThemeChange(Boolean(checked))}
                  data-testid="settings-theme-toggle"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === 'notifications' && (
        <Card className="border-0 ring-0">
          <CardHeader>
            <CardTitle>{t('settings.notificationsTab')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                <div className="min-w-0 pr-2">
                  <div className="text-sm font-medium">{t('settings.enableBrowserBellToast')}</div>
                </div>
                <Switch
                  checked={enableBrowserBellToast}
                  onCheckedChange={(checked) => setEnableBrowserBellToast(Boolean(checked))}
                  data-testid="settings-enable-browser-bell-toast"
                />
              </div>

              <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                <div className="min-w-0 pr-2">
                  <div className="text-sm font-medium">{t('settings.enableTelegramBellPush')}</div>
                </div>
                <Switch
                  checked={enableTelegramBellPush}
                  onCheckedChange={(checked) => setEnableTelegramBellPush(Boolean(checked))}
                  data-testid="settings-enable-telegram-bell-push"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="bell-throttle-input">
                  {t('settings.bellThrottle')}
                </label>
                <Input
                  id="bell-throttle-input"
                  type="number"
                  value={bellThrottleSeconds}
                  min={0}
                  max={300}
                  onChange={(event) => setBellThrottleSeconds(Number(event.target.value))}
                  className="min-h-10"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="ssh-reconnect-retries-input">
                  {t('settings.sshReconnectMaxRetries')}
                </label>
                <Input
                  id="ssh-reconnect-retries-input"
                  type="number"
                  value={sshReconnectMaxRetries}
                  min={0}
                  max={20}
                  onChange={(event) => setSshReconnectMaxRetries(Number(event.target.value))}
                  className="min-h-10"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="ssh-reconnect-delay-input">
                  {t('settings.sshReconnectDelay')}
                </label>
                <Input
                  id="ssh-reconnect-delay-input"
                  type="number"
                  value={sshReconnectDelaySeconds}
                  min={1}
                  max={300}
                  onChange={(event) => setSshReconnectDelaySeconds(Number(event.target.value))}
                  className="min-h-10"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {activeTab === 'telegram' && (
        <Card className="border-0 ring-0">
          <CardHeader>
            <CardTitle>{t('telegram.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
                <div className="md:col-span-4 space-y-2">
                  <label className="block text-sm font-medium" htmlFor="new-bot-name">
                    {t('telegram.botName')}
                  </label>
                  <Input
                    id="new-bot-name"
                    value={newBotName}
                    onChange={(event) => setNewBotName(event.target.value)}
                    placeholder={t('telegram.botNamePlaceholder')}
                    className="min-h-10"
                  />
                </div>

                <div className="md:col-span-6 space-y-2">
                  <label className="block text-sm font-medium" htmlFor="new-bot-token">
                    {t('telegram.botToken')}
                  </label>
                  <Input
                    id="new-bot-token"
                    type="password"
                    value={newBotToken}
                    onChange={(event) => setNewBotToken(event.target.value)}
                    placeholder={t('telegram.botTokenPlaceholder')}
                    className="min-h-10"
                  />
                </div>

                <div className="md:col-span-2">
                  <Button
                    variant="default"
                    className="w-full md:w-auto"
                    data-testid="telegram-add-bot"
                    onClick={() => createBotMutation.mutate()}
                    disabled={
                      createBotMutation.isPending || !newBotName.trim() || !newBotToken.trim()
                    }
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
            </div>

            <div className="space-y-3">
              {botsQuery.isLoading && (
                <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
              )}

              {!botsQuery.isLoading && bots.length === 0 && (
                <div className="text-sm text-muted-foreground">{t('telegram.addBot')}</div>
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
      )}

      {activeTab === 'webhooks' && (
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
                  variant="default"
                  className="w-full md:w-auto"
                  data-testid="webhook-add"
                  onClick={() => createWebhookMutation.mutate()}
                  disabled={
                    createWebhookMutation.isPending ||
                    !newWebhookUrl.trim() ||
                    !newWebhookSecret.trim()
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
                      {new Date(webhook.createdAt).toLocaleString(toBCP47Locale(language))}
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
      )}

      {(activeTab === 'site' || activeTab === 'notifications') && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="default"
            data-testid="settings-save"
            onClick={() => saveSiteMutation.mutate()}
            disabled={saveSiteMutation.isPending}
            className="w-full sm:w-auto"
          >
            <Save className="h-4 w-4" />
            {t('common.save')}
          </Button>
        </div>
      )}
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
    <div
      className="space-y-4 rounded-md border-0 bg-card p-4"
      data-testid={`telegram-bot-card-${bot.id}`}
      data-bot-name={bot.name}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{bot.name}</div>
          <div className="text-xs text-muted-foreground">
            {bot.authorizedCount} / {bot.pendingCount}
          </div>
        </div>
        <Button
          variant="ghost"
          data-testid={`telegram-bot-toggle-${bot.id}`}
          onClick={onToggleExpand}
        >
          {expanded ? t('common.collapse') : t('common.expand')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
        <div className="md:col-span-3 space-y-2">
          <label className="block text-sm font-medium" htmlFor={`bot-name-${bot.id}`}>
            {t('telegram.botName')}
          </label>
          <Input
            id={`bot-name-${bot.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-h-10"
          />
        </div>
        <div className="md:col-span-4 space-y-2">
          <label className="block text-sm font-medium" htmlFor={`bot-token-${bot.id}`}>
            {t('telegram.botToken')}
          </label>
          <Input
            id={`bot-token-${bot.id}`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t('telegram.tokenPlaceholder')}
            className="min-h-10"
          />
        </div>
        <div className="md:col-span-2">
          <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
            <span className="text-sm font-medium">{t('common.enabled')}</span>
            <Switch checked={enabled} onCheckedChange={(checked) => setEnabled(Boolean(checked))} />
          </div>
        </div>
        <div className="md:col-span-3">
          <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
            <span className="text-sm font-medium">{t('telegram.allowAuthRequests')}</span>
            <Switch
              checked={allowAuthRequests}
              onCheckedChange={(checked) => setAllowAuthRequests(Boolean(checked))}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button
          variant="destructive"
          data-testid={`telegram-bot-delete-${bot.id}`}
          onClick={() => deleteBotMutation.mutate()}
          className="w-full sm:w-auto"
        >
          <Trash2 className="h-4 w-4" />
          {t('telegram.deleteBot')}
        </Button>
        <Button
          variant="default"
          data-testid={`telegram-bot-save-${bot.id}`}
          onClick={() => patchBotMutation.mutate()}
          className="w-full sm:w-auto"
        >
          <Save className="h-4 w-4" />
          {t('common.save')}
        </Button>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1">
              <Shield className="h-4 w-4" />
              {t('telegram.pendingChats')}
            </h3>
            {groupedChats.pending.length === 0 && <div className="text-xs text-muted-foreground">-</div>}
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
            {groupedChats.authorized.length === 0 && <div className="text-xs text-muted-foreground">-</div>}
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
            <div className="lg:col-span-2 text-xs text-muted-foreground">
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
    <div className="space-y-2 rounded border-0 bg-background p-3">
      <div className="text-sm font-medium truncate" title={chat.displayName}>
        {chat.displayName}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('telegram.chatId')}：{chat.chatId}
      </div>
      <div className="text-xs text-muted-foreground">
        {new Date(chat.appliedAt).toLocaleString(toBCP47Locale(language))}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {pending ? (
          <>
            <Button variant="outline" size="sm" onClick={onDelete}>
              {t('telegram.reject')}
            </Button>
            <Button variant="default" size="sm" onClick={onApprove}>
              {t('telegram.authorize')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onTest}>
              <Send className="h-3.5 w-3.5" />
              {t('telegram.sendTestMessage')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.settings')}</>;
}

// Page actions component
export function PageActions() {
  const { t } = useTranslation();
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

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

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setShowRestartConfirm(true)}
        disabled={restartMutation.isPending}
        aria-label={t('settings.restartGateway')}
        title={t('settings.restartGateway')}
        className="text-destructive hover:text-destructive hover:bg-destructive/10"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>

      <AlertDialog open={showRestartConfirm} onOpenChange={setShowRestartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.restartGateway')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.restartConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRestartConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                restartMutation.mutate();
                setShowRestartConfirm(false);
              }}
            >
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
