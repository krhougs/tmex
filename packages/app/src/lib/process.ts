import { spawn } from 'node:child_process';

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
  /** 超时（毫秒）。超时后强杀子进程并 reject，用于避免探测类命令在非交互环境挂起。 */
  timeoutMs?: number;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const stdio = options.stdio ?? 'pipe';

  return await new Promise<RunCommandResult>((resolve, reject) => {
    // stdio 为 pipe 时把 stdin 接到 /dev/null，避免子进程（如交互式 shell）等待输入而挂起。
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : stdio,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      fn();
    };

    if (stdio === 'pipe') {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() =>
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`))
        );
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() =>
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        })
      );
    });
  });
}
