// Web 搜索实测：用真实 key 跑一次 web_search。
// 凭证来自 test.env.local：TEST_TAVILY_API_KEY / TEST_BRAVE_API_KEY，二者任选其一即可
// （配了哪个就测哪个，都配则都测）；一个都没配才报错退出。
//
// 运行：bun run --filter @tmex/gateway test:live:search

import { describe, expect, test } from 'bun:test';
import { encrypt } from '../../crypto';
import type { AgentSearchProvider, AgentSettingsRecord } from '../../db/agent';
import { requireAnyLiveEnv } from '../../test-support/live-env';
import { createWebSearchTool } from './web';

const env = requireAnyLiveEnv(
  ['TEST_TAVILY_API_KEY', 'TEST_BRAVE_API_KEY'],
  'TEST_TAVILY_API_KEY 填 Tavily 的 API Key（tvly-...），TEST_BRAVE_API_KEY 填 Brave 的 Subscription Token。'
);

type ExecutableTool = {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

const execOptions = { toolCallId: 'live-search', messages: [] };

async function settingsFor(
  provider: AgentSearchProvider,
  apiKeyEnc: string
): Promise<AgentSettingsRecord> {
  return {
    id: 1,
    searchProvider: provider,
    tavilyApiKeyEnc: provider === 'tavily' ? apiKeyEnc : null,
    braveApiKeyEnc: provider === 'brave' ? apiKeyEnc : null,
    defaultProviderId: null,
    defaultModelId: null,
    updatedAt: new Date().toISOString(),
  };
}

// web_search 工具会把结果序列化后截断到 8KB 再交给模型（truncateUtf8），
// 因此输出不保证是完整合法 JSON；断言落在字符串内容而非 JSON.parse。
async function runSearch(settings: AgentSettingsRecord): Promise<string> {
  const tool = await createWebSearchTool({ settings });
  expect(tool).not.toBeNull();

  const output = (await (tool as unknown as ExecutableTool).execute(
    { query: 'OpenAI' },
    execOptions
  )) as string;

  expect(output).not.toContain('Web search failed');
  return output;
}

describe('web_search live integration', () => {
  test.if(Boolean(env.TEST_TAVILY_API_KEY))('Tavily 真实 key 返回结果', async () => {
    const settings = await settingsFor('tavily', await encrypt(env.TEST_TAVILY_API_KEY));
    const output = await runSearch(settings);
    expect(output).toContain('"url"');
    expect(output).toMatch(/https?:\/\//);
  });

  test.if(Boolean(env.TEST_BRAVE_API_KEY))('Brave 真实 key 返回结果', async () => {
    const settings = await settingsFor('brave', await encrypt(env.TEST_BRAVE_API_KEY));
    const output = await runSearch(settings);
    expect(output).toContain('"url"');
    expect(output).toMatch(/https?:\/\//);
  });
});
