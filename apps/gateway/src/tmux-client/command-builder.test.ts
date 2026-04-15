import { describe, expect, test } from 'bun:test';

import { joinShellArgs, quoteShellArg } from './command-builder';

describe('command builder', () => {
  test('quotes shell argument with spaces and metacharacters', () => {
    expect(quoteShellArg(`a b;'c"$d`)).toBe(`'a b;'\\''c"$d'`);
  });

  test('joins argv into a shell-safe command line', () => {
    expect(joinShellArgs(['tmux', 'new-session', '-s', 'dev session'])).toBe(
      `'tmux' 'new-session' '-s' 'dev session'`
    );
  });

  test('supports nested sh -c command quoting by reusing quoteShellArg on the inner command', () => {
    const redirectCommand = 'cat > /tmp/tmex/device 1/panes/%1.fifo';
    const wrapped = joinShellArgs(['/bin/sh', '-c', quoteShellArg(redirectCommand)]);

    expect(wrapped).toBe(`'/bin/sh' '-c' ''\\''cat > /tmp/tmex/device 1/panes/%1.fifo'\\'''`);
  });
});
