import { describe, expect, test } from 'bun:test';
import { createRedactionMiddleware } from './redaction-middleware';

const mw = createRedactionMiddleware();

async function transform(prompt: unknown[]) {
  const result = await mw.transformParams?.({
    type: 'generate',
    // biome-ignore lint/suspicious/noExplicitAny: 测试构造最小 params
    params: { prompt } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 测试不需要真实 model
    model: {} as any,
  });
  return (result as { prompt: unknown[] }).prompt;
}

describe('redaction middleware', () => {
  test('tool 角色的 text 工具结果被消毒', async () => {
    const prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read_screen',
            output: { type: 'text', value: 'router# Authorization: Bearer eyJabc.def-ghi' },
          },
        ],
      },
    ];
    const out = (await transform(prompt)) as Array<{ content: Array<{ output: { value: string } }> }>;
    expect(out[0].content[0].output.value).toBe('router# Authorization: Bearer [REDACTED:token]');
  });

  test('json 工具结果递归消毒字符串叶子', async () => {
    const prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'fetch_url',
            output: {
              type: 'json',
              value: { lines: ['enable secret 5 $1$xx$hash', 'ok'], n: 2 },
            },
          },
        ],
      },
    ];
    const out = (await transform(prompt)) as Array<{
      content: Array<{ output: { value: { lines: string[]; n: number } } }>;
    }>;
    expect(out[0].content[0].output.value.lines[0]).toContain('[REDACTED:device-secret]');
    expect(out[0].content[0].output.value.lines[1]).toBe('ok');
    expect(out[0].content[0].output.value.n).toBe(2);
  });

  test('user 与 system 消息原样保留（不消毒）', async () => {
    const secretText = 'my key is sk-abcdefABCDEF0123456789xyz keep it';
    const prompt = [
      { role: 'system', content: 'you are an agent. token ghp_0123456789abcdefghijABCDEFGHIJ0123' },
      { role: 'user', content: [{ type: 'text', text: secretText }] },
    ];
    const out = (await transform(prompt)) as Array<{ role: string; content: unknown }>;
    expect(out[0].content).toContain('ghp_0123456789abcdefghijABCDEFGHIJ0123');
    expect((out[1].content as Array<{ text: string }>)[0].text).toBe(secretText);
  });

  test('assistant 内嵌 tool-result 也消毒，但 assistant 文本不动', async () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will reference sk-abcdefABCDEF0123456789xyz literally' },
          {
            type: 'tool-result',
            toolCallId: 'c3',
            toolName: 'web_search',
            output: { type: 'text', value: 'leaked sk-abcdefABCDEF0123456789xyz' },
          },
        ],
      },
    ];
    const out = (await transform(prompt)) as Array<{
      content: Array<{ type: string; text?: string; output?: { value: string } }>;
    }>;
    // assistant 自身文本保留
    expect(out[0].content[0].text).toContain('sk-abcdefABCDEF0123456789xyz');
    // 工具结果被消毒
    expect(out[0].content[1].output?.value).toBe('leaked [REDACTED:token]');
  });

  test('specificationVersion 为 v3', () => {
    expect(mw.specificationVersion).toBe('v3');
  });
});
