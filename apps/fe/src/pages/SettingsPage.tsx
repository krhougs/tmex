import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocaleCode, SiteSettings, UpdateSiteSettingsRequest } from '@tmex/shared';
import { I18N_MANIFEST } from '@tmex/shared';
import {
  Bell,
  Monitor,
  RotateCcw,
  Save,
  Server,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@tmex/ui/toast';
import i18n from '../i18n';

import { useSiteStore } from '@tmex/stores';
import { useUIStore } from '@tmex/stores';
import { cn } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@tmex/ui/tabs';
import { DeviceEntryCard } from '@tmex/panels/settings';
import { FilesSettingsTab } from '@tmex/panels/settings';
import { LlmProvidersTab } from '@tmex/panels/settings';
import { SearchTab } from '@tmex/panels/settings';
import { TelegramBotsTab } from '@tmex/panels/settings';
import { TerminalSettingsTab } from '@tmex/panels/settings';
import { VersionTab } from '@tmex/panels/settings';
import { WebhooksTab } from '@tmex/panels/settings';
import { WeixinAccountsTab } from '@tmex/panels/settings';

// 灰色轨道(bg-muted)上嵌一个更亮的圆角药丸：亮色用 bg-background(白)，暗色用更亮的半透明覆盖，去边框。
// rounded-lg 与外层 rounded-xl 轨道同心收敛。（原侧边栏 Tabs 样式，侧边栏平铺后仅设置页使用）
const tabTriggerClassName =
  "rounded-lg data-active:bg-background data-active:text-foreground data-active:border-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:bg-input/60 dark:data-active:border-transparent text-[13px] transition-colors duration-200 [&_svg:not([class*='size-'])]:size-[15px]";

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

type SettingsTab = 'general' | 'devicesAndFiles' | 'notifications' | 'ai' | 'terminal';

export default function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refreshSettings } = useSiteStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const theme = useUIStore((state) => state.theme);
  const updateTheme = useSiteStore((state) => state.updateTheme);
  const isDark = theme === 'dark';

  // Site settings state
  const [siteName, setSiteName] = useState('tmex');
  const [siteUrl, setSiteUrl] = useState(window.location.origin);
  const [language, setLanguage] = useState<LocaleCode>('en_US');

  // Notifications state
  const [bellThrottleSeconds, setBellThrottleSeconds] = useState(6);
  const [notificationThrottleSeconds, setNotificationThrottleSeconds] = useState(3);
  const [enableBrowserNotificationToast, setEnableBrowserNotificationToast] = useState(true);
  const [enableNotificationPush, setEnableNotificationPush] = useState(true);
  const [enableBellPush, setEnableBellPush] = useState(true);
  const [enableBellSound, setEnableBellSound] = useState(true);
  const [sshReconnectMaxRetries, setSshReconnectMaxRetries] = useState(2);
  const [sshReconnectDelaySeconds, setSshReconnectDelaySeconds] = useState(10);
  const [showRefreshNotice, setShowRefreshNotice] = useState(false);

  const handleThemeChange = (checked: boolean) => {
    const nextTheme = checked ? 'dark' : 'light';
    updateTheme(nextTheme);
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

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings) {
      return;
    }

    setSiteName(settings.siteName);
    setSiteUrl(settings.siteUrl);
    setLanguage(settings.language ?? 'en_US');
    setBellThrottleSeconds(settings.bellThrottleSeconds);
    setNotificationThrottleSeconds(settings.notificationThrottleSeconds ?? 3);
    setEnableBrowserNotificationToast(settings.enableBrowserNotificationToast ?? true);
    setEnableNotificationPush(settings.enableNotificationPush ?? true);
    setEnableBellPush(settings.enableBellPush ?? true);
    setEnableBellSound(settings.enableBellSound ?? true);
  }, [settingsQuery.data?.settings]);

  const saveSiteMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateSiteSettingsRequest = {
        siteName,
        siteUrl,
        language,
        bellThrottleSeconds,
        notificationThrottleSeconds,
        enableBrowserNotificationToast,
        enableNotificationPush,
        enableBellPush,
        enableBellSound,
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

  const tabItems: {
    value: SettingsTab;
    label: string;
    icon: typeof SettingsIcon;
    testId: string;
  }[] = [
    {
      value: 'general',
      label: t('settings.tabGroup.general'),
      icon: SettingsIcon,
      testId: 'settings-tab-general',
    },
    {
      value: 'terminal',
      label: t('settings.tabGroup.terminal'),
      icon: Monitor,
      testId: 'settings-tab-terminal',
    },
    {
      value: 'devicesAndFiles',
      label: t('settings.tabGroup.devicesAndFiles'),
      icon: Server,
      testId: 'settings-tab-devicesAndFiles',
    },
    {
      value: 'notifications',
      label: t('settings.tabGroup.notifications'),
      icon: Bell,
      testId: 'settings-tab-notifications',
    },
    {
      value: 'ai',
      label: t('settings.tabGroup.ai'),
      icon: Sparkles,
      testId: 'settings-tab-ai',
    },
  ];

  // 保存按钮置于各自作用范围的卡片内（站点信息卡 / 通知卡），不再悬于卡片外
  const saveButton = (
    <div className="flex justify-end pt-2">
      <Button
        variant="secondary"
        data-testid="settings-save"
        onClick={() => saveSiteMutation.mutate()}
        disabled={saveSiteMutation.isPending}
        className="w-full sm:w-auto"
      >
        <Save className="h-4 w-4" />
        {t('common.save')}
      </Button>
    </div>
  );

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:gap-6 sm:p-5"
      data-testid="settings-page"
    >
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SettingsTab)}>
        <TabsList className="w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 group-data-horizontal/tabs:h-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabItems.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger
                key={item.value}
                value={item.value}
                data-testid={item.testId}
                className={cn(tabTriggerClassName, 'min-w-max gap-2 px-3.5')}
              >
                <Icon />
                {item.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {activeTab === 'general' && (
        <>
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
                      {I18N_MANIFEST.locales.find((l) => l.code === language)?.nativeName ??
                        language}
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

              {saveButton}
            </CardContent>
          </Card>

          <VersionTab />
        </>
      )}

      {activeTab === 'devicesAndFiles' && (
        <>
          <DeviceEntryCard />
          <FilesSettingsTab />
        </>
      )}

      {activeTab === 'notifications' && (
        <>
          <Card className="border-0 ring-0">
            <CardContent className="space-y-6 pt-6">
              <div className="space-y-3">
                <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                  <div className="min-w-0 pr-2">
                    <div className="text-sm font-medium">
                      {t('settings.enableNotificationPush')}
                    </div>
                  </div>
                  <Switch
                    checked={enableNotificationPush}
                    onCheckedChange={(checked) => setEnableNotificationPush(Boolean(checked))}
                    data-testid="settings-enable-notification-push"
                  />
                </div>

                <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                  <div className="min-w-0 pr-2">
                    <div className="text-sm font-medium">{t('settings.enableBellPush')}</div>
                  </div>
                  <Switch
                    checked={enableBellPush}
                    onCheckedChange={(checked) => setEnableBellPush(Boolean(checked))}
                    data-testid="settings-enable-bell-push"
                  />
                </div>

                <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                  <div className="min-w-0 pr-2">
                    <div className="text-sm font-medium">{t('settings.enableBellSound')}</div>
                  </div>
                  <Switch
                    checked={enableBellSound}
                    onCheckedChange={(checked) => setEnableBellSound(Boolean(checked))}
                    data-testid="settings-enable-bell-sound"
                  />
                </div>

                <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
                  <div className="min-w-0 pr-2">
                    <div className="text-sm font-medium">
                      {t('settings.enableBrowserNotificationToast')}
                    </div>
                  </div>
                  <Switch
                    checked={enableBrowserNotificationToast}
                    onCheckedChange={(checked) =>
                      setEnableBrowserNotificationToast(Boolean(checked))
                    }
                    data-testid="settings-enable-browser-notification-toast"
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
                  <label
                    className="block text-sm font-medium"
                    htmlFor="notification-throttle-input"
                  >
                    {t('settings.notificationThrottle')}
                  </label>
                  <Input
                    id="notification-throttle-input"
                    type="number"
                    value={notificationThrottleSeconds}
                    min={0}
                    max={300}
                    onChange={(event) => setNotificationThrottleSeconds(Number(event.target.value))}
                    className="min-h-10"
                  />
                </div>

                <div className="space-y-2">
                  <label
                    className="block text-sm font-medium"
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

              {saveButton}
            </CardContent>
          </Card>

          <TelegramBotsTab />
          <WeixinAccountsTab />
          <WebhooksTab />
        </>
      )}

      {activeTab === 'ai' && (
        <>
          <LlmProvidersTab />
          <SearchTab />
        </>
      )}

      {activeTab === 'terminal' && <TerminalSettingsTab />}
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
