import { describe, expect, test } from 'bun:test';
import { TelegramService } from './service';

describe('TelegramService gateway startup message', () => {
  test('sendGatewayOnlineMessage 会向所有授权 chat 广播上线文案', async () => {
    const service = new TelegramService() as TelegramService & {
      sendToAuthorizedChats: (params: { text: string }) => Promise<void>;
    };

    let sentText = '';
    service.sendToAuthorizedChats = async (params) => {
      sentText = params.text;
    };

    await service.sendGatewayOnlineMessage('测试站点');

    expect(sentText).toContain('🟢 Gateway 已上线');
    expect(sentText).toContain('站点：测试站点');
    expect(sentText).toContain('时间：');
  });
});
