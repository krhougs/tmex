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

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\r\n' }]);
  });

  test('emits terminal output for %output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\r\n' }]);
  });

  test('emits terminal output for %output with ST terminator', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData(`\u001bP1000p%output %1 hi\\012\u001b\\\n`);

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\r\n' }]);
  });

  test('deduplicates adjacent same data across %output and %extended-output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 cmd\\012\n');
    parser.processData('%extended-output %1 0 : cmd\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'cmd\r\n' }]);
  });

  test('deduplicates adjacent same data across %extended-output and %output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%extended-output %1 0 : cmd\\012\n');
    parser.processData('%output %1 cmd\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'cmd\r\n' }]);
  });

  test('does not drop different data across %output and %extended-output', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\012\n');
    parser.processData('%extended-output %1 0 : zsh:\\040command\\040not\\040found\\072\\040111\\012\n');

    expect(outputs).toEqual([
      { paneId: '%1', text: 'hi\r\n' },
      { paneId: '%1', text: 'zsh: command not found: 111\r\n' },
    ]);
  });

  test('keeps forwarding when output mode remains the same', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 one\\012\n');
    parser.processData('%output %1 two\\012\n');

    expect(outputs).toEqual([
      { paneId: '%1', text: 'one\r\n' },
      { paneId: '%1', text: 'two\r\n' },
    ]);
  });

  test('flush resets output mode lock', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 first\\012\n');
    parser.processData('%extended-output %1 0 : ignored\\012\n');
    parser.flush();
    parser.processData('%extended-output %1 0 : second\\012\n');

    expect(outputs).toEqual([
      { paneId: '%1', text: 'first\r\n' },
      { paneId: '%1', text: 'ignored\r\n' },
      { paneId: '%1', text: 'second\r\n' },
    ]);
  });

  test('keeps existing CRLF without duplicating CR', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\015\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'hi\r\n' }]);
  });

  test('does not duplicate CR when LF arrives in next chunk', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
    });

    parser.processData('%output %1 hi\\015\n');
    parser.processData('%output %1 \\012\n');

    expect(outputs).toEqual([
      { paneId: '%1', text: 'hi\r' },
      { paneId: '%1', text: '\n' },
    ]);
  });

  test('strips screen title sequence and reports pane title', () => {
    const outputs: Array<{ paneId: string; text: string }> = [];
    const titles: Array<{ paneId: string; title: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: (paneId, data) => outputs.push({ paneId, text: new TextDecoder().decode(data) }),
      onPaneTitle: (paneId, title) => titles.push({ paneId, title }),
    });

    parser.processData('%output %1 hello\\033kmy-pane\\033\\134\\012\n');

    expect(outputs).toEqual([{ paneId: '%1', text: 'hello\r\n' }]);
    expect(titles).toEqual([{ paneId: '%1', title: 'my-pane' }]);
  });

  test('parses pane title sequence across chunks', () => {
    const titles: Array<{ paneId: string; title: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onPaneTitle: (paneId, title) => titles.push({ paneId, title }),
    });

    parser.processData('%output %1 \\033kpane\n');
    parser.processData('%output %1 -name\\033\\134\\012\n');

    expect(titles).toEqual([{ paneId: '%1', title: 'pane-name' }]);
  });

  test('keeps title parse state isolated by pane id', () => {
    const titles: Array<{ paneId: string; title: string }> = [];
    const parser = new TmuxControlParser({
      onEvent: () => {},
      onTerminalOutput: () => {},
      onPaneTitle: (paneId, title) => titles.push({ paneId, title }),
    });

    parser.processData('%output %1 \\033kleft\n');
    parser.processData('%output %2 \\033kright\\033\\134\\012\n');
    parser.processData('%output %1 -pane\\033\\134\\012\n');

    expect(titles).toEqual([
      { paneId: '%2', title: 'right' },
      { paneId: '%1', title: 'left-pane' },
    ]);
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
