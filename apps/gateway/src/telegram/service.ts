import { Bot } from 'gramio';
import { decrypt } from '../crypto';
import {
  createOrUpdatePendingTelegramChat,
  getAllTelegramBots,
  listAuthorizedTelegramChatsByBot,
  updateTelegramBot,
} from '../db';

function normalizeChatType(raw: string | undefined): 'private' | 'group' | 'supergroup' | 'channel' | 'unknown' {
  if (!raw) return 'unknown';
  if (raw === 'private' || raw === 'group' || raw === 'supergroup' || raw === 'channel') {
    return raw;
  }
  return 'unknown';
}

function buildChatDisplayName(params: {
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  fallback: string;
}): string {
  if (params.title?.trim()) {
    return params.title.trim();
  }
  if (params.username?.trim()) {
    return `@${params.username.trim()}`;
  }
  const fullName = `${params.firstName ?? ''} ${params.lastName ?? ''}`.trim();
  if (fullName) {
    return fullName;
  }
  return params.fallback;
}

interface RunningBot {
  id: string;
  token: string;
  bot: Bot;
}

export class TelegramService {
  private runningBots = new Map<string, RunningBot>();

  async sendGatewayOnlineMessage(siteName: string): Promise<void> {
    const text = [
      '🟢 Gateway 已上线',
      `站点：${siteName}`,
      `时间：${new Date().toLocaleString('zh-CN')}`,
    ].join('\n');

    await this.sendToAuthorizedChats({ text });
  }

  async refresh(): Promise<void> {
    const botConfigs = getAllTelegramBots();
    const activeIds = new Set(botConfigs.map((bot) => bot.id));

    const toStop: string[] = [];
    for (const [botId] of this.runningBots) {
      if (!activeIds.has(botId)) {
        toStop.push(botId);
      }
    }
    await Promise.all(toStop.map((botId) => this.stopBot(botId)));

    for (const config of botConfigs) {
      if (!config.enabled) {
        await this.stopBot(config.id);
        continue;
      }

      const token = await decrypt(config.tokenEnc);
      const running = this.runningBots.get(config.id);
      if (running && running.token === token) {
        continue;
      }

      if (running) {
        await this.stopBot(config.id);
      }

      const bot = new Bot(token);

      bot.on('message', async (context) => {
        const text = context.text?.trim();
        if (text !== '/start') {
          return;
        }

        const latest = getAllTelegramBots().find((item) => item.id === config.id);
        if (!latest || !latest.allowAuthRequests) {
          return;
        }

        const chat = context.chat;
        const from = context.from;
        const chatId = String(chat.id);
        const displayName = buildChatDisplayName({
          title: chat.title,
          username: chat.username,
          firstName: from?.firstName,
          lastName: from?.lastName,
          fallback: chatId,
        });

        try {
          const result = createOrUpdatePendingTelegramChat({
            botId: config.id,
            chatId,
            chatType: normalizeChatType(chat.type),
            displayName,
            appliedAt: new Date().toISOString(),
          });

          if (result.status === 'authorized') {
            await context.send('✅ 已授权，可接收通知。');
          } else {
            await context.send('⏳ 已收到授权申请，请在 tmex 设置页审批。');
          }
        } catch (err) {
          await context.send('❌ 授权申请失败，请联系管理员。');
          console.error('[telegram] failed to save pending chat:', err);
        }
      });

      bot.onError((error) => {
        console.error(`[telegram] bot ${config.id} runtime error:`, error);
      });

      await bot.start({
        longPolling: {
          timeout: 30,
        },
      });

      this.runningBots.set(config.id, {
        id: config.id,
        token,
        bot,
      });

      const offset = bot.updates['offset'] as number | undefined;
      if (typeof offset === 'number') {
        updateTelegramBot(config.id, { lastUpdateId: offset });
      }

      console.log(`[telegram] bot started: ${config.name} (${config.id})`);
    }
  }

  async sendToAuthorizedChats(params: {
    text: string;
  }): Promise<void> {
    for (const [botId, running] of this.runningBots) {
      const chats = listAuthorizedTelegramChatsByBot(botId);
      if (chats.length === 0) {
        continue;
      }

      await Promise.all(
        chats.map(async (chat) => {
          try {
            await running.bot.api.sendMessage({
              chat_id: chat.chatId,
              text: params.text,
            });
          } catch (err) {
            console.error(`[telegram] failed sending message to bot=${botId} chat=${chat.chatId}:`, err);
          }
        })
      );
    }
  }

  async sendTestMessage(botId: string, chatId: string, text: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      throw new Error('Bot 未启动或不可用');
    }

    await running.bot.api.sendMessage({
      chat_id: chatId,
      text,
    });
  }

  async stopAll(): Promise<void> {
    const botIds = Array.from(this.runningBots.keys());
    await Promise.all(botIds.map((botId) => this.stopBot(botId)));
  }

  async syncBotOffset(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      return;
    }

    const offset = running.bot.updates['offset'] as number | undefined;
    if (typeof offset === 'number') {
      updateTelegramBot(botId, { lastUpdateId: offset });
    }
  }

  private async stopBot(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      return;
    }

    await this.syncBotOffset(botId);

    try {
      await running.bot.stop();
    } catch (err) {
      console.error(`[telegram] failed to stop bot ${botId}:`, err);
    }

    this.runningBots.delete(botId);
    console.log(`[telegram] bot stopped: ${botId}`);
  }
}

export const telegramService = new TelegramService();
