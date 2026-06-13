import { describe, expect, test } from 'bun:test';
import type { PromptMarker } from '../../tmux-client/pane-stream-parser';
import {
  type RunCommandEmulator,
  cleanTerminalText,
  executeRunCommand,
} from './run-command';

const enc = new TextEncoder();

function createFakeEmu(initial = { alt: false, screen: 'user@host:~$ ' }) {
  let onBytes: ((d: Uint8Array) => void) | undefined;
  let onMarker: ((m: PromptMarker) => void) | undefined;
  let alt = initial.alt;
  let screen = initial.screen;
  const emu: RunCommandEmulator = {
    isAlternateScreen: () => alt,
    render: () => screen,
    tap: (t) => {
      onBytes = t.onBytes;
      onMarker = t.onMarker;
      return () => {
        onBytes = undefined;
        onMarker = undefined;
      };
    },
  };
  return {
    emu,
    emit: (text: string) => onBytes?.(enc.encode(text)),
    marker: (m: PromptMarker) => onMarker?.(m),
    setAlt: (v: boolean) => {
      alt = v;
    },
    setScreen: (s: string) => {
      screen = s;
    },
  };
}

function nonceOf(data: string): string | null {
  const m = /tmex=([^\\;'"\s]+)/.exec(data);
  return m ? m[1] : null;
}

describe('cleanTerminalText', () => {
  test('剥 ANSI + 处理 \\r 覆盖', () => {
    expect(cleanTerminalText('\x1b[31mRED\x1b[0m')).toBe('RED');
    expect(cleanTerminalText('AAAAA\rBB')).toBe('BB');
    expect(cleanTerminalText('line1\nline2  ')).toBe('line1\nline2');
  });
});

describe('executeRunCommand', () => {
  test('POSIX：OSC133 nonce 标记 → 完整输出 + 退出码，剥掉命令回显', async () => {
    const fake = createFakeEmu();
    const sent: string[] = [];
    const promise = executeRunCommand(
      { command: 'ls -la', mode: 'posix', shell: 'bash' },
      {
        emulator: fake.emu,
        sendInput: (data) => {
          sent.push(data);
          const nonce = nonceOf(data);
          // 模拟：回显输入行 + 命令输出，然后 shell 发 D 标记
          setTimeout(() => {
            fake.emit('ls -la; printf ...\r\n'); // 输入行回显
            fake.emit('total 8\r\ndrwxr-xr-x 2 u u 4096 file\r\n');
            fake.marker({ kind: 'D', exitCode: 0, params: ['0', `tmex=${nonce}`] });
          }, 5);
        },
      }
    );
    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('total 8');
    expect(result.output).toContain('drwxr-xr-x');
    expect(result.output).not.toContain('printf'); // 回显行被剥
    expect(sent[0]).toContain('ls -la;');
    expect(sent[0]).toContain('133;D');
  });

  test('POSIX：非零退出码', async () => {
    const fake = createFakeEmu();
    const result = await executeRunCommand(
      { command: 'false', mode: 'posix', shell: 'bash' },
      {
        emulator: fake.emu,
        sendInput: (data) => {
          const nonce = nonceOf(data);
          setTimeout(() => {
            fake.emit('false; printf ...\r\n');
            fake.marker({ kind: 'D', exitCode: 1, params: ['1', `tmex=${nonce}`] });
          }, 5);
        },
      }
    );
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
  });

  test('忽略 nonce 不匹配的 D 标记（别人的 shell 集成）', async () => {
    const fake = createFakeEmu();
    const result = await executeRunCommand(
      { command: 'echo hi', mode: 'posix', shell: 'bash', timeoutMs: 800 },
      {
        emulator: fake.emu,
        sendInput: (data) => {
          const nonce = nonceOf(data);
          setTimeout(() => {
            fake.emit('echo hi; printf ...\r\nhi\r\n');
            // 先来一个别的 nonce 的 D（应被忽略）
            fake.marker({ kind: 'D', exitCode: 99, params: ['99', 'tmex=OTHER'] });
            // 再来自己的
            setTimeout(() => {
              fake.marker({ kind: 'D', exitCode: 0, params: ['0', `tmex=${nonce}`] });
            }, 10);
          }, 5);
        },
      }
    );
    expect(result.exitCode).toBe(0);
  });

  test('启动即 alternate 屏 → entered_tui', async () => {
    const fake = createFakeEmu({ alt: true, screen: '' });
    const result = await executeRunCommand(
      { command: 'vim', mode: 'posix', shell: 'bash' },
      { emulator: fake.emu, sendInput: () => {} }
    );
    expect(result.status).toBe('entered_tui');
    expect(result.exitCode).toBeNull();
  });

  test('执行中切 alternate 屏 → entered_tui', async () => {
    const fake = createFakeEmu();
    const result = await executeRunCommand(
      { command: 'vim file', mode: 'posix', shell: 'bash', timeoutMs: 2000 },
      {
        emulator: fake.emu,
        sendInput: () => {
          setTimeout(() => fake.setAlt(true), 20);
        },
      }
    );
    expect(result.status).toBe('entered_tui');
  });

  test('超时返回已累积 + timeout', async () => {
    const fake = createFakeEmu();
    const result = await executeRunCommand(
      { command: 'sleep 999', mode: 'posix', shell: 'bash', timeoutMs: 300 },
      {
        emulator: fake.emu,
        sendInput: () => {
          setTimeout(() => fake.emit('sleep 999; printf ...\r\npartial\r\n'), 5);
        },
      }
    );
    expect(result.status).toBe('timeout');
    expect(result.output).toContain('partial');
  });

  test('CLI：提示符重现判完成 + 错误启发', async () => {
    const fake = createFakeEmu({ alt: false, screen: 'Switch#' });
    const result = await executeRunCommand(
      { command: 'show run', mode: 'cli', prompt: 'Switch#', timeoutMs: 2000 },
      {
        emulator: fake.emu,
        sendInput: () => {
          setTimeout(() => {
            fake.emit('show run\r\n% Invalid input detected\r\nSwitch#');
            fake.setScreen('Switch#');
          }, 5);
        },
      }
    );
    expect(result.status).toBe('completed');
    expect(result.likelyError).toBe(true);
    expect(result.output).toContain('% Invalid input');
  });

  test('CLI：--More-- 自动续翻', async () => {
    const fake = createFakeEmu({ alt: false, screen: 'R1#' });
    const spaces: number = 0;
    let sentSpace = false;
    const result = await executeRunCommand(
      { command: 'show run', mode: 'cli', prompt: 'R1#', timeoutMs: 2000 },
      {
        emulator: fake.emu,
        sendInput: (data) => {
          if (data === ' ') {
            sentSpace = true;
            setTimeout(() => {
              fake.emit('\r\nmore output\r\nR1#');
              fake.setScreen('R1#');
            }, 5);
            return;
          }
          setTimeout(() => fake.emit('show run\r\nline1\r\n --More-- '), 5);
        },
      }
    );
    expect(sentSpace).toBe(true);
    expect(result.output).toContain('more output');
    void spaces;
  });
});
