import { describe, expect, test } from 'bun:test';
import {
  KEY_SEQUENCES,
  SEND_INPUT_KEYS,
  type TerminalRuntimeLike,
  createTerminalTools,
  encodeKeysToSequence,
} from './terminal';

interface StubRuntimeOptions {
  screen?: string;
  captureError?: Error;
  paneInfoError?: Error;
  cols?: number;
  rows?: number;
}

function createStubRuntime(options: StubRuntimeOptions = {}) {
  const calls: {
    sendInput: Array<{ paneId: string; data: string }>;
    capture: string[];
    paneInfo: string[];
  } = {
    sendInput: [],
    capture: [],
    paneInfo: [],
  };
  const runtime: TerminalRuntimeLike = {
    sendInput(paneId, data) {
      calls.sendInput.push({ paneId, data });
    },
    async capturePaneText(paneId) {
      calls.capture.push(paneId);
      if (options.captureError) {
        throw options.captureError;
      }
      return options.screen ?? 'line1\nline2\nline3';
    },
    async getPaneInfo(paneId) {
      calls.paneInfo.push(paneId);
      if (options.paneInfoError) {
        throw options.paneInfoError;
      }
      return {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cursorX: 3,
        cursorY: 5,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };
  return { runtime, calls };
}

interface ToolHarness {
  failures: number;
  successes: number;
  tools: ReturnType<typeof createTerminalTools>;
}

function createHarness(runtime: TerminalRuntimeLike | null, needsApproval = false): ToolHarness {
  const harness: ToolHarness = {
    failures: 0,
    successes: 0,
    tools: {},
  };
  harness.tools = createTerminalTools({
    paneId: '%1',
    getRuntime: () => runtime,
    needsApprovalForWrite: needsApproval,
    onFailure: () => {
      harness.failures += 1;
    },
    onSuccess: () => {
      harness.successes += 1;
    },
    sleepMs: async () => {},
  });
  return harness;
}

type ExecutableTool = {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
  needsApproval?: unknown;
};

function getTool(harness: ToolHarness, name: string): ExecutableTool {
  const tool = harness.tools[name] as unknown as ExecutableTool;
  expect(tool).toBeDefined();
  return tool;
}

const execOptions = { toolCallId: 'call-1', messages: [] };

describe('terminal tools - keys 映射', () => {
  test('所有 key 枚举均有映射且为预期字节序列', () => {
    expect(Object.keys(KEY_SEQUENCES).sort()).toEqual([...SEND_INPUT_KEYS].sort());
    expect(KEY_SEQUENCES.enter).toBe('\r');
    expect(KEY_SEQUENCES.tab).toBe('\t');
    expect(KEY_SEQUENCES.escape).toBe('\x1b');
    expect(KEY_SEQUENCES.backspace).toBe('\x7f');
    expect(KEY_SEQUENCES.up).toBe('\x1b[A');
    expect(KEY_SEQUENCES.down).toBe('\x1b[B');
    expect(KEY_SEQUENCES.right).toBe('\x1b[C');
    expect(KEY_SEQUENCES.left).toBe('\x1b[D');
    expect(KEY_SEQUENCES.ctrl_c).toBe('\x03');
    expect(KEY_SEQUENCES.ctrl_d).toBe('\x04');
    expect(KEY_SEQUENCES.ctrl_z).toBe('\x1a');
    expect(KEY_SEQUENCES.ctrl_l).toBe('\x0c');
    expect(KEY_SEQUENCES.ctrl_u).toBe('\x15');
  });

  test('encodeKeysToSequence 按顺序拼接', () => {
    expect(encodeKeysToSequence(['ctrl_c', 'enter'])).toBe('\x03\r');
    expect(encodeKeysToSequence([])).toBe('');
  });
});

describe('terminal tools - send_input', () => {
  test('text + keys 拼接后写入 pane 并回读屏幕尾部', async () => {
    const { runtime, calls } = createStubRuntime({
      screen: Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n'),
    });
    const harness = createHarness(runtime);

    const result = (await getTool(harness, 'send_input').execute(
      { text: 'ls', keys: ['enter'] },
      execOptions
    )) as { screenTail: string; cols: number | null; rows: number | null };

    expect(calls.sendInput).toEqual([{ paneId: '%1', data: 'ls\r' }]);
    expect(calls.capture).toEqual(['%1']);
    // 屏幕尾部被不可信标记包裹：标记行 + 15 行正文 + 结束标记行
    expect(result.screenTail).toContain('UNTRUSTED TERMINAL SCREEN');
    expect(result.screenTail).toContain('END UNTRUSTED TERMINAL SCREEN');
    const inner = result.screenTail.split('\n').slice(1, -1);
    expect(inner.length).toBe(15);
    expect(inner[inner.length - 1]).toBe('line30');
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
    expect(harness.successes).toBe(1);
    expect(harness.failures).toBe(0);
  });

  test('writeMode=confirm 时 needsApproval 返回 true', async () => {
    const { runtime } = createStubRuntime();
    const confirmed = createHarness(runtime, true);
    const auto = createHarness(runtime, false);

    const confirmTool = getTool(confirmed, 'send_input');
    const autoTool = getTool(auto, 'send_input');
    expect(typeof confirmTool.needsApproval).toBe('function');
    expect(await (confirmTool.needsApproval as () => Promise<boolean> | boolean)()).toBe(true);
    expect(await (autoTool.needsApproval as () => Promise<boolean> | boolean)()).toBe(false);
  });

  test('capture 抛错时返回错误文本并计入失败', async () => {
    const { runtime } = createStubRuntime({ captureError: new Error('connection lost') });
    const harness = createHarness(runtime);

    const result = (await getTool(harness, 'send_input').execute(
      { text: 'ls', keys: ['enter'] },
      execOptions
    )) as { error: string };

    expect(result.error).toContain('connection lost');
    expect(harness.failures).toBe(1);
    expect(harness.successes).toBe(0);
  });

  test('runtime 不可用时返回错误文本', async () => {
    const harness = createHarness(null);
    const result = (await getTool(harness, 'send_input').execute(
      { keys: ['enter'] },
      execOptions
    )) as { error: string };
    expect(result.error).toContain('not available');
    expect(harness.failures).toBe(1);
  });
});

describe('terminal tools - read_screen', () => {
  test('返回屏幕内容与时间戳', async () => {
    const { runtime, calls } = createStubRuntime({ screen: 'hello world' });
    const harness = createHarness(runtime);

    const result = (await getTool(harness, 'read_screen').execute(
      { historyLines: 100 },
      execOptions
    )) as { screen: string; cols: number | null; rows: number | null; capturedAt: string };

    expect(result.screen).toContain('hello world');
    expect(result.screen).toContain('UNTRUSTED TERMINAL SCREEN');
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
    expect(typeof result.capturedAt).toBe('string');
    expect(calls.capture).toEqual(['%1']);
    expect(calls.paneInfo).toEqual(['%1']);
    expect(harness.successes).toBe(1);
  });

  test('getPaneInfo 失败不影响读屏（尺寸降级为 null）', async () => {
    const { runtime } = createStubRuntime({
      screen: 'hello',
      paneInfoError: new Error('size unavailable'),
    });
    const harness = createHarness(runtime);
    const result = (await getTool(harness, 'read_screen').execute({}, execOptions)) as {
      screen: string;
      cols: number | null;
      rows: number | null;
    };
    expect(result.screen).toContain('hello');
    expect(result.cols).toBeNull();
    expect(result.rows).toBeNull();
    expect(harness.successes).toBe(1);
    expect(harness.failures).toBe(0);
  });

  test('capture 抛错时返回错误文本并计入失败', async () => {
    const { runtime } = createStubRuntime({ captureError: new Error('pane not found') });
    const harness = createHarness(runtime);

    const result = (await getTool(harness, 'read_screen').execute({}, execOptions)) as {
      error: string;
    };
    expect(result.error).toContain('pane not found');
    expect(harness.failures).toBe(1);
  });

  test('成功后重置失败计数（onSuccess 回调触发）', async () => {
    let screenError: Error | null = new Error('flaky');
    const runtime: TerminalRuntimeLike = {
      sendInput() {},
      async capturePaneText() {
        if (screenError) {
          throw screenError;
        }
        return 'recovered';
      },
      async getPaneInfo() {
        return {
          cols: 80,
          rows: 24,
          cursorX: 0,
          cursorY: 0,
          alternateScreen: false,
          currentCommand: 'bash',
        };
      },
    };
    const harness = createHarness(runtime);
    const tool = getTool(harness, 'read_screen');

    await tool.execute({}, execOptions);
    expect(harness.failures).toBe(1);

    screenError = null;
    await tool.execute({}, execOptions);
    expect(harness.successes).toBe(1);
  });
});

describe('terminal tools - get_pane_info', () => {
  test('返回尺寸/光标/alternate/当前命令与时间戳', async () => {
    const { runtime, calls } = createStubRuntime({ cols: 120, rows: 40 });
    const harness = createHarness(runtime);

    const result = (await getTool(harness, 'get_pane_info').execute({}, execOptions)) as {
      cols: number;
      rows: number;
      cursorX: number | null;
      alternateScreen: boolean;
      currentCommand: string | null;
      capturedAt: string;
    };

    expect(result.cols).toBe(120);
    expect(result.rows).toBe(40);
    expect(result.cursorX).toBe(3);
    expect(result.alternateScreen).toBe(false);
    expect(result.currentCommand).toBe('bash');
    expect(typeof result.capturedAt).toBe('string');
    expect(calls.paneInfo).toEqual(['%1']);
    expect(harness.successes).toBe(1);
  });

  test('getPaneInfo 抛错时返回错误文本并计入失败', async () => {
    const { runtime } = createStubRuntime({ paneInfoError: new Error('pane gone') });
    const harness = createHarness(runtime);
    const result = (await getTool(harness, 'get_pane_info').execute({}, execOptions)) as {
      error: string;
    };
    expect(result.error).toContain('pane gone');
    expect(harness.failures).toBe(1);
  });

  test('runtime 不可用时返回错误文本', async () => {
    const harness = createHarness(null);
    const result = (await getTool(harness, 'get_pane_info').execute({}, execOptions)) as {
      error: string;
    };
    expect(result.error).toContain('not available');
    expect(harness.failures).toBe(1);
  });
});
