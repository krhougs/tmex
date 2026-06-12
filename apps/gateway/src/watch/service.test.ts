import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { EventType, WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import { getDb as getOrmDb } from '../db/client';
import {
  type CreateWatchRuleInput,
  type WatchRuleRecord,
  createWatchRule,
  getEnabledWatchRules,
  getWatchRuleById,
  getWatchRuleState,
} from '../db/watch';
import { WatchService, type WatchRuntimeLike, effectiveIntervalSeconds } from './service';

const TEST_DEVICE_ID = 'watch-service-test-device';

// ========== mock LLM server（generateObject 走 chat/completions 非流式） ==========

type MockResponder = (callIndex: number, body: Record<string, unknown>) => Response;

function jsonChatResponse(content: unknown): Response {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(content) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function createMockLlmServer(respond: MockResponder) {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        return new Response('not found', { status: 404 });
      }
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      return respond(requests.length - 1, body);
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(() => {
  for (const server of servers) {
    server.stop(true);
  }
});

// ========== harness ==========

interface Harness {
  service: WatchService;
  notifications: Array<{ eventType: EventType; event: Omit<WebhookEvent, 'eventType' | 'timestamp'> }>;
  broadcasts: Array<{ ruleId: string; eventType: number; payload: unknown }>;
  acquires: string[];
  releases: string[];
  captureCalls: string[];
  /** 创建并注册到本 harness 的规则（DB 共享，start 只加载本 harness 的规则） */
  makeRule: (overrides?: Partial<CreateWatchRuleInput>) => WatchRuleRecord;
  setScreen: (value: string | (() => string)) => void;
  setCaptureError: (error: Error | null) => void;
  setNow: (date: Date) => void;
  advanceMinutes: (minutes: number) => void;
  timers: Array<{ ms: number; cleared: boolean }>;
}

function createHarness(options: { llmBaseUrl?: string; errorThreshold?: number } = {}): Harness {
  let screenValue: string | (() => string) = '';
  let captureError: Error | null = null;
  let now = new Date('2026-06-13T12:00:00.000Z');
  const ownRuleIds = new Set<string>();

  const notifications: Harness['notifications'] = [];
  const broadcasts: Harness['broadcasts'] = [];
  const acquires: string[] = [];
  const releases: string[] = [];
  const captureCalls: string[] = [];
  const timers: Harness['timers'] = [];

  const runtime: WatchRuntimeLike = {
    connect: async () => {},
    capturePaneText: async (paneId) => {
      captureCalls.push(paneId);
      if (captureError) {
        throw captureError;
      }
      return typeof screenValue === 'function' ? screenValue() : screenValue;
    },
    subscribe: () => () => {},
    requestSnapshot: () => {},
  };

  const service = new WatchService({
    listEnabledRules: () => getEnabledWatchRules().filter((rule) => ownRuleIds.has(rule.id)),
    acquireRuntime: async (deviceId) => {
      acquires.push(deviceId);
      return runtime;
    },
    releaseRuntime: async (deviceId) => {
      releases.push(deviceId);
    },
    resolveModel: async () => {
      if (!options.llmBaseUrl) {
        throw new Error('no model configured in test');
      }
      return createOpenAICompatible({
        name: 'mock',
        baseURL: options.llmBaseUrl,
        apiKey: 'mock-key',
      }).chatModel('mock-model');
    },
    notify: async (eventType, event) => {
      notifications.push({ eventType, event });
    },
    broadcast: (ruleId, _deviceId, _paneId, eventType, payload) => {
      broadcasts.push({ ruleId, eventType, payload });
    },
    now: () => now,
    scheduleInterval: (_fn, ms) => {
      const entry = { ms, cleared: false };
      timers.push(entry);
      return () => {
        entry.cleared = true;
      };
    },
    errorThreshold: options.errorThreshold ?? 10,
    llmMaxRetries: 0,
  });

  return {
    service,
    notifications,
    broadcasts,
    acquires,
    releases,
    captureCalls,
    makeRule: (overrides = {}) => {
      const rule = createWatchRule({
        name: overrides.name ?? `rule-${crypto.randomUUID().slice(0, 8)}`,
        deviceId: TEST_DEVICE_ID,
        paneId: '%1',
        triggerType: 'match',
        pattern: 'ERROR',
        ...overrides,
      });
      ownRuleIds.add(rule.id);
      return rule;
    },
    setScreen: (value) => {
      screenValue = value;
    },
    setCaptureError: (error) => {
      captureError = error;
    },
    setNow: (date) => {
      now = date;
    },
    advanceMinutes: (minutes) => {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    timers,
  };
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'watch-test-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'auto',
    port: 22,
    createdAt: now,
    updatedAt: now,
  });
});

describe('WatchService - 调度与设备连接分组', () => {
  test('start 加载 enabled 规则；llm 型 interval 下限 30s、其余 5s', () => {
    expect(effectiveIntervalSeconds({ triggerType: 'match', intervalSeconds: 1 })).toBe(5);
    expect(effectiveIntervalSeconds({ triggerType: 'match', intervalSeconds: 45 })).toBe(45);
    expect(effectiveIntervalSeconds({ triggerType: 'llm', intervalSeconds: 10 })).toBe(30);
  });

  test('同设备多规则只 acquire 一次，最后一条规则移除时 release', async () => {
    const harness = createHarness();
    const rule1 = harness.makeRule({ pattern: 'AAA' });
    const rule2 = harness.makeRule({ pattern: 'BBB' });
    harness.setScreen('nothing interesting');

    await harness.service.start();
    expect(harness.service.isRuleScheduled(rule1.id)).toBe(true);
    expect(harness.service.isRuleScheduled(rule2.id)).toBe(true);

    await harness.service.tickRule(rule1.id);
    await harness.service.tickRule(rule2.id);
    expect(harness.acquires).toEqual([TEST_DEVICE_ID]);

    await harness.service.removeRule(rule1.id);
    expect(harness.releases).toEqual([]);

    await harness.service.removeRule(rule2.id);
    expect(harness.releases).toEqual([TEST_DEVICE_ID]);

    await harness.service.stop();
  });

  test('refreshRule 热更新：禁用规则后 timer 清理；重新启用后恢复调度', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({ pattern: 'XYZ' });
    await harness.service.start();
    expect(harness.timers.filter((t) => !t.cleared)).toHaveLength(1);

    const { updateWatchRule } = await import('../db/watch');
    updateWatchRule(rule.id, { enabled: false });
    await harness.service.refreshRule(rule.id);
    expect(harness.service.isRuleScheduled(rule.id)).toBe(false);
    expect(harness.timers.filter((t) => !t.cleared)).toHaveLength(0);
    expect(harness.releases).toEqual([]); // 未 tick 过，从未 acquire

    updateWatchRule(rule.id, { enabled: true });
    await harness.service.refreshRule(rule.id);
    expect(harness.service.isRuleScheduled(rule.id)).toBe(true);

    await harness.service.stop();
  });
});

describe('WatchService - match 型触发', () => {
  test('once：命中触发通知 + 广播 + 自动停用', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({ pattern: 'FAIL(ED)?', fireMode: 'once' });
    harness.setScreen('build FAILED\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0].eventType).toBe('watch_triggered');
    const payload = harness.notifications[0].event.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(rule.name);
    expect(payload.matchedText).toBe('FAILED');
    expect(String(payload.message)).toContain('FAILED');

    expect(harness.broadcasts).toHaveLength(1);
    expect(harness.broadcasts[0].eventType).toBe(wsBorsh.WATCH_EVENT_TRIGGERED);

    // once：触发后规则停用 + 调度移除
    expect(getWatchRuleById(rule.id)?.enabled).toBe(false);
    expect(harness.service.isRuleScheduled(rule.id)).toBe(false);
    expect(getWatchRuleState(rule.id)?.lastTriggeredAt).not.toBeNull();

    // 样本记录
    const samples = harness.service.getSamples(rule.id);
    expect(samples).toHaveLength(1);
    expect(samples[0].hit).toBe(true);

    await harness.service.stop();
  });

  test('repeat：cooldown 内不重复触发，过 cooldown 后再次触发', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({ pattern: 'PANIC', fireMode: 'repeat', cooldownSeconds: 600 });
    harness.setScreen('kernel PANIC\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1);

    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1); // cooldown 内

    harness.advanceMinutes(11);
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(2);
    expect(getWatchRuleById(rule.id)?.enabled).toBe(true); // repeat 不停用

    await harness.service.stop();
  });
});

describe('WatchService - unchanged 卡住全链路', () => {
  test('值变化重置计时；不变达阈值触发；once 防重；值再变化后可再次触发', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({
      triggerType: 'unchanged',
      pattern: '(\\d+)%',
      extractGroup: 1,
      unchangedMinutes: 10,
      fireMode: 'once',
    });
    await harness.service.start();

    harness.setScreen('downloading 50%\n');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.lastValue).toBe('50');
    expect(harness.notifications).toHaveLength(0);

    // 进度推进：重置计时
    harness.advanceMinutes(5);
    harness.setScreen('downloading 73%\n');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.lastValue).toBe('73');
    expect(harness.notifications).toHaveLength(0);

    // 卡住 11 分钟：触发
    harness.advanceMinutes(11);
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1);
    const payload = harness.notifications[0].event.payload as Record<string, unknown>;
    expect(payload.value).toBe('73');
    expect(payload.stuckMinutes).toBe(11);
    expect(getWatchRuleState(rule.id)?.triggeredSinceChange).toBe(true);
    // unchanged + once 不停用规则（等值变化后重新武装）
    expect(getWatchRuleById(rule.id)?.enabled).toBe(true);

    // once 防重
    harness.advanceMinutes(5);
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1);

    // 值变化后重新武装，再次卡住可再触发
    harness.setScreen('downloading 74%\n');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.triggeredSinceChange).toBe(false);
    harness.advanceMinutes(12);
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(2);

    await harness.service.stop();
  });

  test('进度行消失（reset）停止计时', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({
      triggerType: 'unchanged',
      pattern: '(\\d+)%',
      extractGroup: 1,
      unchangedMinutes: 10,
      noMatchBehavior: 'reset',
    });
    await harness.service.start();

    harness.setScreen('downloading 99%\n');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.lastValue).toBe('99');

    harness.setScreen('done.\n$ ');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.lastValue).toBeNull();
    expect(getWatchRuleState(rule.id)?.lastValueChangedAt).toBeNull();

    harness.advanceMinutes(30);
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(0);

    await harness.service.stop();
  });
});

describe('WatchService - LLM 介入', () => {
  test('confirmWithLlm：确认通过才触发；否决则不触发', async () => {
    let confirmed = false;
    const mock = createMockLlmServer(() => jsonChatResponse({ confirmed, reason: 'r' }));
    servers.push(mock.server);

    const harness = createHarness({ llmBaseUrl: mock.baseUrl });
    const rule = harness.makeRule({
      pattern: 'STALLED',
      fireMode: 'repeat',
      cooldownSeconds: 0,
      confirmWithLlm: true,
    });
    harness.setScreen('transfer STALLED\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(0); // 模型否决

    confirmed = true;
    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0].eventType).toBe('watch_triggered');
    const message = String((harness.notifications[0].event.payload as Record<string, unknown>).message);
    expect(message).not.toMatch(UNCONFIRMED_FRAGMENT);

    await harness.service.stop();
  });

  test('confirmWithLlm fail-open：模型不可用直接触发并标注未经确认，告警只发一次，恢复后重置', async () => {
    let failing = true;
    const mock = createMockLlmServer(() =>
      failing
        ? Response.json({ error: 'boom' }, { status: 500 })
        : jsonChatResponse({ confirmed: true, reason: 'ok' })
    );
    servers.push(mock.server);

    const harness = createHarness({ llmBaseUrl: mock.baseUrl });
    const rule = harness.makeRule({
      pattern: 'STUCK',
      fireMode: 'repeat',
      cooldownSeconds: 0,
      confirmWithLlm: true,
    });
    harness.setScreen('upload STUCK\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    // fail-open：触发 + 标注未经确认 + 模型不可用告警
    const triggered = harness.notifications.filter((n) => n.eventType === 'watch_triggered');
    const unavailable = harness.notifications.filter((n) => n.eventType === 'watch_model_unavailable');
    expect(triggered).toHaveLength(1);
    expect(unavailable).toHaveLength(1);
    expect(String((triggered[0].event.payload as Record<string, unknown>).message)).toMatch(
      UNCONFIRMED_FRAGMENT
    );
    expect((triggered[0].event.payload as Record<string, unknown>).unconfirmed).toBe(true);
    expect(
      harness.broadcasts.filter((b) => b.eventType === wsBorsh.WATCH_EVENT_MODEL_UNAVAILABLE)
    ).toHaveLength(1);
    expect(getWatchRuleState(rule.id)?.modelUnavailableNotified).toBe(true);

    // 第二次失败：不再发告警
    await harness.service.tickRule(rule.id);
    expect(
      harness.notifications.filter((n) => n.eventType === 'watch_model_unavailable')
    ).toHaveLength(1);

    // 模型恢复：触发不带标注，modelUnavailableNotified 重置
    failing = false;
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.modelUnavailableNotified).toBe(false);

    // 再次失败：重新告警一次
    failing = true;
    await harness.service.tickRule(rule.id);
    expect(
      harness.notifications.filter((n) => n.eventType === 'watch_model_unavailable')
    ).toHaveLength(2);

    await harness.service.stop();
  });

  test('summarizeWithLlm：摘要进通知文案；失败时降级原始匹配文本', async () => {
    let failing = false;
    const mock = createMockLlmServer(() =>
      failing
        ? Response.json({ error: 'boom' }, { status: 500 })
        : jsonChatResponse({ summary: 'wget stalled at 73% for 32 minutes' })
    );
    servers.push(mock.server);

    const harness = createHarness({ llmBaseUrl: mock.baseUrl });
    const rule = harness.makeRule({
      pattern: 'wget .*',
      fireMode: 'repeat',
      cooldownSeconds: 0,
      summarizeWithLlm: true,
    });
    harness.setScreen('wget downloading 73%\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(1);
    expect(
      String((harness.notifications[0].event.payload as Record<string, unknown>).message)
    ).toContain('wget stalled at 73% for 32 minutes');

    failing = true;
    await harness.service.tickRule(rule.id);
    const second = harness.notifications.filter((n) => n.eventType === 'watch_triggered')[1];
    // 降级为原始匹配文本
    expect(String((second.event.payload as Record<string, unknown>).message)).toContain(
      'wget downloading 73%'
    );
    // 摘要失败同样适用"模型不可用告警一次"
    expect(
      harness.notifications.filter((n) => n.eventType === 'watch_model_unavailable')
    ).toHaveLength(1);

    await harness.service.stop();
  });

  test('llm 型：matched 才触发，受 cooldown；模型失败计 consecutiveErrors', async () => {
    let mode: 'no' | 'yes' | 'fail' = 'no';
    const mock = createMockLlmServer(() => {
      if (mode === 'fail') {
        return Response.json({ error: 'boom' }, { status: 500 });
      }
      return jsonChatResponse({ matched: mode === 'yes', reason: 'compile finished' });
    });
    servers.push(mock.server);

    const harness = createHarness({ llmBaseUrl: mock.baseUrl });
    const rule = harness.makeRule({
      triggerType: 'llm',
      pattern: null,
      conditionPrompt: 'the build has finished',
      fireMode: 'repeat',
      cooldownSeconds: 600,
    });
    harness.setScreen('compiling...\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    expect(harness.notifications).toHaveLength(0);

    mode = 'yes';
    await harness.service.tickRule(rule.id);
    expect(harness.notifications.filter((n) => n.eventType === 'watch_triggered')).toHaveLength(1);
    const payload = harness.notifications[0].event.payload as Record<string, unknown>;
    expect(String(payload.message)).toContain('compile finished');

    // cooldown 内不再触发
    await harness.service.tickRule(rule.id);
    expect(harness.notifications.filter((n) => n.eventType === 'watch_triggered')).toHaveLength(1);

    // 模型失败：consecutiveErrors 累计 + 告警一次
    mode = 'fail';
    await harness.service.tickRule(rule.id);
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.consecutiveErrors).toBe(2);
    expect(
      harness.notifications.filter((n) => n.eventType === 'watch_model_unavailable')
    ).toHaveLength(1);

    // 恢复后清零
    mode = 'no';
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.consecutiveErrors).toBe(0);
    expect(getWatchRuleState(rule.id)?.modelUnavailableNotified).toBe(false);

    await harness.service.stop();
  });

  test('llm 型 once：触发后自动停用', async () => {
    const mock = createMockLlmServer(() => jsonChatResponse({ matched: true, reason: 'done' }));
    servers.push(mock.server);

    const harness = createHarness({ llmBaseUrl: mock.baseUrl });
    const rule = harness.makeRule({
      triggerType: 'llm',
      pattern: null,
      conditionPrompt: 'done?',
      fireMode: 'once',
    });
    harness.setScreen('done\n');
    await harness.service.start();

    await harness.service.tickRule(rule.id);
    expect(harness.notifications.filter((n) => n.eventType === 'watch_triggered')).toHaveLength(1);
    expect(getWatchRuleById(rule.id)?.enabled).toBe(false);
    expect(harness.service.isRuleScheduled(rule.id)).toBe(false);

    await harness.service.stop();
  });
});

describe('WatchService - 错误与自动停用', () => {
  test('capture 连续失败达阈值自动停用 + watch_rule_error 通知与广播；capture 成功重置计数', async () => {
    const harness = createHarness({ errorThreshold: 10 });
    const rule = harness.makeRule({ pattern: 'X', fireMode: 'repeat' });
    await harness.service.start();

    // 先失败几次再成功：计数重置
    harness.setCaptureError(new Error("can't find pane: %1"));
    await harness.service.tickRule(rule.id);
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.consecutiveErrors).toBe(2);
    expect(getWatchRuleState(rule.id)?.lastError).toContain("can't find pane");

    harness.setCaptureError(null);
    harness.setScreen('all good\n');
    await harness.service.tickRule(rule.id);
    expect(getWatchRuleState(rule.id)?.consecutiveErrors).toBe(0);
    expect(getWatchRuleState(rule.id)?.lastError).toBeNull();

    // 连续失败 10 次：自动停用
    harness.setCaptureError(new Error("can't find pane: %1"));
    for (let i = 0; i < 10; i++) {
      await harness.service.tickRule(rule.id);
    }
    expect(getWatchRuleById(rule.id)?.enabled).toBe(false);
    expect(harness.service.isRuleScheduled(rule.id)).toBe(false);

    const ruleErrors = harness.notifications.filter((n) => n.eventType === 'watch_rule_error');
    expect(ruleErrors).toHaveLength(1);
    expect(String((ruleErrors[0].event.payload as Record<string, unknown>).message)).toContain(
      rule.name
    );
    expect(
      harness.broadcasts.filter((b) => b.eventType === wsBorsh.WATCH_EVENT_RULE_ERROR)
    ).toHaveLength(1);

    await harness.service.stop();
  });

  test('无效 pattern 同样计入 consecutiveErrors 并最终停用', async () => {
    const harness = createHarness({ errorThreshold: 3 });
    const rule = harness.makeRule({ pattern: '([', fireMode: 'repeat' });
    harness.setScreen('anything\n');
    await harness.service.start();

    for (let i = 0; i < 3; i++) {
      await harness.service.tickRule(rule.id);
    }
    expect(getWatchRuleById(rule.id)?.enabled).toBe(false);
    expect(getWatchRuleState(rule.id)?.lastError).toContain('invalid pattern');

    await harness.service.stop();
  });

  test('ring buffer 样本上限 120', async () => {
    const harness = createHarness();
    const rule = harness.makeRule({ pattern: 'NOPE', fireMode: 'repeat' });
    harness.setScreen('quiet\n');
    await harness.service.start();

    for (let i = 0; i < 130; i++) {
      harness.advanceMinutes(1);
      await harness.service.tickRule(rule.id);
    }
    const samples = harness.service.getSamples(rule.id);
    expect(samples).toHaveLength(120);
    expect(samples.every((s) => s.hit === false)).toBe(true);

    await harness.service.stop();
  });
});

// 未经确认标注的稳定片段（测试环境 locale 可能为 zh_CN 或 en_US）
const UNCONFIRMED_FRAGMENT = /未经 LLM|not LLM-confirmed/;
