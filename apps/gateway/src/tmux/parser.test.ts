import { describe, expect, test } from 'bun:test';
import { decodeTmuxEscapedValue, TmuxControlParser } from './parser';

describe('decodeTmuxEscapedValue', () => {
  test('decodes octal escapes', () => {
    const decoded = decodeTmuxEscapedValue('hello\\012world');
    expect(new TextDecoder().decode(decoded)).toBe('hello\nworld');
  });

  test('decodes backslash escape', () => {
    const decoded = decodeTmuxEscapedValue('a\\134b');
    expect(new TextDecoder().decode(decoded)).toBe('a\\b');
  });
});

describe('TmuxControlParser', () => {
  test('captures output blocks via %begin/%end', () => {
    const blocks: string[][] = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onOutputBlock: (block) => blocks.push(block.lines),
    });

    parser.processData('%begin 1 2 0\nline1\nline2\n%end 1 2 0\n');

    expect(blocks).toEqual([['line1', 'line2']]);
  });

  test('captures output blocks when wrapped in DCS and terminated by ST', () => {
    const blocks: string[][] = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onOutputBlock: (block) => blocks.push(block.lines),
    });

    parser.processData(`\u001bP1000p%begin 1 2 0\nline1\n\u001bP1000p%end 1 2 0\u001b\\\n`);

    expect(blocks).toEqual([['line1']]);
  });

  test('captures output blocks with C1 ST terminator', () => {
    const blocks: string[][] = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onOutputBlock: (block) => blocks.push(block.lines),
    });

    parser.processData(`\u001bP1000p%begin 1 2 0\nline1\n\u001bP1000p%end 1 2 0\u009c\n`);

    expect(blocks).toEqual([['line1']]);
  });

  test('preserves carriage return inside output block line', () => {
    const blocks: string[][] = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onOutputBlock: (block) => blocks.push(block.lines),
    });

    parser.processData('%begin 1 2 0\nline\rkeep\n%end 1 2 0\n');

    expect(blocks).toEqual([['line\rkeep']]);
  });

  test('handles CRLF terminated control line', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\012\r\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\n' }]);
  });

  test('emits terminal output for %output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\n' }]);
  });

  test('emits terminal output for %output with ST terminator', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData(`\u001bP1000p%output %1 hi\\012\u001b\\\n`);

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\n' }]);
  });

  test('emits exit reason for %exit', () => {
    const reasons: Array<string | null> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onExit: (reason) => reasons.push(reason),
    });

    parser.processData('%exit not attached\n');

    expect(reasons).toEqual(['not attached']);
  });
});
