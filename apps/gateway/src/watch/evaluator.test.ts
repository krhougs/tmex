import { describe, expect, test } from 'bun:test';
import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';
import { compileWatchPattern, evaluateWatchRule, findLastMatch } from './evaluator';

const NOW = new Date('2026-06-13T12:00:00.000Z');

function minutesBefore(minutes: number, base: Date = NOW): string {
  return new Date(base.getTime() - minutes * 60_000).toISOString();
}

function makeRule(overrides: Partial<WatchRuleRecord> = {}): WatchRuleRecord {
  return {
    id: 'rule-1',
    name: 'test rule',
    deviceId: 'device-1',
    paneId: '%1',
    enabled: true,
    triggerType: 'match',
    pattern: null,
    patternFlags: '',
    extractGroup: 0,
    conditionPrompt: null,
    providerId: null,
    modelId: null,
    confirmWithLlm: false,
    summarizeWithLlm: false,
    intervalSeconds: 30,
    unchangedMinutes: null,
    noMatchBehavior: 'reset',
    fireMode: 'once',
    cooldownSeconds: 600,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<WatchRuleStateRecord> = {}): WatchRuleStateRecord {
  return {
    ruleId: 'rule-1',
    lastSampledAt: null,
    lastValue: null,
    lastValueChangedAt: null,
    triggeredSinceChange: false,
    lastTriggeredAt: null,
    consecutiveErrors: 0,
    lastError: null,
    modelUnavailableNotified: false,
    ...overrides,
  };
}

describe('compileWatchPattern', () => {
  test('appends g flag and dedupes user flags', () => {
    // RegExp.flags 返回按字母序规范化后的 flags
    expect(compileWatchPattern('a', 'gim').flags).toBe('gim');
    expect(compileWatchPattern('a', 'i').flags).toBe('gi');
    expect(compileWatchPattern('a', '').flags).toBe('g');
    expect(compileWatchPattern('a', 'gg').flags).toBe('g');
  });

  test('invalid flags throw', () => {
    expect(() => compileWatchPattern('a', 'q')).toThrow();
  });
});

describe('findLastMatch', () => {
  test('returns the last occurrence', () => {
    const match = findLastMatch('10%\n20%\n73%', compileWatchPattern('(\\d+)%', ''));
    expect(match?.[0]).toBe('73%');
    expect(match?.[1]).toBe('73');
  });

  test('zero-width pattern does not loop forever', () => {
    const match = findLastMatch('abc', compileWatchPattern('\\b', ''));
    expect(match).not.toBeNull();
  });

  test('no match returns null', () => {
    expect(findLastMatch('hello', compileWatchPattern('\\d+', ''))).toBeNull();
  });
});

describe('match 型', () => {
  test('命中即 hit，matchedText 取最后一个命中', () => {
    const rule = makeRule({ triggerType: 'match', pattern: 'ERROR: (\\w+)' });
    const output = evaluateWatchRule({
      screen: 'ERROR: first\nok\nERROR: second\n',
      rule,
      state: null,
      now: NOW,
    });
    expect(output.hit).toBe(true);
    expect(output.matchedText).toBe('ERROR: second');
    expect(output.error).toBeUndefined();
    expect(output.stateUpdates).toEqual({});
  });

  test('无命中不 hit', () => {
    const rule = makeRule({ triggerType: 'match', pattern: 'ERROR' });
    const output = evaluateWatchRule({ screen: 'all good\n', rule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.matchedText).toBeUndefined();
  });

  test('flags 生效（忽略大小写）且去重不报错', () => {
    const rule = makeRule({ triggerType: 'match', pattern: 'error', patternFlags: 'gi' });
    const output = evaluateWatchRule({ screen: 'ERROR here\n', rule, state: null, now: NOW });
    expect(output.hit).toBe(true);
    expect(output.matchedText).toBe('ERROR');
  });

  test('无效 pattern 返回规则错误而非 hit', () => {
    const rule = makeRule({ triggerType: 'match', pattern: '([' });
    const output = evaluateWatchRule({ screen: 'anything', rule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.error).toMatch(/invalid pattern/);
  });

  test('pattern 为空返回规则错误', () => {
    const rule = makeRule({ triggerType: 'match', pattern: null });
    const output = evaluateWatchRule({ screen: 'anything', rule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.error).toBe('pattern is empty');
  });

  test('repeat 模式 cooldown 内不 hit、过 cooldown 后恢复 hit', () => {
    const rule = makeRule({
      triggerType: 'match',
      pattern: 'ERROR',
      fireMode: 'repeat',
      cooldownSeconds: 600,
    });

    const inCooldown = evaluateWatchRule({
      screen: 'ERROR\n',
      rule,
      state: makeState({ lastTriggeredAt: minutesBefore(5) }),
      now: NOW,
    });
    expect(inCooldown.hit).toBe(false);

    const afterCooldown = evaluateWatchRule({
      screen: 'ERROR\n',
      rule,
      state: makeState({ lastTriggeredAt: minutesBefore(11) }),
      now: NOW,
    });
    expect(afterCooldown.hit).toBe(true);
  });

  test('llm 型走 evaluator 返回错误', () => {
    const rule = makeRule({ triggerType: 'llm', conditionPrompt: 'is it done?' });
    const output = evaluateWatchRule({ screen: 'x', rule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.error).toMatch(/llm rules/);
  });
});

describe('unchanged 型', () => {
  const baseRule = makeRule({
    triggerType: 'unchanged',
    pattern: '(\\d+)%',
    extractGroup: 1,
    unchangedMinutes: 10,
  });

  test('首次见到值：记录 lastValue 与计时起点，不 hit', () => {
    const output = evaluateWatchRule({ screen: 'progress 42%\n', rule: baseRule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
    expect(output.stateUpdates).toEqual({
      lastValue: '42',
      lastValueChangedAt: NOW.toISOString(),
      triggeredSinceChange: false,
    });
  });

  test('值变化：重置计时与 once 防重标记，不 hit', () => {
    const state = makeState({
      lastValue: '42',
      lastValueChangedAt: minutesBefore(30),
      triggeredSinceChange: true,
    });
    const output = evaluateWatchRule({ screen: 'progress 43%\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({
      lastValue: '43',
      lastValueChangedAt: NOW.toISOString(),
      triggeredSinceChange: false,
    });
  });

  test('值不变但未达阈值：不 hit、无状态更新', () => {
    const state = makeState({ lastValue: '42', lastValueChangedAt: minutesBefore(9) });
    const output = evaluateWatchRule({ screen: 'progress 42%\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
    expect(output.stateUpdates).toEqual({});
  });

  test('值不变达到阈值：hit 并报告 stuckMinutes', () => {
    const state = makeState({ lastValue: '42', lastValueChangedAt: minutesBefore(25) });
    const output = evaluateWatchRule({ screen: 'progress 42%\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(true);
    expect(output.value).toBe('42');
    expect(output.matchedText).toBe('42%');
    expect(output.stuckMinutes).toBe(25);
    // 触发侧状态（lastTriggeredAt/triggeredSinceChange）由 service 在真正触发后写入
    expect(output.stateUpdates).toEqual({});
  });

  test('多个命中取屏幕最后一个的提取值', () => {
    const state = makeState({ lastValue: '99', lastValueChangedAt: minutesBefore(25) });
    const output = evaluateWatchRule({
      screen: 'old 10%\nnewer 50%\nlatest 99%\n',
      rule: baseRule,
      state,
      now: NOW,
    });
    expect(output.hit).toBe(true);
    expect(output.value).toBe('99');
  });

  test('once：triggeredSinceChange 已置位则不重复 hit', () => {
    const state = makeState({
      lastValue: '42',
      lastValueChangedAt: minutesBefore(25),
      triggeredSinceChange: true,
    });
    const output = evaluateWatchRule({ screen: 'progress 42%\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(false);
  });

  test('repeat：cooldown 内不 hit，过 cooldown 再次 hit', () => {
    const rule = makeRule({
      ...baseRule,
      fireMode: 'repeat',
      cooldownSeconds: 600,
    });

    const inCooldown = evaluateWatchRule({
      screen: 'progress 42%\n',
      rule,
      state: makeState({
        lastValue: '42',
        lastValueChangedAt: minutesBefore(40),
        triggeredSinceChange: true,
        lastTriggeredAt: minutesBefore(5),
      }),
      now: NOW,
    });
    expect(inCooldown.hit).toBe(false);

    const afterCooldown = evaluateWatchRule({
      screen: 'progress 42%\n',
      rule,
      state: makeState({
        lastValue: '42',
        lastValueChangedAt: minutesBefore(40),
        triggeredSinceChange: true,
        lastTriggeredAt: minutesBefore(15),
      }),
      now: NOW,
    });
    expect(afterCooldown.hit).toBe(true);
  });

  test('无命中 + reset：清空计时（任务结束停止计时）', () => {
    const state = makeState({
      lastValue: '42',
      lastValueChangedAt: minutesBefore(25),
      triggeredSinceChange: true,
    });
    const output = evaluateWatchRule({ screen: 'done.\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({
      lastValue: null,
      lastValueChangedAt: null,
      triggeredSinceChange: false,
    });
  });

  test('无命中 + reset：状态本来为空时不产生更新', () => {
    const output = evaluateWatchRule({ screen: 'done.\n', rule: baseRule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({});
  });

  test('无命中 + ignore：保持计时不动', () => {
    const rule = makeRule({ ...baseRule, noMatchBehavior: 'ignore' });
    const state = makeState({ lastValue: '42', lastValueChangedAt: minutesBefore(5) });
    const output = evaluateWatchRule({ screen: 'flickering frame\n', rule, state, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({});
  });

  test('捕获组未参与匹配时按无命中处理', () => {
    const rule = makeRule({
      triggerType: 'unchanged',
      pattern: 'progress (\\d+)?',
      extractGroup: 1,
      unchangedMinutes: 10,
      noMatchBehavior: 'ignore',
    });
    const output = evaluateWatchRule({ screen: 'progress \n', rule, state: null, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.value).toBeUndefined();
    expect(output.stateUpdates).toEqual({});
  });

  test('lastValueChangedAt 缺失时按值变化处理（自愈）', () => {
    const state = makeState({ lastValue: '42', lastValueChangedAt: null });
    const output = evaluateWatchRule({ screen: 'progress 42%\n', rule: baseRule, state, now: NOW });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates.lastValueChangedAt).toBe(NOW.toISOString());
  });
});
