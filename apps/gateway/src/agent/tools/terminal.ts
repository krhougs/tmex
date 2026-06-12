// 终端工具：read_screen / send_input
// pane 绑定取自 session（不作为工具参数，防模型越界写别的 pane）。
// 工具失败不 throw（错误以结果文本返回给模型），但通过 onFailure 回调参与 run 级 fail-fast 计数。

import { type Tool, tool } from 'ai';
import { z } from 'zod';

export interface TerminalRuntimeLike {
  sendInput(paneId: string, data: string): void;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
}

export const SEND_INPUT_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'up',
  'down',
  'left',
  'right',
  'ctrl_c',
  'ctrl_d',
  'ctrl_z',
  'ctrl_l',
  'ctrl_u',
] as const;

export type SendInputKey = (typeof SEND_INPUT_KEYS)[number];

export const KEY_SEQUENCES: Record<SendInputKey, string> = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_z: '\x1a',
  ctrl_l: '\x0c',
  ctrl_u: '\x15',
};

export function encodeKeysToSequence(keys: readonly SendInputKey[]): string {
  return keys.map((key) => KEY_SEQUENCES[key]).join('');
}

const SEND_INPUT_SETTLE_MS = 300;
const SEND_INPUT_TAIL_LINES = 15;
const SEND_INPUT_TEXT_MAX_CHARS = 16384;

export interface CreateTerminalToolsOptions {
  paneId: string;
  getRuntime: () => TerminalRuntimeLike | null;
  needsApprovalForWrite: boolean;
  onFailure: () => void;
  onSuccess: () => void;
  sleepMs?: (ms: number) => Promise<void>;
}

interface TerminalToolError {
  error: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

export function createTerminalTools(options: CreateTerminalToolsOptions): Record<string, Tool> {
  const sleepMs = options.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const fail = (message: string): TerminalToolError => {
    options.onFailure();
    return { error: message };
  };

  const readScreen = tool({
    description:
      'Read the current visible content of the bound tmux pane. Optionally include scrollback history lines above the visible screen.',
    inputSchema: z.object({
      historyLines: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe(
          'Number of scrollback history lines to include above the visible screen (0-2000, default 0).'
        ),
    }),
    execute: async ({ historyLines }) => {
      const runtime = options.getRuntime();
      if (!runtime) {
        return fail('Terminal connection is not available.');
      }
      try {
        const screen = await runtime.capturePaneText(options.paneId, {
          historyLines: historyLines ?? 0,
        });
        options.onSuccess();
        return { screen, capturedAt: new Date().toISOString() };
      } catch (error) {
        return fail(`Failed to read pane screen: ${toErrorMessage(error)}`);
      }
    },
  });

  const sendInput = tool({
    description:
      'Send input to the bound tmux pane. Use `text` for literal text and `keys` for special keys/control sequences. After sending, the tail of the screen is returned so you can verify the effect.',
    inputSchema: z
      .object({
        text: z
          .string()
          .max(SEND_INPUT_TEXT_MAX_CHARS)
          .optional()
          .describe('Literal text to type into the pane.'),
        keys: z
          .array(z.enum(SEND_INPUT_KEYS))
          .optional()
          .describe('Special keys to send after the text, in order (e.g. ["enter"]).'),
      })
      .refine((value) => Boolean(value.text?.length) || Boolean(value.keys?.length), {
        message: 'Either text or keys must be provided.',
      }),
    needsApproval: () => options.needsApprovalForWrite,
    execute: async ({ text, keys }) => {
      const runtime = options.getRuntime();
      if (!runtime) {
        return fail('Terminal connection is not available.');
      }
      try {
        const data = (text ?? '') + encodeKeysToSequence(keys ?? []);
        runtime.sendInput(options.paneId, data);
        await sleepMs(SEND_INPUT_SETTLE_MS);
        const screen = await runtime.capturePaneText(options.paneId, { historyLines: 0 });
        options.onSuccess();
        return {
          screenTail: tailLines(screen, SEND_INPUT_TAIL_LINES),
          capturedAt: new Date().toISOString(),
        };
      } catch (error) {
        return fail(`Failed to send input to pane: ${toErrorMessage(error)}`);
      }
    },
  });

  return {
    read_screen: readScreen,
    send_input: sendInput,
  };
}
