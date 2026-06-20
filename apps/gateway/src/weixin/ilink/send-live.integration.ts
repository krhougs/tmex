// 微信 iLink 实测：用预先捕获的凭证发送文本 + 探测 context_token 失效 TTL（头号风险）。
// 登录是交互式扫码，无法纯终端自动化；故先在设置页扫码登录该 bot、给它发一条消息，
// 再从 gateway 日志或 weixin_account_users.last_context_token 取到 context_token，填入 test.env.local：
//   TEST_WEIXIN_BASE_URL / TEST_WEIXIN_BOT_TOKEN / TEST_WEIXIN_USER_ID / TEST_WEIXIN_CONTEXT_TOKEN
//   可选 TEST_WEIXIN_TTL_DELAY_MS：探测延迟（毫秒），跨多次运行二分 TTL。
// 运行：bun run --filter @tmex/gateway test:live:weixin

import { describe, expect, test } from 'bun:test';
import { requireLiveEnv } from '../../test-support/live-env';
import { sendMessage } from './api';
import { SESSION_EXPIRED_ERRCODE } from './types';

const env = requireLiveEnv(
  [
    'TEST_WEIXIN_BASE_URL',
    'TEST_WEIXIN_BOT_TOKEN',
    'TEST_WEIXIN_USER_ID',
    'TEST_WEIXIN_CONTEXT_TOKEN',
  ],
  '先在设置页扫码登录微信 bot，给它发一条消息，从 gateway 日志或 weixin_account_users.last_context_token 取 context_token 填入 test.env.local。'
);

function makeClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `openclaw-weixin-${hex}`;
}

async function probeSend(label: string) {
  const resp = await sendMessage({
    baseUrl: env.TEST_WEIXIN_BASE_URL,
    botToken: env.TEST_WEIXIN_BOT_TOKEN,
    toUserId: env.TEST_WEIXIN_USER_ID,
    contextToken: env.TEST_WEIXIN_CONTEXT_TOKEN,
    clientId: makeClientId(),
    items: [{ text: `tmex live probe (${label}) ${new Date().toISOString()}` }],
  });
  const expired = resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE;
  console.log(
    `[weixin-live] ${label} → ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} expired=${expired}`
  );
  return { resp, expired };
}

const delayMs = Number(process.env.TEST_WEIXIN_TTL_DELAY_MS ?? '0');

describe('weixin iLink live send', () => {
  test('立即用缓存 context_token 发送文本应成功（ret=0，未过期）', async () => {
    const { resp, expired } = await probeSend('immediate');
    expect(expired).toBe(false);
    expect(resp.ret ?? 0).toBe(0);
  });

  test.if(delayMs > 0)(
    `延迟 ${delayMs}ms 后用同一 token 再发（探测 TTL，仅记录观测）`,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const { resp } = await probeSend(`after-${delayMs}ms`);
      // TTL 未知，不强断言：token 仍有效则 ret=0；失效则 ret/errcode=-14。结论看上面日志。
      expect(resp).toBeDefined();
    },
    delayMs + 30_000
  );
});
