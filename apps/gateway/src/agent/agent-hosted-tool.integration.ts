// Hosted tool 实测：用真实（中转）openai-responses provider 跑一次带 image_generation 的 agent run。
// 复现/验证：① hosted tool 可被注册调用；② 调用失败也不卡死——run 必落到终态（idle/error）。
// 凭证来自 test.env.local：TEST_LLM_BASE_URL / TEST_LLM_API_KEY / TEST_LLM_MODEL，
// 且需 TEST_LLM_PROTOCOL=openai-responses（hosted 工具仅 Responses API 可用）。
//
// 运行：bun run --filter @tmex/gateway test:live:hosted-tool

import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { AgentEventPayloadMap } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { encrypt } from '../crypto';
import {
  createAgentSession,
  ensureAgentSettingsInitialized,
  getAgentSessionById,
} from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { ensureSiteSettingsInitialized } from '../db/index';
import { createLlmProvider } from '../db/llm';
import { requireLiveEnv } from '../test-support/live-env';
import { AgentRun, type AgentRunDeps } from './run';

const env = requireLiveEnv(
  ['TEST_LLM_BASE_URL', 'TEST_LLM_API_KEY', 'TEST_LLM_MODEL'],
  'TEST_LLM_BASE_URL/API_KEY/MODEL 指向支持 image_generation 的中转 gpt，且 TEST_LLM_PROTOCOL=openai-responses。'
);

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
});

interface Broadcast {
  eventType: number;
  payload: unknown;
}

describe('agent hosted tool (image_generation) live integration', () => {
  test('运行带 image_generation 的会话不卡死并落到终态', async () => {
    const provider = createLlmProvider({
      name: `live-hosted-${crypto.randomUUID().slice(0, 8)}`,
      protocol: 'openai-responses',
      baseUrl: env.TEST_LLM_BASE_URL,
      apiKeyEnc: await encrypt(env.TEST_LLM_API_KEY),
    });

    const session = createAgentSession({
      title: 'hosted-tool-live',
      deviceId: null,
      paneId: null,
      providerId: provider.id,
      modelId: env.TEST_LLM_MODEL,
      providerHostedTools: ['image_generation'],
    });

    // 触发模型去用 image_generation
    const { appendAgentMessage } = await import('../db/agent');
    appendAgentMessage(session.id, 'user', {
      role: 'user',
      content: 'Generate a small image of a red circle on a white background.',
    });

    const broadcasts: Broadcast[] = [];
    const deps: Partial<AgentRunDeps> = {
      broadcast: <K extends keyof AgentEventPayloadMap>(
        _sessionId: string,
        eventType: K,
        payload: AgentEventPayloadMap[K]
      ) => {
        broadcasts.push({ eventType, payload });
      },
      notify: async () => {},
      generateTitle: async () => 'hosted-tool-live',
      notifyTurnFinished: false,
      // 留足上游出图时间，但仍有看门狗兜底
      streamIdleTimeoutMs: 120_000,
    };

    const run = new AgentRun(session.id, deps);
    const outcome = await run.execute();

    // 关键：run 必须落到终态（不卡死）
    expect(['idle', 'error']).toContain(outcome);
    expect(getAgentSessionById(session.id)?.status).toMatch(/idle|error/);

    // 观测到工具调用 / 结果 / 错误任一即说明 hosted tool 链路被走到（或被优雅失败回喂）
    const sawToolActivity = broadcasts.some(
      (b) =>
        b.eventType === wsBorsh.AGENT_EVENT_TOOL_CALL ||
        b.eventType === wsBorsh.AGENT_EVENT_TOOL_RESULT ||
        b.eventType === wsBorsh.AGENT_EVENT_ERROR
    );
    // 打印一份摘要，便于人工核对 image_generation 是否真出图
    console.log(
      '[hosted-tool-live] outcome=%s events=%o',
      outcome,
      broadcasts.map((b) => b.eventType)
    );
    expect(sawToolActivity).toBe(true);
  }, 180_000);
});
