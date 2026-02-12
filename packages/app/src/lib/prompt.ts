import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export interface PromptContext {
  nonInteractive: boolean;
}

export async function promptText(
  ctx: PromptContext,
  message: string,
  defaultValue?: string
): Promise<string> {
  if (ctx.nonInteractive) {
    return defaultValue ?? '';
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue !== undefined ? ` (${defaultValue})` : '';
    const answer = (await rl.question(`${message}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function promptConfirm(
  ctx: PromptContext,
  message: string,
  defaultValue: boolean
): Promise<boolean> {
  if (ctx.nonInteractive) {
    return defaultValue;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${message} [${hint}]: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }

    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;

    return defaultValue;
  } finally {
    rl.close();
  }
}
