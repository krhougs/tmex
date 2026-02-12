import type { ParsedArgs } from '../types';

export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | null = null;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      if (command === null) {
        command = token;
      } else {
        positionals.push(token);
      }
      continue;
    }

    const noPrefix = token.slice(2);
    const equalIndex = noPrefix.indexOf('=');

    if (equalIndex >= 0) {
      const key = noPrefix.slice(0, equalIndex);
      const value = noPrefix.slice(equalIndex + 1);
      flags[key] = value;
      continue;
    }

    const maybeNext = argv[index + 1];
    if (maybeNext && !maybeNext.startsWith('--')) {
      flags[noPrefix] = maybeNext;
      index += 1;
      continue;
    }

    flags[noPrefix] = true;
  }

  return {
    command,
    flags,
    positionals,
  };
}
