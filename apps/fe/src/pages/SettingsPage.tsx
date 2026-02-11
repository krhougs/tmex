import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SiteSettings,
  TelegramBotChat,
  TelegramBotWithStats,
  UpdateSiteSettingsRequest,
} from '@tmex/shared';
import { Loader2, RefreshCcw, RotateCcw, Save, Send, Shield, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '../components/ui';
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
  const queryClient = useQueryClient();
  const { refreshSettings } = useSiteStore();

  const [siteName, setSiteName] = useState('tmex');
  const [siteUrl, setSiteUrl] = useState(window.location.origin);
  const [bellThrottleSeconds, setBellThrottleSeconds] = useState(6);
  const [sshReconnectMaxRetries, setSshReconnectMaxRetries] = useState(2);
  const [sshReconnectDelaySeconds, setSshReconnectDelaySeconds] = useState(10);

  const [newBotName, setNewBotName] = useState('');
  const [newBotToken, setNewBotToken] = useState('');
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['site-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/site');
      if (!res.ok) {
        throw new Error(await parseApiError(res, '加载设置失败'));
      }
      return (await res.json()) as SiteSettingsResponse;
    },
  });

  const botsQuery = useQuery({
    queryKey: ['telegram-bots'],
    queryFn: async () => {
      const res = await fetch('/api/settings/telegram/bots');
      if (!res.ok) {
        throw new Error(await parseApiError(res, '加载 Bot 列表失败'));
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
    setBellThrottleSeconds(settings.bellThrottleSeconds);
    setSshReconnectMaxRetries(settings.sshReconnectMaxRetries);
    setSshReconnectDelaySeconds(settings.sshReconnectDelaySeconds);
  }, [settingsQuery.data?.settings]);

  const saveSiteMutation = useMutation({
    mutationFn: async () => {
      const payload: UpdateSiteSettingsRequest = {
        siteName,
        siteUrl,
        bellThrottleSeconds,
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
        throw new Error(await parseApiError(res, '保存设置失败'));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['site-settings'] }),
        refreshSettings(),
      ]);
      toast.success('站点设置已保存');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '保存设置失败');
    },
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/restart', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, '重启请求失败'));
      }
    },
    onSuccess: () => {
      toast.success('Gateway 重启请求已发送');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '重启请求失败');
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
        throw new Error(await parseApiError(res, '新增 Bot 失败'));
      }
    },
    onSuccess: async () => {
      setNewBotName('');
      setNewBotToken('');
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success('Bot 已创建');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '新增 Bot 失败');
    },
  });

  const bots = botsQuery.data?.bots ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">系统设置</h1>
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
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>站点设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="site-name-input">
              站点名称
            </label>
            <Input
              id="site-name-input"
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
              placeholder="tmex"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="site-url-input">
              站点访问 URL
            </label>
            <Input
              id="site-url-input"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder="http://localhost:3000"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="bell-throttle-input">
                Bell 频控（秒）
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
                SSH 重连次数
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
              <label className="block text-sm font-medium mb-1.5" htmlFor="ssh-reconnect-delay-input">
                SSH 重连等待（秒）
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
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              重启 Gateway
            </Button>

            <Button
              variant="primary"
              onClick={() => saveSiteMutation.mutate()}
              disabled={saveSiteMutation.isPending}
            >
              <Save className="h-4 w-4" />
              保存设置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telegram Bot 管理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium mb-1.5" htmlFor="new-bot-name">
                Bot 名称
              </label>
              <Input
                id="new-bot-name"
                value={newBotName}
                onChange={(event) => setNewBotName(event.target.value)}
                placeholder="如：ops-bot"
              />
            </div>

            <div className="md:col-span-7">
              <label className="block text-sm font-medium mb-1.5" htmlFor="new-bot-token">
                Bot Token
              </label>
              <Input
                id="new-bot-token"
                type="password"
                value={newBotToken}
                onChange={(event) => setNewBotToken(event.target.value)}
                placeholder="123456:AA..."
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
                新增 Bot
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {botsQuery.isLoading && (
              <div className="text-sm text-[var(--color-text-secondary)]">加载 Bot 列表中...</div>
            )}

            {!botsQuery.isLoading && bots.length === 0 && (
              <div className="text-sm text-[var(--color-text-secondary)]">暂无 Bot，先添加一个。</div>
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
        throw new Error(await parseApiError(res, '加载 chat 列表失败'));
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
        throw new Error(await parseApiError(res, '更新 Bot 失败'));
      }
    },
    onSuccess: async () => {
      setToken('');
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success('Bot 已更新');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '更新 Bot 失败');
    },
  });

  const deleteBotMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, '删除 Bot 失败'));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['telegram-bots'] });
      toast.success('Bot 已删除');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '删除 Bot 失败');
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}/approve`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, '批准授权失败'));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
        queryClient.invalidateQueries({ queryKey: ['telegram-bot-chats', bot.id] }),
      ]);
      toast.success('授权已批准');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '批准授权失败');
    },
  });

  const removeChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, '删除 chat 失败'));
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['telegram-bots'] }),
        queryClient.invalidateQueries({ queryKey: ['telegram-bot-chats', bot.id] }),
      ]);
      toast.success('chat 已移除');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '删除 chat 失败');
    },
  });

  const testChatMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await fetch(`/api/settings/telegram/bots/${bot.id}/chats/${encodeURIComponent(chatId)}/test`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, '发送测试消息失败'));
      }
    },
    onSuccess: () => {
      toast.success('测试消息已发送');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '发送测试消息失败');
    },
  });

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{bot.name}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">
            已授权 {bot.authorizedCount} / 待授权 {bot.pendingCount}（总上限 8）
          </div>
        </div>
        <Button variant="ghost" onClick={onToggleExpand}>
          {expanded ? '收起' : '展开'}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-3">
          <label className="block text-sm font-medium mb-1.5" htmlFor={`bot-name-${bot.id}`}>
            名称
          </label>
          <Input id={`bot-name-${bot.id}`} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="md:col-span-4">
          <label className="block text-sm font-medium mb-1.5" htmlFor={`bot-token-${bot.id}`}>
            Token（留空不改）
          </label>
          <Input
            id={`bot-token-${bot.id}`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="输入新 token"
          />
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            启用 Bot
          </label>
        </div>
        <div className="md:col-span-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={allowAuthRequests}
              onChange={(event) => setAllowAuthRequests(event.target.checked)}
            />
            允许申请授权
          </label>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="danger" onClick={() => deleteBotMutation.mutate()}>
          <Trash2 className="h-4 w-4" />
          删除 Bot
        </Button>
        <Button variant="primary" onClick={() => patchBotMutation.mutate()}>
          <Save className="h-4 w-4" />
          保存 Bot 配置
        </Button>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-[var(--color-border)]">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1">
              <Shield className="h-4 w-4" />
              待授权
            </h3>
            {groupedChats.pending.length === 0 && (
              <div className="text-xs text-[var(--color-text-secondary)]">暂无待授权 chat</div>
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
              已授权
            </h3>
            {groupedChats.authorized.length === 0 && (
              <div className="text-xs text-[var(--color-text-secondary)]">暂无已授权 chat</div>
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
            <div className="lg:col-span-2 text-xs text-[var(--color-text-secondary)]">加载 chat 列表中...</div>
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
  return (
    <div className="rounded border border-[var(--color-border)] p-3 bg-[var(--color-bg)] space-y-2">
      <div className="text-sm font-medium truncate" title={chat.displayName}>
        {chat.displayName}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)]">
        chatId：{chat.chatId}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)]">
        申请时间：{new Date(chat.appliedAt).toLocaleString('zh-CN')}
      </div>

      <div className="flex items-center justify-end gap-2">
        {pending ? (
          <>
            <Button variant="default" size="sm" onClick={onDelete}>
              拒绝
            </Button>
            <Button variant="primary" size="sm" onClick={onApprove}>
              批准
            </Button>
          </>
        ) : (
          <>
            <Button variant="default" size="sm" onClick={onTest}>
              <Send className="h-3.5 w-3.5" />
              测试消息
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              撤销授权
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
