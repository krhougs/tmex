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

  test('emits terminal output for %output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\012\n');

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

